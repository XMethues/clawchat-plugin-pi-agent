import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import type { InboundMediaOptions } from "../src/inbound-media.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";
import { ChatSessionRegistry } from "../src/session-registry.js";
import type { ClawchatInboundMessage, MediaFragment } from "../src/types.js";

const tempDirs: string[] = [];
const SOURCE_BYTES = Uint8Array.from(Buffer.from("private original attachment", "utf8"));

type RemoveFn = (
  path: string,
  options: { recursive: boolean; force: boolean }
) => Promise<void>;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("inbound media Turn lifecycle", () => {
  it.each([
    { outcome: "successful", modelError: undefined },
    { outcome: "failed", modelError: "model failed" }
  ])("keeps originals through a $outcome Pi prompt and releases them before settling the Turn", async ({ modelError }) => {
    let rootDir = "";
    const errors: string[] = [];
    const prompt = vi.fn(async () => {
      expect(await leaseEntries(rootDir)).not.toEqual([]);
      if (modelError) throw new Error(modelError);
    });
    const fixture = await openFactory({ prompt });
    rootDir = fixture.mediaRoot;
    const message = mediaMessage(`prompt-${modelError ?? "success"}`, [file("source")]);
    fixture.store.admitInbound({
      dedupeKey: `message:${message.payload.message_id}`,
      messageId: message.payload.message_id,
      chatId: message.chat_id,
      frame: message,
      dispatch: true
    });
    const registry = new ChatSessionRegistry({
      store: fixture.store,
      factory: fixture.factory,
      reply: async () => undefined,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error))
    });

    await registry.wake(message.chat_id);

    expect(prompt).toHaveBeenCalledOnce();
    expect(await leaseEntries(fixture.mediaRoot)).toEqual([]);
    expect(errors).toEqual(modelError ? [modelError] : []);
    expect(fixture.store.getStatus().sessions).toEqual([
      expect.objectContaining({ queuedWork: 0, runningWork: 0 })
    ]);
    await registry.shutdown();
    fixture.store.close();

    const reopened = GatewayStore.open(fixture.storePath);
    expect(reopened.recoverAfterRestart()).toEqual({ interruptedWorkIds: [] });
    expect(reopened.claimNextWork(message.chat_id)).toBeNull();
    reopened.close();
  });

  it("does not create a lease when every download fails", async () => {
    const removeFn = vi.fn<Parameters<RemoveFn>, ReturnType<RemoveFn>>();
    const fixture = await openFactory({
      fetchFn: vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch,
      removeFn
    });
    const driver = await openDriver(fixture);

    try {
      await expect(driver.runTurn(mediaTurn("all-downloads-failed", [file("missing")]))).resolves.toBeUndefined();
      expect(await leaseEntries(fixture.mediaRoot)).toEqual([]);
      expect(removeFn).not.toHaveBeenCalled();
    } finally {
      await driver.dispose();
      fixture.store.close();
    }
  });

  it("aborts stalled materialization but waits for its active Turn and lease cleanup", async () => {
    const stalledDownloadStarted = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const allowCleanup = Promise.withResolvers<void>();
    let request = 0;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request += 1;
      if (request === 1) {
        return new Response(SOURCE_BYTES, { headers: { "content-type": "application/octet-stream" } });
      }
      stalledDownloadStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const removeFn = vi.fn<Parameters<RemoveFn>, ReturnType<RemoveFn>>(async (path, options) => {
      cleanupStarted.resolve();
      await allowCleanup.promise;
      await rm(path, options);
    });
    const fixture = await openFactory({ fetchFn, removeFn });
    const driver = await openDriver(fixture);
    const running = driver.runTurn(mediaTurn("abort-download", [file("saved"), file("stalled")]));

    try {
      await stalledDownloadStarted.promise;
      expect(await leaseEntries(fixture.mediaRoot)).not.toEqual([]);

      let abortSettled = false;
      const aborting = driver.abort!().then(() => {
        abortSettled = true;
      });
      await cleanupStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abortSettled).toBe(false);
      expect(await leaseEntries(fixture.mediaRoot)).not.toEqual([]);
      allowCleanup.resolve();
      await aborting;
      await expect(running).rejects.toThrow("materialization was aborted");
      expect(await leaseEntries(fixture.mediaRoot)).toEqual([]);
    } finally {
      allowCleanup.resolve();
      await running.catch(() => undefined);
      await driver.dispose();
      fixture.store.close();
    }
  });

  it("disposes during an active prompt by aborting and awaiting the Turn before disposing Pi", async () => {
    const promptStarted = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const allowCleanup = Promise.withResolvers<void>();
    const order: string[] = [];
    const abort = vi.fn(async () => {
      order.push("abort");
      finishPrompt.resolve();
    });
    const dispose = vi.fn(() => {
      order.push("dispose");
    });
    const removeFn = vi.fn<Parameters<RemoveFn>, ReturnType<RemoveFn>>(async (path, options) => {
      order.push("cleanup");
      cleanupStarted.resolve();
      await allowCleanup.promise;
      await rm(path, options);
    });
    const fixture = await openFactory({
      prompt: vi.fn(async () => {
        promptStarted.resolve();
        await finishPrompt.promise;
      }),
      abort,
      dispose,
      removeFn
    });
    const driver = await openDriver(fixture);
    const running = driver.runTurn(mediaTurn("dispose-prompt", [file("active")]));

    try {
      await promptStarted.promise;
      expect(await leaseEntries(fixture.mediaRoot)).not.toEqual([]);

      let disposeSettled = false;
      const disposing = driver.dispose().then(() => {
        disposeSettled = true;
      });
      await cleanupStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abort).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      expect(disposeSettled).toBe(false);
      allowCleanup.resolve();
      await disposing;
      await running;

      expect(order).toEqual(["abort", "cleanup", "dispose"]);
      expect(await leaseEntries(fixture.mediaRoot)).toEqual([]);
    } finally {
      finishPrompt.resolve();
      allowCleanup.resolve();
      await running.catch(() => undefined);
      if (!dispose.mock.calls.length) await driver.dispose().catch(() => undefined);
      fixture.store.close();
    }
  });

  it("retries a failed lease deletion and settles only after a real deletion", async () => {
    let attempts = 0;
    const removeFn = vi.fn<Parameters<RemoveFn>, ReturnType<RemoveFn>>(async (path, options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected deletion failure");
      await rm(path, options);
    });
    const fixture = await openFactory({ removeFn });
    const driver = await openDriver(fixture);

    try {
      await expect(driver.runTurn(mediaTurn("cleanup-retry", [file("retry")])))
        .resolves.toBeUndefined();
      expect(removeFn).toHaveBeenCalledTimes(2);
      expect(await leaseEntries(fixture.mediaRoot)).toEqual([]);
    } finally {
      await driver.dispose();
      fixture.store.close();
    }
  });

  it("rejects after bounded deletion retries and leaves the lease startup-recoverable", async () => {
    const removeFn = vi.fn<Parameters<RemoveFn>, ReturnType<RemoveFn>>(async () => {
      throw new Error("persistent deletion failure");
    });
    const fixture = await openFactory({ removeFn });
    const driver = await openDriver(fixture);

    try {
      await expect(driver.runTurn(mediaTurn("cleanup-exhausted", [file("stale")])))
        .rejects.toThrow("persistent deletion failure");
      expect(removeFn.mock.calls.length).toBeGreaterThan(1);
      expect(removeFn.mock.calls.length).toBeLessThanOrEqual(4);
      expect(await leaseEntries(fixture.mediaRoot)).not.toEqual([]);
    } finally {
      await driver.dispose().catch(() => undefined);
      fixture.store.close();
    }
  });
});

