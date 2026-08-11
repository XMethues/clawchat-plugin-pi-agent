import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawChatGateway } from "../src/gateway.js";
import { GatewayStore } from "../src/gateway-store.js";

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

describe("ClawChatGateway", () => {
  it("connects with the stable device and only implemented capabilities", async () => {
    const server = await listen();
    let resolveConnect!: (frame: Record<string, any>) => void;
    const connected = new Promise<Record<string, any>>((resolve) => {
      resolveConnect = resolve;
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
        if (frame.event !== "connect") return;
        resolveConnect(frame);
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
          })
        );
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: false
    });

    await gateway.start();
    const frame = await connected;
    expect(frame.payload).toEqual({
      token: "access-1",
      nonce: "challenge-nonce",
      device_id: "clawchat-pi-device-1",
      capabilities: {
        multi_device: true,
        device_replay: true,
        reliable_delivery: true,
        reliable_delivery_v2: true
      }
    });
    await gateway.stop();
    store.close();
  });

  it("acks a dense v2 delivery only after durable admission", async () => {
    const server = await listen();
    let resolveAck!: (frame: Record<string, any>) => void;
    const acked = new Promise<Record<string, any>>((resolve) => {
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
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay",
                ack_mode: "dseq",
                ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB"
              }
            })
          );
          socket.send(JSON.stringify(inboundFrame({ dseq: 1 })));
        } else if (frame.event === "message.sync_ack") {
          resolveAck(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const received: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async (message) => {
        received.push(message.payload.message_id);
      },
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    const ack = await acked;
    expect(ack.payload).toEqual({ dseq: 1, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" });
    expect(received).toEqual(["msg-01HVB6S7K8L9M0N1P2Q3R4S5T6"]);
    expect(store.claimNextTurn("chat-1")).toMatchObject({ messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6" });
    await gateway.stop();
    store.close();
  });

  it("retries materialized output through a durable outbox until message.ack", async () => {
    const server = await listen();
    let resolveReply!: (frame: Record<string, any>) => void;
    const replied = new Promise<Record<string, any>>((resolve) => {
      resolveReply = resolve;
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
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(
            JSON.stringify({ version: "2", event: "replay.done", trace_id: "replay", emitted_at: 3, payload: {} })
          );
        } else if (frame.event === "message.reply") {
          resolveReply(frame);
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.ack",
              trace_id: frame.trace_id,
              emitted_at: 4,
              chat_id: frame.chat_id,
              payload: { message_id: frame.payload.message_id, accepted_at: 4 }
            })
          );
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: false,
      now: () => 1_776_162_600_000
    });

    await gateway.start();
    await gateway.send(outboundReply());
    const frame = await replied;
    expect(frame.payload.message_id).toMatch(/^msg-[0-9A-HJ-NP-Z]{26}$/);
    expect(store.listPendingOutbound()).toHaveLength(1);
    await waitFor(() => store.listPendingOutbound().length === 0);
    await gateway.stop();
    store.close();
  });

  it("reconnects and resends an unacknowledged reply with the same message_id", async () => {
    const server = await listen();
    const messageIds: string[] = [];
    let connectionNumber = 0;
    let resolveAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    server.on("connection", (socket) => {
      connectionNumber += 1;
      const thisConnection = connectionNumber;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: "challenge",
          emitted_at: 1,
          payload: { nonce: `challenge-${thisConnection}` }
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
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(
            JSON.stringify({ version: "2", event: "replay.done", trace_id: "replay", emitted_at: 3, payload: {} })
          );
        } else if (frame.event === "message.reply") {
          messageIds.push(frame.payload.message_id);
          if (thisConnection === 1) {
            socket.close();
          } else {
            socket.send(
              JSON.stringify({
                version: "2",
                event: "message.ack",
                trace_id: frame.trace_id,
                emitted_at: 4,
                chat_id: frame.chat_id,
                payload: { message_id: frame.payload.message_id, accepted_at: 4 }
              })
            );
            resolveAccepted();
          }
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await gateway.start();
    await gateway.send(outboundReply());
    await accepted;
    await waitFor(() => store.listPendingOutbound().length === 0);
    expect(messageIds).toHaveLength(2);
    expect(messageIds[1]).toBe(messageIds[0]);
    await gateway.stop();
    store.close();
  });

  it("quarantines an invalid dseq frame and continues the dense acknowledgement", async () => {
    const server = await listen();
    let resolveFinalAck!: (frame: Record<string, any>) => void;
    const finalAck = new Promise<Record<string, any>>((resolve) => {
      resolveFinalAck = resolve;
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
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.send",
              trace_id: "poison",
              emitted_at: 3,
              dseq: 1,
              chat_id: "chat-1",
              payload: { message_id: "msg-broken" }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "sync.mark",
              trace_id: "mark",
              emitted_at: 4,
              dseq: 2,
              payload: { covers_seq: 10 }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "replay.done",
              trace_id: "replay",
              emitted_at: 5,
              dseq: 3,
              payload: {}
            })
          );
        } else if (frame.event === "message.sync_ack" && frame.payload.dseq === 3) {
          resolveFinalAck(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    await expect(finalAck).resolves.toMatchObject({
      payload: { dseq: 3, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" }
    });
    expect(store.getStatus().quarantinedFrames).toBe(1);
    await gateway.stop();
    store.close();
  });

  it("periodically resends the v2 high-water acknowledgement on an idle connection", async () => {
    const server = await listen();
    let ackCount = 0;
    let resolveRepeatedAck!: () => void;
    const repeatedAck = new Promise<void>((resolve) => {
      resolveRepeatedAck = resolve;
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
          socket.send(JSON.stringify(inboundFrame({ dseq: 1 })));
        } else if (frame.event === "message.sync_ack") {
          ackCount += 1;
          if (ackCount === 2) resolveRepeatedAck();
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      ackDebounceMs: 0,
      ackHeartbeatMs: 20,
      reconnect: false
    });

    await gateway.start();
    await repeatedAck;
    expect(ackCount).toBe(2);
    await gateway.stop();
    store.close();
  });

  it("treats v1 storage seq as a sparse opaque high-water mark", async () => {
    const server = await listen();
    let resolveAck!: (frame: Record<string, any>) => void;
    const acked = new Promise<Record<string, any>>((resolve) => {
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
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(JSON.stringify(inboundFrame({ seq: 7 })));
          socket.send(
            JSON.stringify(
              inboundFrame({
                seq: 42,
                trace_id: "trace-in-2",
                payload: {
                  message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T7",
                  message: {
                    body: { fragments: [{ kind: "text", text: "second" }] },
                    context: { mentions: [], reply: null }
                  }
                }
              })
            )
          );
        } else if (frame.event === "message.cursor_ack" && frame.payload.seq === 42) {
          resolveAck(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    await expect(acked).resolves.toMatchObject({ payload: { seq: 42 } });
    const first = store.claimNextTurn("chat-1");
    expect(first).toMatchObject({ messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6" });
    store.completeTurn(first!.id);
    expect(store.claimNextTurn("chat-1")).toMatchObject({
      messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T7"
    });
    await gateway.stop();
    store.close();
  });

  it("disconnects when a v2 delivery sequence has a gap", async () => {
    const server = await listen();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    server.on("connection", (socket) => {
      socket.on("close", resolveClosed);
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
        if (frame.event !== "connect") return;
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
        socket.send(JSON.stringify(inboundFrame({ dseq: 2 })));
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const statuses: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onStatus: (status) => statuses.push(status),
      reconnect: false
    });

    await gateway.start();
    await closed;
    expect(statuses).toContain("protocol error: expected dseq 1, received 2");
    expect(store.listQueuedChatIds()).toEqual([]);
    await gateway.stop();
    store.close();
  });

  it("marks a terminal message.error failed instead of retrying forever", async () => {
    const server = await listen();
    let resolveRejected!: () => void;
    const rejected = new Promise<void>((resolve) => {
      resolveRejected = resolve;
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
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(
            JSON.stringify({ version: "2", event: "replay.done", trace_id: "replay", emitted_at: 3, payload: {} })
          );
        } else if (frame.event === "message.reply") {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "message.error",
              trace_id: frame.trace_id,
              emitted_at: 4,
              chat_id: frame.chat_id,
              payload: {
                message_id: frame.payload.message_id,
                code: "chat_not_found",
                reason: "chat not found",
                rejected_at: 4
              }
            })
          );
          resolveRejected();
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: false
    });

    await gateway.start();
    await gateway.send(outboundReply());
    await rejected;
    await waitFor(() => store.getStatus().failedOutbound === 1);
    expect(store.listPendingOutbound()).toEqual([]);
    await gateway.stop();
    store.close();
  });

  it("retries a transient remote-auth hello failure with the same profile token", async () => {
    const server = await listen();
    let connectionNumber = 0;
    server.on("connection", (socket) => {
      connectionNumber += 1;
      const thisConnection = connectionNumber;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: "challenge",
          emitted_at: 1,
          payload: { nonce: `challenge-${thisConnection}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        if (thisConnection === 1) {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-fail",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: { reason: "remote auth service unavailable" }
            })
          );
          socket.close();
        } else {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 3,
              payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
            })
          );
          socket.send(
            JSON.stringify({ version: "2", event: "replay.done", trace_id: "replay", emitted_at: 4, payload: {} })
          );
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await gateway.start();
    expect(connectionNumber).toBe(2);
    await gateway.stop();
    store.close();
  });

  it("reconnects when the socket closes before hello-ok without an authentication failure", async () => {
    const server = await listen();
    let connectionNumber = 0;
    server.on("connection", (socket) => {
      connectionNumber += 1;
      const current = connectionNumber;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${current}`,
          emitted_at: 1,
          payload: { nonce: `challenge-${current}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        if (current === 1) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
          })
        );
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await gateway.start();
    expect(connectionNumber).toBe(2);
    await gateway.stop();
    store.close();
  });

  it("refreshes an authentication failure once and treats the repeated failure as terminal", async () => {
    const server = await listen();
    const tokens: string[] = [];
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: `challenge-${connections}`,
        emitted_at: 1,
        payload: { nonce: `nonce-${connections}` }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        tokens.push(frame.payload.token);
        socket.send(JSON.stringify({
          version: "2",
          event: "hello-fail",
          trace_id: frame.trace_id,
          emitted_at: 2,
          payload: { reason: "authentication failed" }
        }));
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const refreshAccessToken = vi.fn(async () => "access-2");
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      refreshAccessToken,
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await expect(gateway.start()).rejects.toThrow("authentication failed");
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(connections).toBe(2);
    expect(tokens).toEqual(["access-1", "access-2"]);
    await gateway.stop();
    store.close();
  });

  it("closes a connection that never completes the handshake", async () => {
    const server = await listen();
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      handshakeTimeoutMs: 20,
      reconnect: false
    });

    await expect(gateway.start()).rejects.toThrow("handshake timed out");
    await gateway.stop();
    store.close();
  });
});

async function listen(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return server;
}

function websocketUrl(server: WebSocketServer): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
  return `ws://127.0.0.1:${address.port}`;
}

function inboundFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-in-1",
    emitted_at: 3,
    chat_id: "chat-1",
    chat_type: "direct",
    sender: { id: "human-1", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      message: {
        body: { fragments: [{ kind: "text", text: "hello" }] },
        context: { mentions: [], reply: null }
      }
    },
    ...extra
  };
}

function outboundReply(): Record<string, unknown> {
  return {
    version: "2",
    event: "message.reply",
    trace_id: "trace-out-1",
    emitted_at: 3,
    chat_id: "chat-1",
    to: { id: "human-1", type: "direct" },
    payload: {
      message_mode: "normal",
      message: {
        body: { fragments: [{ kind: "text", text: "hello back" }] },
        context: { mentions: [], reply: null }
      }
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
