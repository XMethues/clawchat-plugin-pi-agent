import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayStore, type ChatSessionRecord } from "../src/gateway-store.js";
import {
  ChatSessionRegistry,
  type ChatSessionDriver,
  type ChatSessionFactory
} from "../src/session-registry.js";

describe("ChatSessionRegistry", () => {
  it("serializes turns within one chat while different chats run concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    admit(store, "chat-2", "msg-3");
    const firstChatRelease = deferred<void>();
    const secondChatRelease = deferred<void>();
    const started: string[] = [];
    const disposed: string[] = [];
    const factory: ChatSessionFactory = {
      createSession: (chatId) => ({
        sessionId: `session-${chatId}`,
        sessionPath: `/sessions/${chatId}.jsonl`
      }),
      openSession: vi.fn(async (mapping: ChatSessionRecord): Promise<ChatSessionDriver> => ({
        runTurn: async (turn) => {
          started.push(turn.messageId);
          if (turn.messageId === "msg-1") await firstChatRelease.promise;
          if (turn.messageId === "msg-3") await secondChatRelease.promise;
        },
        dispose: async () => {
          disposed.push(mapping.chatId);
        }
      }))
    };
    const registry = new ChatSessionRegistry({ store, factory });

    const chat1 = registry.wake("chat-1");
    const chat2 = registry.wake("chat-2");
    await waitFor(() => started.includes("msg-1") && started.includes("msg-3"));
    expect(started).not.toContain("msg-2");

    firstChatRelease.resolve();
    await waitFor(() => started.includes("msg-2"));
    secondChatRelease.resolve();
    await Promise.all([chat1, chat2]);
    expect(started).toEqual(["msg-1", "msg-3", "msg-2"]);

    await registry.shutdown();
    expect(disposed.sort()).toEqual(["chat-1", "chat-2"]);
    store.close();
  });

  it("marks a failed Pi turn interrupted and continues with later queued work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    const attempted: string[] = [];
    const errors: string[] = [];
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async () => ({
          runTurn: async (turn) => {
            attempted.push(turn.messageId);
            if (turn.messageId === "msg-1") throw new Error("model failed");
          },
          dispose: async () => undefined
        })
      },
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error))
    });

    await registry.wake("chat-1");

    expect(attempted).toEqual(["msg-1", "msg-2"]);
    expect(errors).toEqual(["model failed"]);
    expect(store.getStatus().sessions[0]).toMatchObject({ queuedTurns: 0, runningTurns: 0 });
    await registry.shutdown();
    store.close();
  });

  it("recovers never-started queued turns without replaying an interrupted turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const path = join(directory, "gateway.sqlite");
    const beforeRestart = GatewayStore.open(path);
    const running = beforeRestart.admitInbound({
      dedupeKey: "message:msg-running",
      messageId: "msg-running",
      chatId: "chat-1",
      frame: { chat_id: "chat-1" },
      dispatch: true
    });
    beforeRestart.claimNextTurn("chat-1");
    admit(beforeRestart, "chat-2", "msg-queued");
    beforeRestart.close();
    const store = GatewayStore.open(path);
    const attempted: string[] = [];
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async () => ({
          runTurn: async (turn) => {
            attempted.push(turn.messageId);
          },
          dispose: async () => undefined
        })
      }
    });

    await expect(registry.start()).resolves.toEqual({ interruptedTurnIds: [running.turnId] });
    await waitFor(() => attempted.includes("msg-queued"));
    expect(attempted).toEqual(["msg-queued"]);
    await registry.shutdown();
    store.close();
  });

  it("returns from startup while recovered queued work continues in the background", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-queued");
    const release = deferred<void>();
    let running = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async () => ({
          runTurn: async () => {
            running = true;
            await release.promise;
          },
          dispose: async () => undefined
        })
      }
    });

    const startup = registry.start();
    await expect(
      Promise.race([
        startup.then(() => "started"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 30))
      ])
    ).resolves.toBe("started");
    await waitFor(() => running);

    release.resolve();
    await registry.shutdown();
    store.close();
  });

  it("interrupts and aborts an active Pi turn after the shutdown grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    const running = deferred<void>();
    let started = false;
    let aborted = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async () => ({
          runTurn: async () => {
            started = true;
            await running.promise;
          },
          abort: async () => {
            aborted = true;
            running.resolve();
          },
          dispose: async () => undefined
        })
      }
    });
    void registry.wake("chat-1");
    await waitFor(() => started);

    await registry.shutdown({ graceMs: 0 });

    expect(aborted).toBe(true);
    expect(store.getStatus().sessions[0]).toMatchObject({ queuedTurns: 0, runningTurns: 0 });
    store.close();
  });
});

function admit(store: GatewayStore, chatId: string, messageId: string): void {
  store.admitInbound({
    dedupeKey: `message:${messageId}`,
    messageId,
    chatId,
    frame: { chat_id: chatId, payload: { message_id: messageId } },
    dispatch: true
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
