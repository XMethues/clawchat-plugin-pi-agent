import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { ClawchatMemoryStore, clawchatMemoryTarget } from "../src/clawchat-memory.js";
import type { ClawchatToolEnvironment } from "../src/clawchat-tools.js";
import { GatewayStore } from "../src/gateway-store.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";

describe("PiChatSessionFactory", () => {
  it("creates isolated native Pi session paths in the Host Profile Workspace", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const sessionDir = join(agentDir, "sessions");
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });

    const first = factory.createSession("chat-1");
    const second = factory.createSession("chat-2");

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(first.sessionPath.startsWith(sessionDir)).toBe(true);
    expect(second.sessionPath.endsWith(".jsonl")).toBe(true);
    store.close();
  });

  it("opens and disposes an embedded Pi SDK runtime for a mapped chat", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");

    const driver = await factory.openSession({ chatId: "chat-1", ...created });

    await expect(driver.dispose()).resolves.toBeUndefined();
    store.close();
  });

  it("recovers an unmaterialized Pi session with the same session ID after restart", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    const sessionDir = join(agentDir, "sessions");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const firstFactory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });
    const original = store.ensureConversationSessionSet("chat-1", () => firstFactory.createSession("chat-1"));
    const restartedFactory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });

    const driver = await restartedFactory.openSession(original);

    const recovered = store.getActiveChatSession("chat-1");
    expect(recovered?.sessionId).toBe(original.sessionId);
    expect(recovered?.sessionPath).toContain(original.sessionId);
    await driver.dispose();
    store.close();
  });

  it("materializes current-group identity and members from the first group WebSocket Turn", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const memory = new ClawchatMemoryStore(join(agentDir, "memory"));
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/v1/conversations/group-1");
      return {
        conversation: {
          id: "group-1",
          type: "group",
          title: "ZPR8",
          participants: [
            { user_id: "owner-1" },
            { user_id: "agent-user-1" },
            { user_id: "member-2" }
          ]
        }
      };
    });
    const prompt = vi.fn(async () => {
      const currentGroup = await memory.read(clawchatMemoryTarget("group", "group-1"));
      expect(currentGroup.exists).toBe(true);
      expect(currentGroup.metadata).toMatchObject({
        group_id: "group-1",
        group_type: "group",
        group_title: "ZPR8",
        participant_ids: "owner-1,agent-user-1,member-2"
      });
    });
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: {
        memory,
        api: { get },
        profile: () => ({})
      } as unknown as ClawchatToolEnvironment,
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("group-1");
    const driver = await factory.openSession({ chatId: "group-1", ...created });

    try {
      await expect(driver.runTurn(groupTurn("turn-group"))).resolves.toBeUndefined();
      await expect(driver.runTurn(groupTurn("turn-group-later"))).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledTimes(2);
    } finally {
      await driver.dispose();
      store.close();
    }
  });

  it("retries group enrichment when a partial detail has no participant IDs", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const memory = new ClawchatMemoryStore(join(agentDir, "memory"));
    let request = 0;
    const get = vi.fn(async () => {
      request += 1;
      return {
        conversation: {
          id: "group-1",
          type: "group",
          title: "ZPR8",
          participants:
            request === 1
              ? []
              : [{ user_id: "owner-1" }, { user_id: "agent-user-1" }]
        }
      };
    });
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      createAgentSessionFn: async () => ({
        session: {
          prompt: async () => undefined,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: {
        memory,
        api: { get },
        profile: () => ({})
      } as unknown as ClawchatToolEnvironment,
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("group-1");
    const driver = await factory.openSession({ chatId: "group-1", ...created });

    try {
      await driver.runTurn(groupTurn("turn-group-partial"));
      await driver.runTurn(groupTurn("turn-group-complete"));
      expect(get).toHaveBeenCalledTimes(2);
      await expect(
        memory.read(clawchatMemoryTarget("group", "group-1"))
      ).resolves.toMatchObject({
        metadata: { participant_ids: "owner-1,agent-user-1" }
      });
    } finally {
      await driver.dispose();
      store.close();
    }
  });

  it("keeps the WebSocket group identity when member enrichment fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const memory = new ClawchatMemoryStore(join(agentDir, "memory"));
    const prompt = vi.fn(async () => {
      await expect(
        memory.read(clawchatMemoryTarget("group", "group-1"))
      ).resolves.toMatchObject({
        exists: true,
        metadata: { group_id: "group-1", group_type: "group" }
      });
    });
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      groupMemoryEnrichmentTimeoutMs: 10,
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: {
        memory,
        api: { get: vi.fn(async () => new Promise<never>(() => undefined)) },
        profile: () => ({})
      } as unknown as ClawchatToolEnvironment,
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("group-1");
    const driver = await factory.openSession({ chatId: "group-1", ...created });

    try {
      await expect(
        Promise.race([
          driver.runTurn(groupTurn("turn-group-offline")),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("group enrichment blocked the Turn")), 100)
          )
        ])
      ).resolves.toBeUndefined();
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      await driver.dispose();
      store.close();
    }
  });

  it("fails the group Turn when its durable WebSocket identity cannot be written", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const memory = new ClawchatMemoryStore(join(agentDir, "memory"));
    vi.spyOn(memory, "mergeMetadataIfChanged").mockRejectedValueOnce(
      new Error("group identity write failed")
    );
    const get = vi.fn();
    const prompt = vi.fn(async () => undefined);
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: {
        memory,
        api: { get },
        profile: () => ({})
      } as unknown as ClawchatToolEnvironment,
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("group-1");
    const driver = await factory.openSession({ chatId: "group-1", ...created });

    try {
      await expect(driver.runTurn(groupTurn("turn-group-write-failure"))).rejects.toThrow(
        "group identity write failed"
      );
      expect(get).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      await driver.dispose();
      store.close();
    }
  });

  it("aborts a group Turn while member enrichment is pending", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const memory = new ClawchatMemoryStore(join(agentDir, "memory"));
    const requestStarted = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    const prompt = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort,
          dispose: () => undefined
        }
      }),
      tools: {
        memory,
        api: {
          get: vi.fn(async () => {
            requestStarted.resolve();
            return response.promise;
          })
        },
        profile: () => ({})
      } as unknown as ClawchatToolEnvironment,
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("group-1");
    const driver = await factory.openSession({ chatId: "group-1", ...created });
    const running = driver.runTurn(groupTurn("turn-group-abort"));

    try {
      await requestStarted.promise;
      if (!driver.abort) throw new Error("Expected abortable Chat Session driver");
      await driver.abort();
      response.resolve({
        conversation: {
          id: "group-1",
          type: "group",
          participants: [{ user_id: "owner-1" }]
        }
      });
      await expect(running).rejects.toThrow("aborted");
      expect(abort).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const currentGroup = await memory.read(clawchatMemoryTarget("group", "group-1"));
      expect(currentGroup.metadata).not.toHaveProperty("participant_ids");
    } finally {
      response.resolve({});
      await running.catch(() => undefined);
      await driver.dispose();
      store.close();
    }
  });

  it("materializes an image-only message when its Turn runs and releases the private source after prompting", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    const mediaRoot = join(agentDir, "private-media");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const promptSettled = Promise.withResolvers<void>();
    const promptStarted = Promise.withResolvers<void>();
    const sourceBytes = Uint8Array.from(Buffer.from(SMALL_PNG_BASE64, "base64"));
    const mediaUrl = "https://media.clawling.com/capabilities/image-secret";
    const fetchFn = vi.fn(async () =>
      new Response(sourceBytes, {
        headers: { "content-type": "image/png" }
      })
    );
    const prompt = vi.fn(async (_text: string, _options?: PromptCaptureOptions) => {
      promptStarted.resolve();
      await promptSettled.promise;
    });
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      media: { rootDir: mediaRoot, fetchFn: fetchFn as typeof fetch },
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");
    const driver = await factory.openSession({ chatId: "chat-1", ...created });
    let running: Promise<void> | undefined;

    try {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await listLeaseEntries(mediaRoot)).toEqual([]);

      running = driver.runTurn(imageTurn("turn-image", mediaUrl));
      await Promise.race([
        promptStarted.promise,
        running.then(() => {
          throw new Error("image Turn settled without prompting Pi");
        })
      ]);

      expect(fetchFn).toHaveBeenCalledOnce();
      const leaseEntries = await listLeaseEntries(mediaRoot);
      const sourceEntry = leaseEntries.find((entry) => entry.endsWith("pixel.png"));
      expect(sourceEntry).toBeDefined();
      expect(dirname(sourceEntry!)).not.toBe(".");
      expect(await readFile(join(mediaRoot, sourceEntry!))).toEqual(Buffer.from(sourceBytes));

      const [promptText, promptOptions] = prompt.mock.calls[0]!;
      expect(promptText).toMatch(/^ClawChat direct message from Alice:\n/);
      expect(promptText).not.toContain(mediaUrl);
      expect(promptOptions?.images).toHaveLength(1);
      expect(promptOptions?.images?.[0]).toMatchObject({ type: "image" });
      expect(isValidEncodedImage(promptOptions?.images?.[0])).toBe(true);
      expect(JSON.stringify(promptOptions?.images)).not.toContain(mediaUrl);

      promptSettled.resolve();
      await running;
      expect(await listLeaseEntries(mediaRoot)).toEqual([]);
    } finally {
      promptSettled.resolve();
      await running?.catch(() => undefined);
      await driver.dispose();
      store.close();
    }
  });

  it("runs a vision image Turn through native Pi and retains derived image history after lease cleanup", async () => {
    const proof = await runNativePiImageTurn(["text", "image"], "turn-native-vision");

    expect(proof.mediaFetch).toHaveBeenCalledOnce();
    expect(proof.providerRequests).toHaveLength(1);
    expect(JSON.stringify(proof.providerRequests[0])).toContain(
      `data:image/png;base64,${SMALL_PNG_BASE64}`
    );
    expect(proof.leaseEntries).toEqual([]);
    expect(proof.persistedImage).toEqual({
      type: "image",
      data: SMALL_PNG_BASE64,
      mimeType: "image/png"
    });
  });

  it("uses Pi's default omission behavior for an image sent to a non-vision model", async () => {
    const proof = await runNativePiImageTurn(["text"], "turn-native-non-vision");
    const providerRequest = JSON.stringify(proof.providerRequests[0]);

    expect(proof.mediaFetch).toHaveBeenCalledOnce();
    expect(proof.providerRequests).toHaveLength(1);
    expect(providerRequest).not.toContain(SMALL_PNG_BASE64);
    expect(providerRequest).not.toContain("data:image/");
    expect(providerRequest).toContain("(image omitted: model does not support images)");
    expect(proof.leaseEntries).toEqual([]);
  });

  it("turns a non-Clawling image URL into a bounded URL-free failure without fetching it", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    const mediaRoot = join(agentDir, "private-media");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const fetchFn = vi.fn(async () => {
      throw new Error("unrelated media URL must not be fetched");
    });
    const prompt = vi.fn(async (_text: string, _options?: PromptCaptureOptions) => undefined);
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      media: { rootDir: mediaRoot, fetchFn: fetchFn as typeof fetch },
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");
    const driver = await factory.openSession({ chatId: "chat-1", ...created });
    const secret = "not-clawling-" + "x".repeat(4_096);
    const mediaUrl = `https://media.example/${secret}`;

    try {
      await expect(driver.runTurn(imageTurn("turn-invalid-url", mediaUrl))).resolves.toBeUndefined();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
      const [promptText, promptOptions] = prompt.mock.calls[0]!;
      expect(promptText).toMatch(/^ClawChat direct message from Alice:\n/);
      expect(promptText.length).toBeLessThan(512);
      expect(promptText).not.toContain("media.example");
      expect(promptText).not.toContain(secret);
      expect(promptOptions?.images ?? []).toEqual([]);
      expect(await listLeaseEntries(mediaRoot)).toEqual([]);
    } finally {
      await driver.dispose();
      store.close();
    }
  });
});

