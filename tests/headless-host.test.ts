import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawchatAwarenessCoordinator } from "../src/clawchat-awareness.js";
import { runCli } from "../src/cli.js";
import { GatewayStore } from "../src/gateway-store.js";
import { HeadlessPiHost } from "../src/headless-host.js";
import { HostProfileRepository } from "../src/host-profile.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        })
    )
  );
  vi.restoreAllMocks();
});

describe("HeadlessPiHost", () => {
  it("leases the profile before reading it and releases after startup fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-"));
    const profiles = new HostProfileRepository({ agentDir });
    const loadStarted = Promise.withResolvers<void>();
    const continueLoad = Promise.withResolvers<void>();
    vi.spyOn(profiles, "load").mockImplementation(async () => {
      loadStarted.resolve();
      await continueLoad.promise;
      return null;
    });
    const host = new HeadlessPiHost({ agentDir, profiles });
    const startup = host.start();

    await loadStarted.promise;
    await expect(profiles.acquireOperationLease("default")).rejects.toThrow("active operation");
    continueLoad.resolve();
    await expect(startup).rejects.toThrow("is not activated");

    const operationLease = await profiles.acquireOperationLease("default");
    await operationLease.release();
  });

  it("handles a persisted integration command over the shared profile Gateway", async () => {
    const server = await listen();
    let resolveReply!: (text: string) => void;
    const replied = new Promise<string>((resolve) => {
      resolveReply = resolve;
    });
    const delivered = Promise.withResolvers<string>();
    const connected = Promise.withResolvers<Record<string, unknown>>();
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: "challenge",
          emitted_at: 1,
          payload: { nonce: "challenge-nonce" }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event === "connect") {
          connected.resolve(frame.payload.capabilities);
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(
            JSON.stringify({ version: "2", event: "replay.done", trace_id: "replay", emitted_at: 3, payload: {} })
          );
          socket.send(JSON.stringify(groupCommandFrame()));
        } else if (frame.event === "message.reply") {
          resolveReply(frame.payload.message.body.fragments[0].text);
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.ack",
              trace_id: frame.trace_id,
              emitted_at: 5,
              chat_id: frame.chat_id,
              payload: { message_id: frame.payload.message_id, accepted_at: 5 }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.delivered",
              trace_id: "delivery-1",
              emitted_at: 6,
              chat_id: frame.chat_id,
              payload: { message_id: "server-message-1", delivered_at: 6 }
            })
          );
        }
      });
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://app.clawling.com",
        accessToken: "access-1",
        ownerChatId: "owner-chat-1",
        agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const persistedStore = GatewayStore.open(
      join(profiles.profileDirectory("default"), "gateway.sqlite")
    );
    persistedStore.persistReliableFrame("history:recovery", "history.transit", {
      version: "2",
      event: "history.transit",
      trace_id: "trace-history-recovery",
      emitted_at: 3,
      target_device_id: "clawchat-pi-device-1",
      origin_device_id: "device-old",
      sender: { id: "agent-user-1" },
      payload: {
        kind: "history_sync_message",
        chat_id: "chat-recovered",
        messages: [{ id: "history-message-1", content: "restored", created_at: 2 }]
      }
    });
    persistedStore.close();
    const host = new HeadlessPiHost({
      agentDir,
      profiles,
      profileName: "default",
      onDeliveryReceipt: (event) => delivered.resolve(String(event.payload?.message_id))
    });

    await host.start();
    const activate = vi.fn();
    await expect(
      runCli(["activate", "INVITE-2", "--cwd", workspace], {
        profiles,
        activate,
        write: vi.fn()
      })
    ).rejects.toThrow("active operation");
    expect(activate).not.toHaveBeenCalled();
    await expect(connected.promise).resolves.toEqual({
      multi_device: true,
      device_replay: true,
      chat_meta_events: true,
      notify_signals: true,
      delivery_receipt: true,
      history_sync: true,
      reliable_delivery: true,
      reliable_delivery_v2: true
    });
    await expect(replied).resolves.toBe("ClawChat group dispatch: all.");
    await expect(delivered.promise).resolves.toBe("server-message-1");
    await host.stop();

    const store = GatewayStore.open(join(profiles.profileDirectory("default"), "gateway.sqlite"));
    expect(store.getGroupDispatchMode("group-1")).toBe("all");
    expect(store.listHistoryMessages("chat-recovered")).toEqual([
      { id: "history-message-1", content: "restored", created_at: 2 }
    ]);
    store.close();
    await expect(profiles.getLockStatus("default")).resolves.toEqual({ running: false });
  });

  it("omits awareness capabilities without an owner direct Chat Session", async () => {
    const ownerChatId: string | undefined = undefined;
    const server = await listen();
    const connected = Promise.withResolvers<Record<string, unknown>>();
    const acked = Promise.withResolvers<Record<string, any>>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge-legacy",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event === "connect") {
          connected.resolve(frame.payload.capabilities);
          socket.send(JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: {
              ack_mode: "dseq",
              ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
              device_id: "clawchat-pi-device-legacy",
              delivery_mode: "device_replay"
            }
          }));
          socket.send(JSON.stringify({
            version: "2",
            event: "history.transit",
            trace_id: "history-request-legacy",
            emitted_at: 3,
            dseq: 1,
            target_device_id: "clawchat-pi-device-legacy",
            origin_device_id: "clawchat-pi-device-old",
            sender: { id: "agent-user-legacy" },
            payload: { kind: "history_sync_request" }
          }));
          socket.send(JSON.stringify({
            version: "2",
            event: "replay.done",
            trace_id: "replay-legacy",
            emitted_at: 4,
            dseq: 2,
            payload: {}
          }));
        } else if (
          frame.event === "message.sync_ack" &&
          Number(frame.payload?.dseq ?? 0) >= 2
        ) {
          acked.resolve(frame);
        }
      });
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-legacy-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-legacy"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "legacy-access",
        ...(ownerChatId ? { ownerChatId } : {}),
        agent: {
          id: "agent-legacy",
          userId: "agent-user-legacy",
          ownerId: "owner-legacy"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const host = new HeadlessPiHost({
      agentDir,
      profiles,
      onAwarenessSignal: async () => undefined
    });

    await host.start();
    const capabilities = await connected.promise;
    expect(capabilities).not.toHaveProperty("chat_meta_events");
    expect(capabilities).not.toHaveProperty("notify_signals");
    await expect(acked.promise).resolves.toMatchObject({
      payload: { dseq: 2, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" }
    });
    await host.stop();
  });
  it("dispatches valid group mentions and acknowledges malformed mention data", async () => {
    const server = await listen();
    const acked = Promise.withResolvers<Record<string, any>>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge-mentions",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event === "connect") {
          socket.send(JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: {
              ack_mode: "dseq",
              ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AC",
              device_id: "clawchat-pi-device-mentions",
              delivery_mode: "device_replay"
            }
          }));
          socket.send(JSON.stringify(groupMentionFrame(1, "trace-canonical", [
            { user_id: "agent-user-mentions" }
          ])));
          socket.send(JSON.stringify(groupMentionFrame(2, "trace-legacy", [
            "agent-user-mentions"
          ])));
          socket.send(JSON.stringify(groupMentionFrame(3, "trace-everyone", [
            { user_id: "all" }
          ])));
          socket.send(JSON.stringify(groupMentionFrame(4, "trace-malformed", {
            user_id: "agent-user-mentions"
          })));
          socket.send(JSON.stringify({
            version: "2",
            event: "replay.done",
            trace_id: "replay-mentions",
            emitted_at: 7,
            dseq: 5,
            payload: {}
          }));
        } else if (frame.event === "message.sync_ack" && frame.payload?.dseq === 5) {
          acked.resolve(frame);
        }
      });
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-mentions-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-mentions"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "mention-access",
        ownerChatId: "owner-chat-mentions",
        agent: {
          id: "agent-mentions",
          userId: "agent-user-mentions",
          ownerId: "owner-mentions"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const dispatchedTraceIds: string[] = [];
    const dispatched = Promise.withResolvers<void>();
    vi.spyOn(PiChatSessionFactory.prototype, "createSession").mockImplementation(() => ({
      sessionId: "session-mentions",
      sessionPath: join(agentDir, "session-mentions.jsonl")
    }));
    vi.spyOn(PiChatSessionFactory.prototype, "openSession").mockImplementation(async () => ({
      runTurn: async (turn) => {
        const frame = turn.frame;
        if (!frame || typeof frame !== "object" || !("trace_id" in frame)) {
          throw new Error("Expected dispatched ClawChat frame");
        }
        dispatchedTraceIds.push(String(frame.trace_id));
        if (dispatchedTraceIds.length === 3) dispatched.resolve();
      },
      abort: async () => undefined,
      dispose: async () => undefined
    }));
    const host = new HeadlessPiHost({ agentDir, profiles });

    await host.start();
    await expect(dispatched.promise).resolves.toBeUndefined();
    await expect(acked.promise).resolves.toMatchObject({
      payload: { dseq: 5, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AC" }
    });
    expect(dispatchedTraceIds).toEqual([
      "trace-canonical",
      "trace-legacy",
      "trace-everyone"
    ]);
    await host.stop();
  });

  it("runs reconnect recovery single-flight without blocking Gateway frames and retries", async () => {
    const server = await listen();
    const connectedSocket = Promise.withResolvers<WebSocket>();
    const secondConnectedSocket = Promise.withResolvers<WebSocket>();
    const thirdConnectedSocket = Promise.withResolvers<WebSocket>();
    let connectionCount = 0;
    const replayAcknowledged = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      connectionCount += 1;
      if (connectionCount === 1) connectedSocket.resolve(socket);
      if (connectionCount === 2) secondConnectedSocket.resolve(socket);
      if (connectionCount === 3) thirdConnectedSocket.resolve(socket);
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge-recovery",
        emitted_at: 1,
        payload: { nonce: "recovery-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event === "connect") {
          socket.send(JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: {
              ack_mode: "dseq",
              ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AD",
              device_id: "clawchat-pi-device-recovery",
              delivery_mode: "device_replay"
            }
          }));
        } else if (frame.event === "message.sync_ack" && frame.payload?.dseq === 1) {
          replayAcknowledged.resolve();
        }
      });
    });
    const firstRecovery = Promise.withResolvers<{
      changed: boolean;
      admission: null;
    }>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const retryStarted = Promise.withResolvers<void>();
    const thirdReadyStarted = Promise.withResolvers<void>();
    let recoveryCalls = 0;
    vi.spyOn(ClawchatAwarenessCoordinator.prototype, "recover").mockImplementation(async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        firstStarted.resolve();
        return firstRecovery.promise;
      }
      if (recoveryCalls === 2) {
        secondStarted.resolve();
        throw new Error("controlled metadata outage");
      }
      if (recoveryCalls === 3) {
        retryStarted.resolve();
        return { changed: false, admission: null };
      }
      thirdReadyStarted.resolve();
      return { changed: false, admission: null };
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-recovery-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-recovery"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "recovery-access",
        ownerChatId: "owner-chat-recovery",
        agent: {
          id: "agent-recovery",
          userId: "agent-user-recovery",
          ownerId: "owner-recovery"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const statuses: string[] = [];
    const host = new HeadlessPiHost({
      agentDir,
      profiles,
      onStatus: (status) => statuses.push(status),
      recoveryRetryDelay: () => 0,
      gatewayReconnectDelay: () => 0
    });

    await host.start();
    const socket = await connectedSocket.promise;
    await firstStarted.promise;
    socket.send(JSON.stringify({
      version: "2",
      event: "replay.done",
      trace_id: "replay-recovery",
      emitted_at: 3,
      dseq: 1,
      payload: {}
    }));
    await replayAcknowledged.promise;
    socket.terminate();
    const secondSocket = await secondConnectedSocket.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoveryCalls).toBe(1);

    firstRecovery.resolve({ changed: false, admission: null });
    await secondStarted.promise;
    await retryStarted.promise;
    expect(statuses).toContain(
      "metadata recovery failed; retrying in 0ms: controlled metadata outage"
    );
    secondSocket.terminate();
    await thirdConnectedSocket.promise;
    await thirdReadyStarted.promise;
    expect(recoveryCalls).toBe(4);
    await host.stop();
  });

  it("clears stale inbound media after leasing the profile and before recovered queued work", async () => {
    const server = await listen();
    const gatewayReady = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge-media-recovery",
        emitted_at: 1,
        payload: { nonce: "media-recovery-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        socket.send(JSON.stringify({
          version: "2",
          event: "hello-ok",
          trace_id: frame.trace_id,
          emitted_at: 2,
          payload: {
            device_id: "clawchat-pi-device-media-recovery",
            delivery_mode: "device_replay"
          }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "replay.done",
          trace_id: "replay-media-recovery",
          emitted_at: 3,
          payload: {}
        }));
        gatewayReady.resolve();
      });
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-media-recovery-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-media-recovery"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "media-recovery-access",
        ownerChatId: "owner-chat-media-recovery",
        agent: {
          id: "agent-media-recovery",
          userId: "agent-user-media-recovery",
          ownerId: "owner-media-recovery"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const profileDirectory = profiles.profileDirectory("default");
    const mediaRoot = join(profileDirectory, "inbound-media");
    const staleLease = join(mediaRoot, "turn-stale");
    await mkdir(staleLease, { recursive: true });
    await writeFile(join(staleLease, "original.bin"), "stale original");
    const store = GatewayStore.open(join(profileDirectory, "gateway.sqlite"));
    const queuedFrame = mediaRecoveryFrame();
    store.admitInbound({
      dedupeKey: `message:${queuedFrame.payload.message_id}`,
      messageId: queuedFrame.payload.message_id,
      chatId: queuedFrame.chat_id,
      frame: queuedFrame,
      dispatch: true
    });
    store.close();
    const recoveredWorkObserved = Promise.withResolvers<void>();
    let operationLeaseExcluded = false;
    let residueAtRecoveredTurn: string[] | undefined;
    vi.spyOn(PiChatSessionFactory.prototype, "createSession").mockImplementation(() => ({
      sessionId: "session-media-recovery",
      sessionPath: join(agentDir, "session-media-recovery.jsonl")
    }));
    vi.spyOn(PiChatSessionFactory.prototype, "openSession").mockImplementation(async () => ({
      runTurn: async () => {
        try {
          const unexpectedLease = await profiles.acquireOperationLease("default");
          await unexpectedLease.release();
        } catch (error: unknown) {
          operationLeaseExcluded =
            error instanceof Error && error.message.includes("active operation");
        }
        residueAtRecoveredTurn = await inboundMediaEntries(mediaRoot);
        recoveredWorkObserved.resolve();
      },
      abort: async () => undefined,
      dispose: async () => undefined
    }));
    const host = new HeadlessPiHost({ agentDir, profiles });

    try {
      await host.start();
      await gatewayReady.promise;
      await recoveredWorkObserved.promise;
      expect(operationLeaseExcluded).toBe(true);
      expect(residueAtRecoveredTurn).toEqual([]);
    } finally {
      await host.stop();
    }
    expect(await inboundMediaEntries(mediaRoot)).toEqual([]);
    await expect(profiles.getLockStatus("default")).resolves.toEqual({ running: false });
  });

  it("interrupts an active media Pi Turn immediately and disposes only after its lease settles", async () => {
    const server = await listen();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge-stop-active-turn",
        emitted_at: 1,
        payload: { nonce: "stop-active-turn-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        socket.send(JSON.stringify({
          version: "2",
          event: "hello-ok",
          trace_id: frame.trace_id,
          emitted_at: 2,
          payload: {
            device_id: "clawchat-pi-device-stop-active-turn",
            delivery_mode: "device_replay"
          }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "replay.done",
          trace_id: "replay-stop-active-turn",
          emitted_at: 3,
          payload: {}
        }));
      });
    });
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-host-stop-active-turn-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-stop-active-turn"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "stop-active-turn-access",
        ownerChatId: "owner-chat-stop-active-turn",
        agent: {
          id: "agent-stop-active-turn",
          userId: "agent-user-stop-active-turn",
          ownerId: "owner-stop-active-turn"
        }
      },
      {
        websocketUrl: websocketUrl(server),
        mediaUrl: websocketUrl(server).replace(/^ws/, "http")
      }
    );
    const profileDirectory = profiles.profileDirectory("default");
    const mediaRoot = join(profileDirectory, "inbound-media");
    const store = GatewayStore.open(join(profileDirectory, "gateway.sqlite"));
    const queuedFrame = mediaRecoveryFrame();
    store.admitInbound({
      dedupeKey: `message:${queuedFrame.payload.message_id}`,
      messageId: queuedFrame.payload.message_id,
      chatId: queuedFrame.chat_id,
      frame: queuedFrame,
      dispatch: true
    });
    store.close();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url !== queuedFrame.payload.message.body.fragments[0]!.url) {
        throw new Error(`Unexpected external fetch: ${url}`);
      }
      return new Response(Uint8Array.from([0, 1, 2, 3]), {
        headers: { "content-type": "application/octet-stream" }
      });
    });

    const order: string[] = [];
    const promptStarted = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    const abortInspectionFinished = Promise.withResolvers<void>();
    let entriesAtAbort: string[] | undefined;
    let turnSettledAtAbort: boolean | undefined;
    let turnSettled = false;
    let entriesAtDispose: string[] | undefined;
    const acquireOperationLease =
      profiles.acquireOperationLease.bind(profiles);
    vi.spyOn(profiles, "acquireOperationLease").mockImplementation(async (name) => {
      const lease = await acquireOperationLease(name);
      return {
        release: async () => {
          order.push("profile-release");
          await lease.release();
        }
      };
    });
    const host = new HeadlessPiHost({
      agentDir,
      profiles,
      createAgentSessionFn: async () => ({
        session: {
          prompt: async () => {
            order.push("prompt-start");
            promptStarted.resolve();
            await finishPrompt.promise;
            order.push("turn-settled");
            turnSettled = true;
          },
          sendCustomMessage: async () => undefined,
          abort: async () => {
            order.push("abort");
            turnSettledAtAbort = turnSettled;
            try {
              entriesAtAbort = await inboundMediaEntries(mediaRoot);
            } finally {
              abortInspectionFinished.resolve();
              finishPrompt.resolve();
            }
          },
          dispose: async () => {
            entriesAtDispose = await inboundMediaEntries(mediaRoot);
            order.push("dispose");
          }
        }
      })
    });
    let usingFakeTimers = false;
    let stopping: Promise<void> | undefined;

    try {
      await host.start();
      await promptStarted.promise;
      expect(await inboundMediaEntries(mediaRoot)).not.toEqual([]);

      vi.useFakeTimers();
      usingFakeTimers = true;
      stopping = host.stop();
      await vi.advanceTimersByTimeAsync(0);

      expect(turnSettledAtAbort).toBe(false);
      await abortInspectionFinished.promise;
      expect(entriesAtAbort).not.toEqual([]);

      vi.useRealTimers();
      usingFakeTimers = false;
      await stopping;

      expect(await inboundMediaEntries(mediaRoot)).toEqual([]);
      expect(entriesAtDispose).toEqual([]);
      expect(order).toEqual([
        "prompt-start",
        "abort",
        "turn-settled",
        "dispose",
        "profile-release"
      ]);
    } finally {
      finishPrompt.resolve();
      if (usingFakeTimers) {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
      await (stopping ?? host.stop());
    }
  });

});