interface FactoryOptions {
  prompt?: (text: string) => Promise<void>;
  abort?: () => Promise<void>;
  dispose?: () => void;
  fetchFn?: typeof fetch;
  removeFn?: RemoveFn;
}
interface FactoryFixture {
  factory: PiChatSessionFactory;
  mediaRoot: string;
  store: GatewayStore;
  storePath: string;
}


async function openFactory(options: FactoryOptions = {}): Promise<FactoryFixture> {
  const parent = await makeTempDir();
  const workspace = join(parent, "workspace");
  const mediaRoot = join(parent, "inbound-media");
  const storePath = join(parent, "gateway.sqlite");
  await mkdir(workspace);
  const store = GatewayStore.open(storePath);
  const media = {
    rootDir: mediaRoot,
    fetchFn:
      options.fetchFn ??
      (vi.fn(async () =>
        new Response(SOURCE_BYTES, {
          headers: { "content-type": "application/octet-stream" }
        })) as typeof fetch),
    ...(options.removeFn ? { removeFn: options.removeFn } : {})
  } as InboundMediaOptions & { removeFn?: RemoveFn };
  const factory = new PiChatSessionFactory({
    workspace,
    agentDir: parent,
    sessionDir: join(parent, "sessions"),
    media,
    createAgentSessionFn: async () => ({
      session: {
        prompt: options.prompt ?? (async () => undefined),
        sendCustomMessage: async () => undefined,
        abort: options.abort ?? (async () => undefined),
        dispose: options.dispose ?? (() => undefined)
      }
    }),
    store,
    transport: { send: async () => undefined }
  });
  return { factory, mediaRoot, store, storePath };
}

async function openDriver(fixture: FactoryFixture) {
  const created = fixture.factory.createSession("chat-1");
  return fixture.factory.openSession({ chatId: "chat-1", ...created });
}

function mediaTurn(id: string, fragments: MediaFragment[]) {
  return {
    id,
    chatId: "chat-1",
    messageId: `message-${id}`,
    status: "running" as const,
    frame: mediaMessage(id, fragments)
  };
}

function mediaMessage(id: string, fragments: MediaFragment[]): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: `trace-${id}`,
    emitted_at: 1,
    chat_id: "chat-1",
    chat_type: "direct",
    sender: { id: "user-1", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: `message-${id}`,
      message: { body: { fragments } }
    }
  };
}

function file(id: string): MediaFragment {
  return {
    kind: "file",
    url: `https://media.clawling.com/private/${id}`,
    name: `${id}.bin`,
    mime: "application/octet-stream"
  };
}

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clawchat-inbound-media-lifecycle-"));
  tempDirs.push(path);
  return path;
}

async function leaseEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