interface CapturedImage {
  type: "image";
  data: string;
  mimeType: string;
}

interface NativePiImageProof {
  mediaFetch: Mock;
  providerRequests: unknown[];
  leaseEntries: string[];
  persistedImage: CapturedImage | undefined;
}

const CONTROLLED_PROVIDER = "clawchat-native-proof";
const CONTROLLED_MODEL = "controlled-chat";
const CONTROLLED_PROVIDER_URL = "https://pi-provider.invalid/v1";

async function runNativePiImageTurn(
  input: Array<"text" | "image">,
  turnId: string
): Promise<NativePiImageProof> {
  const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
  const workspace = join(agentDir, "project");
  const mediaRoot = join(agentDir, "private-media");
  const sessionDir = join(agentDir, "sessions");
  await mkdir(workspace);
  await writeControlledPiConfig(agentDir, input);

  const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
  const sourceBytes = Uint8Array.from(Buffer.from(SMALL_PNG_BASE64, "base64"));
  const mediaFetch = vi.fn(async () =>
    new Response(sourceBytes, {
      headers: { "content-type": "image/png" }
    })
  );
  const providerRequests: unknown[] = [];
  const providerFetch = vi.fn(
    async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const bodyText =
        request instanceof Request
          ? await request.clone().text()
          : await new Response(init?.body).text();
      providerRequests.push(JSON.parse(bodyText));
      return controlledOpenAiCompletion();
    }
  );
  vi.stubGlobal("fetch", providerFetch);

  let driver: Awaited<ReturnType<PiChatSessionFactory["openSession"]>> | undefined;
  try {
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      media: { rootDir: mediaRoot, fetchFn: mediaFetch as typeof fetch },
      tools: minimalTools(agentDir),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");
    driver = await factory.openSession({ chatId: "chat-1", ...created });

    await driver.runTurn(
      imageTurn(turnId, "https://media.clawling.com/native-pi/image-secret")
    );
    const leaseEntries = await listLeaseEntries(mediaRoot);
    const persistedImage = await findPersistedUserImage(created.sessionPath);
    return { mediaFetch, providerRequests, leaseEntries, persistedImage };
  } finally {
    try {
      await driver?.dispose();
    } finally {
      store.close();
      vi.unstubAllGlobals();
    }
  }
}

