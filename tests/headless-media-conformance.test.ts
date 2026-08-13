import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import { HeadlessPiHost } from "../src/headless-host.js";
import { HostProfileRepository } from "../src/host-profile.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const ACK_EPOCH = "01JXYZ8K3MNPQRSTVWXYZ0MC";
const DEVICE_ID = "clawchat-pi-device-media-conformance";
const AGENT_USER_ID = "agent-user-media-conformance";
const DIRECT_CHAT_ID = "chat-direct-media-conformance";
const GROUP_CHAT_ID = "group-media-conformance";
const MUTED_CHAT_ID = "group-muted-media-conformance";
const DIRECT_FIRST_ID = "message-direct-image";
const DIRECT_SECOND_ID = "message-direct-generic";
const GROUP_DISPATCH_ID = "message-group-generic";

const URLS = {
  directImage: "https://media.clawling.com/private/conformance-image",
  directGeneric: "https://media.clawling.com/private/conformance-direct-binary",
  groupGeneric: "https://media.clawling.com/private/conformance-group-binary",
  rejectedMention: "https://media.clawling.com/private/must-not-fetch-non-mention",
  rejectedMuted: "https://media.clawling.com/private/must-not-fetch-muted"
} as const;

const SMALL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  )
);

const servers: WebSocketServer[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })
  );
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("real Headless Host inbound media conformance", () => {
  it("acknowledges durable admission before fetch and keeps dispatched media private and isolated", async () => {
    const server = await listen();
    const agentDir = await temporaryDirectory();
    const workspace = join(agentDir, "workspace");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir, createDeviceId: () => DEVICE_ID });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "media-conformance-access",
        agent: {
          id: "agent-media-conformance",
          userId: AGENT_USER_ID,
          ownerId: "owner-media-conformance"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );

    const profileDirectory = profiles.profileDirectory("default");
    const gatewayPath = join(profileDirectory, "gateway.sqlite");
    const mediaRoot = join(profileDirectory, "inbound-media");
    const initialStore = GatewayStore.open(gatewayPath);
    initialStore.setGroupDispatchMode(MUTED_CHAT_ID, "muted");
    initialStore.close();

    const firstStarted = Promise.withResolvers<void>();
    const groupStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const groupRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const allAcknowledged = Promise.withResolvers<void>();
    const secondConnectionReady = Promise.withResolvers<void>();
    const replyObserved = {
      "DIRECT-IMAGE": Promise.withResolvers<void>(),
      "GROUP-DISPATCH": Promise.withResolvers<void>(),
      "DIRECT-SECOND": Promise.withResolvers<void>()
    };
    const statuses: string[] = [];
    const outboundFrames: Record<string, any>[] = [];
    const prompts: Array<{
      label: string;
      sessionPath: string;
      text: string;
      images: Array<{ type: "image"; data: string; mimeType: string }>;
    }> = [];
    const disposedSessionPaths: string[] = [];
    const fetchUrls: string[] = [];
    let acknowledgedDseq = 0;
    let firstReliableAckWriteCompleted = false;
    let firstFetchBoundary:
      | { ackWriteCompleted: boolean; persistedFrame: Record<string, unknown> | undefined }
      | undefined;
    let secondPromptHasStarted = false;

    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetchUrls.push(url);
      if (!firstFetchBoundary) {
        const database = new DatabaseSync(gatewayPath);
        const row = database
          .prepare("SELECT frame_json FROM inbound_frames WHERE message_id = ?")
          .get(DIRECT_FIRST_ID) as { frame_json: string } | undefined;
        database.close();
        firstFetchBoundary = {
          ackWriteCompleted: firstReliableAckWriteCompleted,
          persistedFrame: row ? (JSON.parse(row.frame_json) as Record<string, unknown>) : undefined
        };
      }
      if (url === URLS.directImage) {
        return new Response(SMALL_PNG, { headers: { "content-type": "image/png" } });
      }
      if (url === URLS.directGeneric || url === URLS.groupGeneric) {
        return new Response(Uint8Array.from([0, 0xff, 1, 0xfe]), {
          headers: { "content-type": "application/octet-stream" }
        });
      }
      throw new Error(`Unexpected external fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const createAgentSessionFn = async (options: CreateAgentSessionOptions) => {
      if (!options.sessionManager) throw new Error("Expected a Pi session manager");
      const sessionPath = options.sessionManager.getSessionFile();
      if (!sessionPath) throw new Error("Expected a persisted Pi session path");
      return {
        session: {
          prompt: async (
            text: string,
            promptOptions?: {
              images?: Array<{ type: "image"; data: string; mimeType: string }>;
            }
          ) => {
            const label = promptOptions?.images?.length
              ? "DIRECT-IMAGE"
              : text.includes("GROUP-DISPATCH")
                ? "GROUP-DISPATCH"
                : text.includes("DIRECT-SECOND")
                  ? "DIRECT-SECOND"
                  : "UNEXPECTED";
            prompts.push({
              label,
              sessionPath,
              text,
              images: promptOptions?.images ?? []
            });
            if (label === "DIRECT-IMAGE") {
              firstStarted.resolve();
              await firstRelease.promise;
            } else if (label === "GROUP-DISPATCH") {
              groupStarted.resolve();
              await groupRelease.promise;
            } else if (label === "DIRECT-SECOND") {
              secondPromptHasStarted = true;
              secondStarted.resolve();
              await secondRelease.promise;
            } else {
              throw new Error("Unexpected Pi prompt");
            }
            await emitLoadedExtension(options, {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `fixture reply ${label}` }]
              }
            });
            await emitLoadedExtension(options, { type: "agent_settled" });
          },
          sendCustomMessage: async () => undefined,
          abort: async () => {
            firstRelease.resolve();
            groupRelease.resolve();
            secondRelease.resolve();
          },
          dispose: async () => {
            disposedSessionPaths.push(sessionPath);
          }
        }
      };
    };

    const originalWebSocketSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(
      function (
        this: WebSocket,
        data: Parameters<typeof originalWebSocketSend>[0],
        optionsOrCallback?:
          | Parameters<typeof originalWebSocketSend>[1]
          | ((error?: Error) => void),
        callback?: (error?: Error) => void
      ) {
        let isFirstReliableAck = false;
        if (typeof data === "string") {
          const frame = JSON.parse(data) as Record<string, any>;
          isFirstReliableAck =
            frame.event === "message.sync_ack" && Number(frame.payload?.dseq) === 1;
        }

        const sendCallback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        const completionCallback =
          isFirstReliableAck && sendCallback
            ? (error?: Error) => {
                if (!error) firstReliableAckWriteCompleted = true;
                sendCallback(error);
              }
            : sendCallback;

        if (typeof optionsOrCallback === "object") {
          return originalWebSocketSend.call(this, data, optionsOrCallback, completionCallback);
        }
        return Reflect.apply(
          originalWebSocketSend as unknown as (...args: unknown[]) => void,
          this,
          completionCallback ? [data, completionCallback] : [data]
        );
      } as typeof WebSocket.prototype.send
    );

    let connectionNumber = 0;
    server.on("connection", (socket) => {
      connectionNumber += 1;
      const currentConnection = connectionNumber;
      let sentRemainingFrames = false;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-media-${currentConnection}`,
          emitted_at: currentConnection,
          payload: { nonce: `media-conformance-nonce-${currentConnection}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        outboundFrames.push(frame);
        if (frame.event === "connect") {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: {
                ack_mode: "dseq",
                ack_epoch: ACK_EPOCH,
                device_id: DEVICE_ID,
                delivery_mode: "device_replay"
              }
            })
          );
          if (currentConnection === 1) {
            socket.send(JSON.stringify(directImageFrame()));
          } else {
            socket.send(JSON.stringify(replayDone(7, "replay-after-restart")));
            secondConnectionReady.resolve();
          }
          return;
        }
        if (frame.event === "message.sync_ack") {
          acknowledgedDseq = Math.max(acknowledgedDseq, Number(frame.payload?.dseq ?? 0));
          if (currentConnection === 1 && acknowledgedDseq >= 1 && !sentRemainingFrames) {
            sentRemainingFrames = true;
            for (const inbound of remainingFrames()) socket.send(JSON.stringify(inbound));
          }
          if (acknowledgedDseq >= 6) allAcknowledged.resolve();
          return;
        }
        if (frame.event === "message.send" || frame.event === "message.reply") {
          const text = String(frame.payload?.message?.body?.fragments?.[0]?.text ?? "");
          for (const [label, observed] of Object.entries(replyObserved)) {
            if (text.includes(label)) observed.resolve();
          }
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.ack",
              trace_id: frame.trace_id,
              emitted_at: 20,
              chat_id: frame.chat_id,
              payload: { message_id: frame.payload.message_id, accepted_at: 20 }
            })
          );
        }
      });
    });

    const firstHost = new HeadlessPiHost({
      agentDir,
      profiles,
      profileName: "default",
      onStatus: (status) => statuses.push(status),
      createAgentSessionFn
    });
    let secondHost: HeadlessPiHost | undefined;

    try {
      const starting = firstHost.start();
      await Promise.all([firstStarted.promise, groupStarted.promise, allAcknowledged.promise]);
      await starting;

      expect(firstFetchBoundary).toMatchObject({
        ackWriteCompleted: true,
        persistedFrame: {
          event: "message.send",
          dseq: 1,
          payload: {
            message_id: DIRECT_FIRST_ID,
            message: { body: { fragments: [{ kind: "image", url: URLS.directImage }] } }
          }
        }
      });
      expect(secondPromptHasStarted).toBe(false);
      expect(prompts.map(({ label }) => label).sort()).toEqual([
        "DIRECT-IMAGE",
        "GROUP-DISPATCH"
      ]);

      const firstPrompt = prompts.find(({ label }) => label === "DIRECT-IMAGE")!;
      const groupPrompt = prompts.find(({ label }) => label === "GROUP-DISPATCH")!;
      expect(firstPrompt.images).toEqual([
        expect.objectContaining({ type: "image", mimeType: "image/png" })
      ]);
      expect(groupPrompt.text).toContain("GROUP-DISPATCH");
      expect(groupPrompt.text).toMatch(/\[Attachment 2: .*name=group\.bin;.*path=/);
      expect(firstPrompt.sessionPath).not.toBe(groupPrompt.sessionPath);

      const groupAttachmentPath = attachmentPath(groupPrompt.text);
      const firstImagePath = join(
        mediaRoot,
        (await leaseEntries(mediaRoot)).find((entry) => entry.endsWith("direct.png"))!
      );
      await expect(access(firstImagePath)).resolves.toBeUndefined();
      await expect(access(groupAttachmentPath)).resolves.toBeUndefined();

      groupRelease.resolve();
      await replyObserved["GROUP-DISPATCH"].promise;
      await waitForMissing(groupAttachmentPath);
      await expect(access(firstImagePath)).resolves.toBeUndefined();

      firstRelease.resolve();
      await Promise.all([replyObserved["DIRECT-IMAGE"].promise, secondStarted.promise]);
      const secondPrompt = prompts.find(({ label }) => label === "DIRECT-SECOND")!;
      const secondAttachmentPath = attachmentPath(secondPrompt.text);
      expect(secondPrompt.sessionPath).toBe(firstPrompt.sessionPath);
      expect(secondPrompt.text).toContain("DIRECT-SECOND");
      await expect(access(firstImagePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(secondAttachmentPath)).resolves.toBeUndefined();

      const stopping = firstHost.stop();
      secondRelease.resolve();
      await stopping;
      await replyObserved["DIRECT-SECOND"].promise;
      expect(await leaseEntries(mediaRoot)).toEqual([]);
      expect(disposedSessionPaths.sort()).toEqual(
        [firstPrompt.sessionPath, groupPrompt.sessionPath].sort()
      );

      expect(fetchUrls).toEqual([
        URLS.directImage,
        URLS.groupGeneric,
        URLS.directGeneric
      ]);
      expect(fetchUrls).not.toContain(URLS.rejectedMention);
      expect(fetchUrls).not.toContain(URLS.rejectedMuted);
      const promptLabels = prompts.map(({ label }) => label);
      expect([...promptLabels].sort()).toEqual([
        "DIRECT-IMAGE",
        "DIRECT-SECOND",
        "GROUP-DISPATCH"
      ]);
      expect(promptLabels.indexOf("DIRECT-SECOND")).toBeGreaterThan(
        promptLabels.indexOf("DIRECT-IMAGE")
      );

      const replyChats = outboundFrames
        .filter((frame) => frame.event === "message.send" || frame.event === "message.reply")
        .map((frame) => frame.chat_id);
      expect(replyChats).toEqual(expect.arrayContaining([DIRECT_CHAT_ID, GROUP_CHAT_ID]));
      expect(statuses.length).toBeGreaterThan(0);
      const publicObservations = JSON.stringify({ prompts, outboundFrames, statuses });
      for (const url of Object.values(URLS)) expect(publicObservations).not.toContain(url);

      const database = new DatabaseSync(gatewayPath);
      const retainedRows = database
        .prepare(
          "SELECT message_id, disposition, frame_json FROM inbound_frames ORDER BY admitted_at, rowid"
        )
        .all() as Array<{ message_id: string; disposition: string; frame_json: string }>;
      database.close();
      expect(
        retainedRows.find(({ message_id }) => message_id === DIRECT_FIRST_ID)
      ).toMatchObject({ disposition: "queued" });
      expect(
        retainedRows.find(({ message_id }) => message_id === "message-group-non-mention")
      ).toMatchObject({ disposition: "skipped" });
      expect(
        retainedRows.find(({ message_id }) => message_id === "message-group-muted")
      ).toMatchObject({ disposition: "skipped" });
      expect(
        retainedRows.find(({ message_id }) => message_id === DIRECT_FIRST_ID)?.frame_json
      ).toContain(URLS.directImage);

      const persisted = GatewayStore.open(gatewayPath);
      const directMapping = persisted.getChatSession(DIRECT_CHAT_ID);
      const groupMapping = persisted.getChatSession(GROUP_CHAT_ID);
      expect(directMapping?.sessionPath).toBe(firstPrompt.sessionPath);
      expect(groupMapping?.sessionPath).toBe(groupPrompt.sessionPath);
      expect(directMapping?.sessionPath).not.toBe(groupMapping?.sessionPath);
      expect(persisted.listQueuedChatIds()).toEqual([]);
      persisted.close();

      const staleLease = join(mediaRoot, "turn-stale-after-stop");
      await mkdir(staleLease, { recursive: true });
      await writeFile(join(staleLease, "private.bin"), "stale private media");
      secondHost = new HeadlessPiHost({
        agentDir,
        profiles,
        profileName: "default",
        createAgentSessionFn
      });
      const restarting = secondHost.start();
      await secondConnectionReady.promise;
      await restarting;
      expect(await leaseEntries(mediaRoot)).toEqual([]);
      await secondHost.stop();
      await expect(profiles.getLockStatus("default")).resolves.toEqual({ running: false });
    } finally {
      firstRelease.resolve();
      groupRelease.resolve();
      secondRelease.resolve();
      await firstHost.stop().catch(() => undefined);
      await secondHost?.stop().catch(() => undefined);
    }
  });
});

async function emitLoadedExtension(
  options: CreateAgentSessionOptions,
  event: Record<string, unknown>
): Promise<void> {
  if (!options.resourceLoader) throw new Error("Expected the Headless resource loader");
  const extension = options.resourceLoader
    .getExtensions()
    .extensions.find((candidate) => candidate.hidden && candidate.handlers.has(event.type as string));
  if (!extension) throw new Error(`Headless extension has no ${String(event.type)} handler`);
  for (const handler of extension.handlers.get(event.type as string) ?? []) {
    await handler(event as never, undefined as never);
  }
}

function directImageFrame(): Record<string, unknown> {
  return messageFrame({
    dseq: 1,
    traceId: "trace-direct-image",
    chatId: DIRECT_CHAT_ID,
    chatType: "direct",
    messageId: DIRECT_FIRST_ID,
    fragments: [
      { kind: "image", url: URLS.directImage, name: "direct.png", mime: "image/png" }
    ]
  });
}

function remainingFrames(): Record<string, unknown>[] {
  return [
    messageFrame({
      dseq: 2,
      traceId: "trace-group-non-mention",
      chatId: GROUP_CHAT_ID,
      chatType: "group",
      messageId: "message-group-non-mention",
      fragments: [
        {
          kind: "file",
          url: URLS.rejectedMention,
          name: "rejected-non-mention.bin",
          mime: "application/octet-stream"
        }
      ],
      mentions: []
    }),
    messageFrame({
      dseq: 3,
      traceId: "trace-group-muted",
      chatId: MUTED_CHAT_ID,
      chatType: "group",
      messageId: "message-group-muted",
      fragments: [
        {
          kind: "file",
          url: URLS.rejectedMuted,
          name: "rejected-muted.bin",
          mime: "application/octet-stream"
        }
      ],
      mentions: [{ user_id: AGENT_USER_ID }]
    }),
    messageFrame({
      dseq: 4,
      traceId: "trace-direct-second",
      chatId: DIRECT_CHAT_ID,
      chatType: "direct",
      messageId: DIRECT_SECOND_ID,
      fragments: [
        { kind: "text", text: "DIRECT-SECOND" },
        {
          kind: "file",
          url: URLS.directGeneric,
          name: "direct-second.bin",
          mime: "application/octet-stream"
        }
      ]
    }),
    messageFrame({
      dseq: 5,
      traceId: "trace-group-dispatch",
      chatId: GROUP_CHAT_ID,
      chatType: "group",
      messageId: GROUP_DISPATCH_ID,
      fragments: [
        { kind: "text", text: "GROUP-DISPATCH" },
        {
          kind: "file",
          url: URLS.groupGeneric,
          name: "group.bin",
          mime: "application/octet-stream"
        }
      ],
      mentions: [{ user_id: AGENT_USER_ID }]
    }),
    replayDone(6, "replay-media-conformance")
  ];
}

function messageFrame(input: {
  dseq: number;
  traceId: string;
  chatId: string;
  chatType: "direct" | "group";
  messageId: string;
  fragments: Array<Record<string, unknown>>;
  mentions?: Array<{ user_id: string }>;
}): Record<string, unknown> {
  return {
    version: "2",
    event: "message.send",
    trace_id: input.traceId,
    emitted_at: input.dseq + 2,
    dseq: input.dseq,
    chat_id: input.chatId,
    chat_type: input.chatType,
    sender: {
      id: `human-${input.dseq}`,
      type: input.chatType,
      nick_name: `Human ${input.dseq}`
    },
    payload: {
      message_id: input.messageId,
      message: {
        body: { fragments: input.fragments },
        context: { mentions: input.mentions ?? [], reply: null }
      }
    }
  };
}

function replayDone(dseq: number, traceId: string): Record<string, unknown> {
  return {
    version: "2",
    event: "replay.done",
    trace_id: traceId,
    emitted_at: dseq + 2,
    dseq,
    payload: {}
  };
}

function attachmentPath(prompt: string): string {
  const match = prompt.match(/path=([^;\]\n]+)/);
  if (!match?.[1]) throw new Error("Expected a private attachment path in Pi prompt");
  return match[1];
}

async function waitForMissing(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for media cleanup: ${path}`);
}

async function leaseEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-media-conformance-"));
  tempDirectories.push(directory);
  return directory;
}

async function listen(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}

function websocketUrl(server: WebSocketServer): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
  return `ws://127.0.0.1:${address.port}`;
}
