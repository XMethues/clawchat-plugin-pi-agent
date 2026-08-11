import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import { HeadlessPiHost } from "../src/headless-host.js";
import { HostProfileRepository } from "../src/host-profile.js";

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
});

describe("HeadlessPiHost", () => {
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
        baseUrl: "https://app.clawling.com",
        accessToken: "access-1",
        ownerChatId: "owner-chat-1",
        agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
      },
      { websocketUrl: websocketUrl(server) }
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

  it.each([
    { caseName: "no owner chat", ownerChatId: undefined },
    { caseName: "no agent id", ownerChatId: "owner-chat-legacy" }
  ])("omits awareness capabilities with $caseName", async ({ ownerChatId }) => {
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
        } else if (frame.event === "message.sync_ack") {
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
        baseUrl: websocketUrl(server).replace(/^ws/, "http"),
        accessToken: "legacy-access",
        ...(ownerChatId ? { ownerChatId } : {}),
        agent: { userId: "agent-user-legacy", ownerId: "owner-legacy" }
      },
      { websocketUrl: websocketUrl(server) }
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