async function writeControlledPiConfig(
  agentDir: string,
  input: Array<"text" | "image">
): Promise<void> {
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: CONTROLLED_PROVIDER,
      defaultModel: CONTROLLED_MODEL
    })
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [CONTROLLED_PROVIDER]: {
          baseUrl: CONTROLLED_PROVIDER_URL,
          apiKey: "controlled-test-key",
          api: "openai-completions",
          models: [
            {
              id: CONTROLLED_MODEL,
              name: "Controlled Chat",
              reasoning: false,
              input,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_384,
              maxTokens: 1_024
            }
          ]
        }
      }
    })
  );
}

function controlledOpenAiCompletion(): Response {
  const chunks = [
    {
      id: "controlled-response",
      object: "chat.completion.chunk",
      created: 1,
      model: CONTROLLED_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "acknowledged" },
          finish_reason: null
        }
      ]
    },
    {
      id: "controlled-response",
      object: "chat.completion.chunk",
      created: 1,
      model: CONTROLLED_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function findPersistedUserImage(
  sessionPath: string
): Promise<CapturedImage | undefined> {
  const entries: unknown[] = (await readFile(sessionPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "message" ||
      !("message" in entry)
    ) {
      continue;
    }
    const message = entry.message;
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "user" ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const image = message.content.find(isCapturedImage);
    if (image) return image;
  }
  return undefined;
}

function isCapturedImage(value: unknown): value is CapturedImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

interface PromptCaptureOptions {
  images?: CapturedImage[];
}

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function imageTurn(id: string, url: string) {
  return {
    id,
    chatId: "chat-1",
    messageId: `message-${id}`,
    status: "running" as const,
    frame: {
      version: "2",
      event: "message.send",
      trace_id: `trace-${id}`,
      emitted_at: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "user-1", type: "direct", nick_name: "Alice" },
      payload: {
        message_id: `message-${id}`,
        message: {
          body: {
            fragments: [
              { kind: "image", url, name: "pixel.png", mime: "image/png" }
            ]
          }
        }
      }
    }
  };
}

function minimalTools(agentDir: string): ClawchatToolEnvironment {
  return {
    memory: new ClawchatMemoryStore(join(agentDir, "memory")),
    api: {} as never,
    profile: () => ({}) as never
  } as unknown as ClawchatToolEnvironment;
}

function groupTurn(id: string) {
  return {
    id,
    chatId: "group-1",
    messageId: `message-${id}`,
    status: "running" as const,
    frame: {
      version: "2",
      event: "message.send",
      trace_id: `trace-${id}`,
      emitted_at: 1,
      chat_id: "group-1",
      chat_type: "group",
      sender: { id: "owner-1", type: "group", nick_name: "Owner" },
      payload: {
        message_id: `message-${id}`,
        message: {
          body: { fragments: [{ kind: "text", text: "这个群里都有谁" }] }
        }
      }
    }
  };
}

async function listLeaseEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isValidEncodedImage(
  image: NonNullable<PromptCaptureOptions["images"]>[number] | undefined
): boolean {
  if (!image) return false;
  const bytes = Buffer.from(image.data, "base64");
  if (image.mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (image.mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}
