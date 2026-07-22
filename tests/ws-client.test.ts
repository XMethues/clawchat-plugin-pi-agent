import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ClawchatWebSocketClient } from "../src/ws-client.js";

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

describe("ClawchatWebSocketClient", () => {
  it("uses the shared router so mention-mode groups dispatch only structured mentions", async () => {
    const server = await listen();
    let resolveAck!: () => void;
    const acked = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
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
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: {
                ack_mode: "dseq",
                ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          socket.send(JSON.stringify({ version: "2", event: "replay.done", dseq: 1, payload: {} }));
          socket.send(JSON.stringify(groupMessage(2, "msg-without-mention", [])));
          socket.send(JSON.stringify(groupMessage(3, "msg-with-mention", [{ id: "agent-user-1" }])));
        } else if (frame.event === "message.sync_ack" && frame.payload.dseq === 3) {
          resolveAck();
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-ws-client-"));
    const received: string[] = [];
    const client = new ClawchatWebSocketClient({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      gatewayStorePath: join(directory, "gateway.sqlite"),
      queueTurns: false,
      routeInbound: true,
      toolCallsDefault: "off",
      onInboundMessage: async (message) => {
        received.push(message.payload.message_id);
      }
    });

    await client.connect();
    await acked;
    expect(received).toEqual(["msg-with-mention"]);
    await client.close();
  });
});

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

function groupMessage(dseq: number, messageId: string, mentions: Array<{ id: string }>) {
  return {
    version: "2",
    event: "message.send",
    trace_id: `trace-${dseq}`,
    emitted_at: dseq,
    dseq,
    chat_id: "group-1",
    chat_type: "group",
    sender: { id: "human-1", type: "group", nick_name: "Alice" },
    payload: {
      message_id: messageId,
      message: {
        body: { fragments: [{ kind: "text", text: "hello" }] },
        context: { mentions, reply: null }
      }
    }
  };
}
