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
      onAwarenessSignal: async () => undefined,
      onHistoryTransit: async () => undefined,
      onDeliveryReceipt: async () => undefined,
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
        chat_meta_events: true,
        delivery_receipt: true,
        notify_signals: true,
        history_sync: true,
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
              payload: { message_id: "msg-01MINTEDBYSERVER000000000", accepted_at: 4 }
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
    expect(frame.payload).not.toHaveProperty("message_id");
    expect(store.listPendingOutbound()).toHaveLength(1);
    await waitFor(() => store.listPendingOutbound().length === 0);
    await gateway.stop();
    store.close();
  });

  it("reconnects and resends an unacknowledged reply with the same trace_id", async () => {
    const server = await listen();
    const replies: Array<Record<string, any>> = [];
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
          replies.push(frame);
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
                payload: { message_id: "msg-01MINTEDBYSERVER000000000", accepted_at: 4 }
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
    expect(replies).toHaveLength(2);
    expect(replies[1]!.trace_id).toBe(replies[0]!.trace_id);
    expect(replies.every((frame) => !("message_id" in frame.payload))).toBe(true);
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
  it("persists history transit before acknowledging its dense delivery sequence", async () => {
    const server = await listen();
    const { promise: acked, resolve: resolveAck } =
      Promise.withResolvers<Record<string, unknown>>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.event === "connect") {
          socket.send(JSON.stringify({
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
          }));
          socket.send(JSON.stringify({
            version: "2",
            event: "history.transit",
            trace_id: "history-1",
            emitted_at: 3,
            dseq: 1,
            target_device_id: "clawchat-pi-device-1",
            origin_device_id: "clawchat-pi-device-2",
            sender: { id: "agent-user-1", type: "direct" },
            payload: { kind: "history_sync_message", messages: [{ body: "prior" }] }
          }));
        } else if (frame.event === "message.sync_ack") {
          resolveAck(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-history-"));
    const databasePath = join(directory, "gateway.sqlite");
    const store = GatewayStore.open(databasePath);
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
    await expect(acked).resolves.toMatchObject({
      payload: { dseq: 1, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" }
    });
    await gateway.stop();
    store.close();

    const reopened = GatewayStore.open(databasePath);
    expect(reopened.listReliableFrames("history.transit")).toEqual([
      expect.objectContaining({ event: "history.transit", trace_id: "history-1" })
    ]);
    reopened.close();
  });

  it("materializes a completed inbound stream once and drops failed streams", async () => {
    const server = await listen();
    const partials = Promise.withResolvers<void>();
    const finalize = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", async (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.event !== "connect") return;
        socket.send(JSON.stringify({
          version: "2",
          event: "hello-ok",
          trace_id: frame.trace_id,
          emitted_at: 2,
          payload: {
            ack_mode: "legacy",
            device_id: "clawchat-pi-device-1",
            delivery_mode: "device_replay"
          }
        }));
        const streamBase = {
          version: "2",
          emitted_at: 3,
          chat_id: "chat-1",
          chat_type: "direct",
          sender: { id: "human-1", type: "direct", nick_name: "Alice" }
        };
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.created",
          trace_id: "stream-created",
          payload: { message_id: "agent-stream-1", message_mode: "normal" }
        }));
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.add",
          trace_id: "stream-add-0",
          payload: {
            message_id: "agent-stream-1",
            sequence: 0,
            mutation: { type: "append", target_fragment_index: 0 },
            fragments: [{ kind: "text", text: "Hel", delta: "Hel" }],
            streaming: { status: "streaming", sequence: 0, mutation_policy: "append_text_only" }
          }
        }));
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.add",
          trace_id: "stream-add-1",
          payload: {
            message_id: "agent-stream-1",
            sequence: 1,
            mutation: { type: "append", target_fragment_index: 0 },
            fragments: [{ kind: "text", text: "Hello", delta: "lo" }],
            streaming: { status: "streaming", sequence: 1, mutation_policy: "append_text_only" }
          }
        }));
        partials.resolve();
        await finalize.promise;
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.done",
          trace_id: "stream-done",
          payload: {
            message_id: "agent-stream-1",
            fragments: [{ kind: "text", text: "Hello" }],
            streaming: { status: "done", sequence: 1, mutation_policy: "append_text_only" }
          }
        }));
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.reply",
          trace_id: "polished-reply",
          payload: {
            message_id: "agent-stream-1",
            message: {
              body: { fragments: [{ kind: "text", text: "Polished Hello" }] },
              context: { mentions: [], reply: null }
            }
          }
        }));
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.created",
          trace_id: "failed-created",
          payload: { message_id: "agent-stream-2", message_mode: "normal" }
        }));
        socket.send(JSON.stringify({
          ...streamBase,
          event: "message.failed",
          trace_id: "failed-final",
          payload: {
            message_id: "agent-stream-2",
            fragments: [{ kind: "text", text: "partial" }],
            streaming: { status: "failed", sequence: 0, mutation_policy: "append_text_only" }
          }
        }), () => socket.close());
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-stream-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const received: Array<Record<string, unknown>> = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async (message) => {
        received.push(message as unknown as Record<string, unknown>);
      },
      reconnect: false,
      onStatus: (status) => {
        if (status === "disconnected") disconnected.resolve();
      }
    });

    await gateway.start();
    await partials.promise;
    expect(received).toEqual([]);
    finalize.resolve();
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      event: "message.send",
      payload: {
        message_id: "agent-stream-1",
        message: { body: { fragments: [{ kind: "text", text: "Hello" }] } }
      }
    });
    await disconnected.promise;
    await gateway.stop();
    expect(received).toHaveLength(1);
    store.close();
  });

  it("flushes the durable outbox after replay becomes idle without replay.done", async () => {
    const server = await listen();
    const received: Array<Record<string, unknown>> = [];
    const lateBoundary = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.event === "connect") {
          socket.send(JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: {
              ack_mode: "legacy",
              device_id: "clawchat-pi-device-1",
              delivery_mode: "device_replay"
            }
          }));
        } else if (frame.event === "message.reply") {
          socket.send(JSON.stringify({
            version: "2",
            event: "replay.done",
            trace_id: "late-replay",
            emitted_at: 3,
            payload: {}
          }));
          setTimeout(() => lateBoundary.resolve(), 10);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-replay-idle-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      replayIdleTimeoutMs: 0,
      reconnect: false
    });
    await gateway.send(outboundReply());

    await gateway.start();
    await waitFor(() => received.some((frame) => frame.event === "message.reply"));
    await lateBoundary.promise;

    expect(received.filter((frame) => frame.event === "message.reply")).toHaveLength(1);
    await gateway.stop();
    store.close();
  });

  it("waits for queued replay processing before the idle fallback flushes outbound", async () => {
    const server = await listen();
    const received: Array<Record<string, unknown>> = [];
    const awarenessStarted = Promise.withResolvers<void>();
    const releaseAwareness = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.event !== "connect") return;
        socket.send(JSON.stringify({
          version: "2",
          event: "hello-ok",
          trace_id: frame.trace_id,
          emitted_at: 2,
          payload: {
            ack_mode: "legacy",
            device_id: "clawchat-pi-device-1",
            delivery_mode: "device_replay"
          }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "notify.signal",
          trace_id: "notify-replay",
          emitted_at: 3,
          payload: {
            type: "friend.added",
            entity_id: "user-2",
            version: 3,
            event_id: "notify-event-1",
            message_id: "notify:friend.added:user-2"
          }
        }));
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-replay-queue-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onAwarenessSignal: async () => {
        awarenessStarted.resolve();
        await releaseAwareness.promise;
      },
      replayIdleTimeoutMs: 5,
      reconnect: false
    });
    await gateway.send(outboundReply());

    await gateway.start();
    await awarenessStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(received.some((frame) => frame.event === "message.reply")).toBe(false);
    releaseAwareness.resolve();
    await waitFor(() => received.some((frame) => frame.event === "message.reply"));

    await gateway.stop();
    store.close();
  });

  it("handles awareness, history, and delivery event families", async () => {
    const server = await listen();
    const clientFrames: Array<Record<string, any>> = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        clientFrames.push(frame);
        if (frame.event !== "connect") return;
        socket.send(JSON.stringify({
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
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "notify.signal",
          trace_id: "notify-trace",
          emitted_at: 3,
          dseq: 1,
          payload: { event_id: "notify-1", category: "social" }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "history.transit",
          trace_id: "history-trace",
          emitted_at: 4,
          dseq: 2,
          payload: { kind: "history_sync_message", messages: [] }
        }));
        socket.send(JSON.stringify({
          ...inboundFrame({ dseq: 3 }),
          trace_id: "inbound-receipt",
          payload: {
            ...(inboundFrame().payload as Record<string, unknown>),
            message_id: "msg-receipt-1"
          }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "replay.done",
          trace_id: "replay-done",
          emitted_at: 6,
          dseq: 4,
          payload: {}
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "chat.metadata.invalidated",
          trace_id: "metadata-1",
          emitted_at: 7,
          chat_id: "chat-1",
          payload: { reason: "updated" }
        }));
        socket.send(JSON.stringify({
          version: "2",
          event: "message.delivered",
          trace_id: "delivered-downlink",
          emitted_at: 8,
          chat_id: "chat-1",
          payload: { message_id: "outbound-1", delivered_at: 8 }
        }));
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-events-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const awareness: string[] = [];
    const history: string[] = [];
    const deliveries: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onAwarenessSignal: async (event) => {
        awareness.push(event.event);
        if (event.event === "notify.signal") {
          expect(store.listReliableFrames("notify.signal")).toHaveLength(1);
        }
      },
      onHistoryTransit: async (event) => {
        history.push(event.event);
        expect(store.listReliableFrames("history.transit")).toHaveLength(1);
      },
      onDeliveryReceipt: async (event) => {
        deliveries.push(event.event);
      },
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    await waitFor(
      () =>
        clientFrames.some((frame) => frame.event === "message.sync_ack" && frame.payload.dseq === 4) &&
        clientFrames.some(
          (frame) =>
            frame.event === "message.delivered" && frame.payload.message_id === "msg-receipt-1"
        ) &&
        awareness.length === 2 &&
        history.length === 1 &&
        deliveries.length === 1
    );

    expect(awareness).toEqual(["notify.signal", "chat.metadata.invalidated"]);
    expect(history).toEqual(["history.transit"]);
    expect(deliveries).toEqual(["message.delivered"]);
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