async function listen(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return server;
}

function websocketUrl(server: WebSocketServer): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
  return `ws://127.0.0.1:${address.port}`;
}

function mediaRecoveryFrame() {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-media-recovery",
    emitted_at: 1,
    chat_id: "chat-media-recovery",
    chat_type: "direct",
    sender: { id: "human-media-recovery", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: "message-media-recovery",
      message: {
        body: {
          fragments: [
            {
              kind: "file",
              url: "https://media.clawling.com/private/recovered-original",
              name: "recovered-original.bin",
              mime: "application/octet-stream"
            }
          ]
        }
      }
    }
  };
}

async function inboundMediaEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function groupCommandFrame(): Record<string, unknown> {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-command",
    emitted_at: 4,
    chat_id: "group-1",
    chat_type: "group",
    sender: { id: "human-1", type: "group", nick_name: "Alice" },
    payload: {
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      message: {
        body: { fragments: [{ kind: "text", text: "/clawchat-group all" }] },
        context: { mentions: [], reply: null }
      }
    }
  };
}

function groupMentionFrame(
  dseq: number,
  traceId: string,
  mentions: unknown
): Record<string, unknown> {
  return {
    version: "2",
    event: "message.send",
    trace_id: traceId,
    emitted_at: dseq + 2,
    dseq,
    chat_id: "group-mentions",
    chat_type: "group",
    sender: { id: "human-mentions", type: "group", nick_name: "Alice" },
    payload: {
      message_id: `msg-mention-${dseq}`,
      message: {
        body: { fragments: [{ kind: "text", text: `mention ${dseq}` }] },
        context: { mentions, reply: null }
      }
    }
  };
}
