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
        agent: { userId: "agent-user-1", ownerId: "owner-1" }
      },
      { websocketUrl: websocketUrl(server) }
    );
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
      delivery_receipt: true,
      reliable_delivery: true,
      reliable_delivery_v2: true
    });
    await expect(replied).resolves.toBe("ClawChat group dispatch: all.");
    await expect(delivered.promise).resolves.toBe("server-message-1");
    await host.stop();

    const store = GatewayStore.open(join(profiles.profileDirectory("default"), "gateway.sqlite"));
    expect(store.getGroupDispatchMode("group-1")).toBe("all");
    store.close();
    await expect(profiles.getLockStatus("default")).resolves.toEqual({ running: false });
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
