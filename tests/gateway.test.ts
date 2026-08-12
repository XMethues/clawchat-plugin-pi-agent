import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawChatGateway } from "../src/gateway.js";
import { GatewayStore } from "../src/gateway-store.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
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

  it("flushes the current dense high-water from the frame path and retains every ACK safeguard", async () => {
    vi.useFakeTimers();
    const server = await listen();
    const peer = Promise.withResolvers<WebSocket>();
    const denseBarrier = Promise.withResolvers<void>();
    const stopBarrier = Promise.withResolvers<void>();
    const firstAck = Promise.withResolvers<Record<string, any>>();
    const debounceAck = Promise.withResolvers<Record<string, any>>();
    const heartbeatAck = Promise.withResolvers<Record<string, any>>();
    const replayAck = Promise.withResolvers<Record<string, any>>();
    const stopAck = Promise.withResolvers<Record<string, any>>();
    const acknowledgements: Array<Record<string, any>> = [];
    server.on("connection", (socket) => {
      peer.resolve(socket);
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
                ack_epoch: "dense-frame-path-epoch",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          for (const dseq of [1, 2]) {
            socket.send(
              JSON.stringify({
                version: "2",
                event: "sync.mark",
                trace_id: `dense-${dseq}`,
                emitted_at: dseq + 2,
                dseq,
                payload: { covers_seq: dseq }
              })
            );
          }
          socket.send(
            JSON.stringify({
              version: "2",
              event: "ping",
              trace_id: "dense-barrier",
              emitted_at: 5,
              payload: {}
            })
          );
        } else if (frame.event === "pong" && frame.trace_id === "dense-barrier") {
          denseBarrier.resolve();
        } else if (frame.event === "pong" && frame.trace_id === "stop-barrier") {
          stopBarrier.resolve();
        } else if (frame.event === "message.sync_ack") {
          acknowledgements.push(frame);
          if (acknowledgements.length === 1) firstAck.resolve(frame);
          if (acknowledgements.length === 2) debounceAck.resolve(frame);
          if (acknowledgements.length === 3) heartbeatAck.resolve(frame);
          if (frame.payload.dseq === 3) replayAck.resolve(frame);
          if (frame.payload.dseq === 4) stopAck.resolve(frame);
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
    const socket = await peer.promise;
    await denseBarrier.promise;
    expect(store.getReliableHighWater("dense-frame-path-epoch")).toBe(2);
    expect(acknowledgements).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    await expect(firstAck.promise).resolves.toMatchObject({
      payload: { dseq: 2, epoch: "dense-frame-path-epoch" }
    });
    expect(acknowledgements).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(debounceAck.promise).resolves.toMatchObject({
      payload: { dseq: 2, epoch: "dense-frame-path-epoch" }
    });

    await vi.advanceTimersByTimeAsync(29_800);
    await expect(heartbeatAck.promise).resolves.toMatchObject({
      payload: { dseq: 2, epoch: "dense-frame-path-epoch" }
    });

    socket.send(
      JSON.stringify({
        version: "2",
        event: "replay.done",
        trace_id: "replay",
        emitted_at: 6,
        dseq: 3,
        payload: {}
      })
    );
    await expect(replayAck.promise).resolves.toMatchObject({
      payload: { dseq: 3, epoch: "dense-frame-path-epoch" }
    });

    socket.send(
      JSON.stringify({
        version: "2",
        event: "sync.mark",
        trace_id: "before-stop",
        emitted_at: 7,
        dseq: 4,
        payload: { covers_seq: 4 }
      })
    );
    socket.send(
      JSON.stringify({
        version: "2",
        event: "ping",
        trace_id: "stop-barrier",
        emitted_at: 8,
        payload: {}
      })
    );
    await stopBarrier.promise;
    expect(store.getReliableHighWater("dense-frame-path-epoch")).toBe(4);
    await gateway.stop();
    await expect(stopAck.promise).resolves.toMatchObject({
      payload: { dseq: 4, epoch: "dense-frame-path-epoch" }
    });
    store.close();
  });

  it("clears queued ACK work when hello-ok starts a new delivery epoch", async () => {
    vi.useFakeTimers();
    const server = await listen();
    const peer = Promise.withResolvers<WebSocket>();
    const firstEpochBarrier = Promise.withResolvers<void>();
    const secondEpochBarrier = Promise.withResolvers<void>();
    const immediateBarrier = Promise.withResolvers<void>();
    const debounceBarrier = Promise.withResolvers<void>();
    const heartbeatAck = Promise.withResolvers<Record<string, any>>();
    const acknowledgements: Array<Record<string, any>> = [];
    server.on("connection", (socket) => {
      peer.resolve(socket);
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
                ack_epoch: "first-epoch",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "sync.mark",
              trace_id: "first-epoch-mark",
              emitted_at: 3,
              dseq: 1,
              payload: { covers_seq: 1 }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "ping",
              trace_id: "first-epoch-barrier",
              emitted_at: 4,
              payload: {}
            })
          );
        } else if (frame.event === "pong" && frame.trace_id === "first-epoch-barrier") {
          firstEpochBarrier.resolve();
        } else if (frame.event === "pong" && frame.trace_id === "second-epoch-barrier") {
          secondEpochBarrier.resolve();
        } else if (frame.event === "pong" && frame.trace_id === "immediate-barrier") {
          immediateBarrier.resolve();
        } else if (frame.event === "pong" && frame.trace_id === "debounce-barrier") {
          debounceBarrier.resolve();
        } else if (frame.event === "message.sync_ack") {
          acknowledgements.push(frame);
          heartbeatAck.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    store.advanceReliableHighWater("second-epoch", 7);
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
    const socket = await peer.promise;
    await firstEpochBarrier.promise;
    socket.send(
      JSON.stringify({
        version: "2",
        event: "hello-ok",
        trace_id: "second-hello",
        emitted_at: 5,
        payload: {
          ack_mode: "dseq",
          ack_epoch: "second-epoch",
          device_id: "clawchat-pi-device-1",
          delivery_mode: "device_replay"
        }
      })
    );
    socket.send(
      JSON.stringify({
        version: "2",
        event: "ping",
        trace_id: "second-epoch-barrier",
        emitted_at: 6,
        payload: {}
      })
    );
    await secondEpochBarrier.promise;

    await vi.advanceTimersByTimeAsync(0);
    socket.send(
      JSON.stringify({
        version: "2",
        event: "ping",
        trace_id: "immediate-barrier",
        emitted_at: 7,
        payload: {}
      })
    );
    await immediateBarrier.promise;
    expect(acknowledgements).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    socket.send(
      JSON.stringify({
        version: "2",
        event: "ping",
        trace_id: "debounce-barrier",
        emitted_at: 8,
        payload: {}
      })
    );
    await debounceBarrier.promise;
    expect(acknowledgements).toEqual([]);

    await vi.advanceTimersByTimeAsync(29_800);
    await expect(heartbeatAck.promise).resolves.toMatchObject({
      payload: { dseq: 7, epoch: "second-epoch" }
    });
    expect(acknowledgements).toHaveLength(1);
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
    expect(frame.payload.message_id).toMatch(/^msg-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(store.listPendingOutbound()[0]).toMatchObject({
      messageId: frame.payload.message_id,
      frame
    });
    await waitFor(() => store.listPendingOutbound().length === 0);
    await gateway.stop();
    store.close();
  });

  it("coalesces expired outbound ACK deadlines into one replay-gated stable resend", async () => {
    const server = await listen();
    const deliveries: Array<{ connection: number; serializedFrame: string }> = [];
    const releaseFirstReplay = Promise.withResolvers<void>();
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      const connection = connections;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connection}`,
          emitted_at: 1,
          payload: { nonce: `challenge-nonce-${connection}` }
        })
      );
      socket.on("message", (raw) => {
        const serializedFrame = raw.toString();
        const frame = JSON.parse(serializedFrame) as Record<string, any>;
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
          const sendReplay = () =>
            socket.send(
              JSON.stringify({
                version: "2",
                event: "replay.done",
                trace_id: `replay-${connection}`,
                emitted_at: 3,
                payload: {}
              })
            );
          if (connection === 1) {
            void releaseFirstReplay.promise.then(sendReplay);
          } else {
            sendReplay();
          }
        } else if (frame.event === "message.reply") {
          deliveries.push({ connection, serializedFrame });
          if (connection === 2) {
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
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const clock = createManualGatewayClock(1_776_162_600_000);
    const reconnectDelay = vi.fn(() => 0);
    const statuses: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      now: clock.now,
      timer: clock.timer,
      outboundAckDeadlineMs: 1_000,
      reconnectDelay,
      onStatus: (status) => statuses.push(status)
    });

    await gateway.start();
    const secondReply = outboundReply();
    secondReply.trace_id = "trace-out-2";
    await gateway.send(outboundReply());
    await gateway.send(secondReply);
    expect(store.listPendingOutbound()).toEqual([
      expect.objectContaining({ traceId: "trace-out-1", attempts: 0, lastAttemptAt: null }),
      expect.objectContaining({ traceId: "trace-out-2", attempts: 0, lastAttemptAt: null })
    ]);
    expect(clock.pendingTimers()).toBe(0);
    releaseFirstReplay.resolve();
    await waitFor(() => deliveries.length === 2);
    expect(store.listPendingOutbound()).toEqual([
      expect.objectContaining({ traceId: "trace-out-1", attempts: 1, lastAttemptAt: clock.now() }),
      expect.objectContaining({ traceId: "trace-out-2", attempts: 1, lastAttemptAt: clock.now() })
    ]);

    clock.advance(999);
    expect(connections).toBe(1);
    clock.advance(1);
    expect(store.listPendingOutbound()).toHaveLength(2);
    expect(store.getStatus().failedOutbound).toBe(0);
    await waitFor(() => deliveries.length === 4 && store.listPendingOutbound().length === 0);
    expect(clock.pendingTimers()).toBe(0);

    const firstAttempt = deliveries
      .filter((delivery) => delivery.connection === 1)
      .map((delivery) => delivery.serializedFrame);
    const reconciledAttempt = deliveries
      .filter((delivery) => delivery.connection === 2)
      .map((delivery) => delivery.serializedFrame);
    expect(reconciledAttempt).toEqual(firstAttempt);
    expect(
      firstAttempt.map((serializedFrame) => {
        const frame = JSON.parse(serializedFrame) as Record<string, any>;
        return { traceId: frame.trace_id, messageId: frame.payload.message_id };
      })
    ).toEqual([
      { traceId: "trace-out-1", messageId: expect.stringMatching(/^msg-/) },
      { traceId: "trace-out-2", messageId: expect.stringMatching(/^msg-/) }
    ]);
    expect(reconnectDelay).toHaveBeenCalledTimes(1);
    expect(statuses).toContain(
      "2 outbound messages exceeded the ACK deadline; closing the socket to reconcile after replay"
    );
    await gateway.stop();
    store.close();
  });

  it("recovers a durable outbound ACK deadline after restart before resending", async () => {
    const server = await listen();
    const resent = Promise.withResolvers<string>();
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      const connection = connections;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connection}`,
          emitted_at: 1,
          payload: { nonce: `challenge-nonce-${connection}` }
        })
      );
      socket.on("message", (raw) => {
        const serializedFrame = raw.toString();
        const frame = JSON.parse(serializedFrame) as Record<string, any>;
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
            JSON.stringify({
              version: "2",
              event: "replay.done",
              trace_id: `replay-${connection}`,
              emitted_at: 3,
              payload: {}
            })
          );
        } else if (frame.event === "message.reply") {
          resent.resolve(serializedFrame);
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
    const path = join(directory, "gateway.sqlite");
    const original = outboundReply();
    const frame = {
      ...original,
      payload: {
        ...(original.payload as Record<string, unknown>),
        message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6"
      }
    };
    const serializedFrame = JSON.stringify(frame);
    const firstStore = GatewayStore.open(path);
    firstStore.enqueueOutbound({ traceId: "trace-out-1", chatId: "chat-1", frame });
    firstStore.recordOutboundAttempt("trace-out-1", 10_000);
    firstStore.close();

    const store = GatewayStore.open(path);
    const clock = createManualGatewayClock(10_999);
    const reconnectDelay = vi.fn(() => 0);
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      now: clock.now,
      timer: clock.timer,
      outboundAckDeadlineMs: 1_000,
      reconnectDelay
    });

    await gateway.start();
    await waitFor(() => clock.pendingTimers() === 1);
    expect(connections).toBe(1);
    clock.advance(1);
    await expect(resent.promise).resolves.toBe(serializedFrame);
    await waitFor(() => store.listPendingOutbound().length === 0);
    expect(clock.pendingTimers()).toBe(0);
    expect(connections).toBe(2);
    expect(reconnectDelay).toHaveBeenCalledTimes(1);
    await gateway.stop();
    store.close();
  });

  it("sends plaintext history transit frames without rewriting their routing envelope", async () => {
    const server = await listen();
    const receivedHistory = Promise.withResolvers<unknown>();
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "challenge-nonce" }
      }));
      socket.on("message", (raw) => {
        const frame: unknown = JSON.parse(raw.toString());
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || !("event" in frame)) {
          return;
        }
        if (frame.event === "connect") {
          socket.send(JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: "connect",
            emitted_at: 2,
            payload: { device_id: "device-old", delivery_mode: "device_replay" }
          }));
          socket.send(JSON.stringify({
            version: "2",
            event: "replay.done",
            trace_id: "replay",
            emitted_at: 3,
            payload: {}
          }));
        } else if (frame.event === "history.transit") {
          receivedHistory.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "device-old",
      userId: "user-1",
      store,
      onInboundMessage: async () => undefined,
      reconnect: false
    });

    await gateway.start();
    await gateway.send({
      version: "2",
      event: "history.transit",
      trace_id: "history-out",
      emitted_at: 4,
      target_device_id: "device-new",
      origin_device_id: "device-old",
      sender: { id: "user-1" },
      payload: { kind: "history_sync_done", messages_sent: 2 }
    });

    await expect(receivedHistory.promise).resolves.toMatchObject({
      target_device_id: "device-new",
      origin_device_id: "device-old",
      sender: { id: "user-1" },
      payload: { kind: "history_sync_done", messages_sent: 2 }
    });
    await gateway.stop();
    store.close();
  });

  it("reuses one durable message identity and serialized frame after a lost-ACK reconnect", async () => {
    const server = await listen();
    const replies: Array<Record<string, any>> = [];
    const serializedReplies: string[] = [];
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
          serializedReplies.push(raw.toString());
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
    expect(replies[0]!.payload.message_id).toMatch(/^msg-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(replies[1]!.payload.message_id).toBe(replies[0]!.payload.message_id);
    expect(replies[1]!.trace_id).toBe(replies[0]!.trace_id);
    expect(serializedReplies[1]).toBe(serializedReplies[0]);
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
    const clock = createManualGatewayClock(1_776_162_600_000);
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      now: clock.now,
      timer: clock.timer,
      outboundAckDeadlineMs: 1_000,
      reconnect: false
    });

    await gateway.start();
    await gateway.send(outboundReply());
    await rejected;
    await waitFor(() => store.getStatus().failedOutbound === 1);
    expect(store.listPendingOutbound()).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(1_000);
    expect(store.getStatus().failedOutbound).toBe(1);
    await gateway.stop();
    store.close();
  });

  it("retries non-auth hello failures without refreshing the profile token", async () => {
    const server = await listen();
    const tokens: string[] = [];
    const transientReasons = [
      "remote auth service unavailable",
      "future transient authentication dependency failure"
    ];
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
        tokens.push(frame.payload.token);
        const reason = transientReasons[thisConnection - 1];
        if (reason) {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-fail",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: { reason }
            })
          );
          return;
        }
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
          JSON.stringify({
            version: "2",
            event: "replay.done",
            trace_id: "replay",
            emitted_at: 4,
            payload: {}
          })
        );
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

    await gateway.start();
    expect(connectionNumber).toBe(3);
    expect(tokens).toEqual(["access-1", "access-1", "access-1"]);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    await gateway.stop();
    store.close();
  });

  it("recovers repeated nonce mismatches with fresh challenges and normal backoff", async () => {
    const server = await listen();
    const connectPayloads: Array<{ nonce: string; token: string }> = [];
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      const current = connections;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${current}`,
          emitted_at: current,
          payload: { nonce: `nonce-${current}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        connectPayloads.push({
          nonce: frame.payload.nonce,
          token: frame.payload.token
        });
        if (current <= 2) {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-fail",
              trace_id: frame.trace_id,
              emitted_at: current,
              payload: { reason: "nonce mismatch" }
            })
          );
          return;
        }
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: current,
            payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
          })
        );
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const refreshAccessToken = vi.fn(async () => "access-2");
    const reconnectDelay = vi.fn((attempt: number) => attempt * 2 + 1);
    const statuses: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      refreshAccessToken,
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onStatus: (status) => statuses.push(status),
      reconnect: true,
      reconnectDelay
    });

    await gateway.start();
    expect(connectPayloads).toEqual([
      { nonce: "nonce-1", token: "access-1" },
      { nonce: "nonce-2", token: "access-1" },
      { nonce: "nonce-3", token: "access-1" }
    ]);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(reconnectDelay.mock.calls).toEqual([[0], [1]]);
    expect(statuses).toContain("transient handshake failure; reconnecting in 1ms");
    expect(statuses).toContain("transient handshake failure; reconnecting in 3ms");
    await gateway.stop();
    store.close();
  });

  it.each(["invalid connect event", "invalid connect payload"] as const)(
    "keeps exact %s handshake failures terminal",
    async (reason) => {
      const server = await listen();
      let connections = 0;
      server.on("connection", (socket) => {
        connections += 1;
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
              event: "hello-fail",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: { reason }
            })
          );
        });
      });
      const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
      const store = GatewayStore.open(join(directory, "gateway.sqlite"));
      const refreshAccessToken = vi.fn(async () => "access-2");
      const reconnectDelay = vi.fn(() => 0);
      const gateway = new ClawChatGateway({
        websocketUrl: websocketUrl(server),
        accessToken: "access-1",
        refreshAccessToken,
        deviceId: "clawchat-pi-device-1",
        userId: "agent-user-1",
        store,
        onInboundMessage: async () => undefined,
        reconnect: true,
        reconnectDelay
      });

      await expect(gateway.start()).rejects.toThrow(`ClawChat hello failed: ${reason}`);
      expect(connections).toBe(1);
      expect(refreshAccessToken).not.toHaveBeenCalled();
      expect(reconnectDelay).not.toHaveBeenCalled();
      await gateway.stop();
      store.close();
    }
  );

  it("does not retry a terminal handshake failure during reconnect", async () => {
    const server = await listen();
    const terminalFailure = Promise.withResolvers<void>();
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      const connection = connections;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connection}`,
          emitted_at: 1,
          payload: { nonce: `nonce-${connection}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        if (connection === 1) {
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: {
                ack_mode: "dseq",
                ack_epoch: "terminal-reconnect-epoch",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          setImmediate(() => socket.close());
          return;
        }
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-fail",
            trace_id: frame.trace_id,
            emitted_at: 3,
            payload: { reason: "invalid connect payload" }
          })
        );
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-terminal-reconnect-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const reconnectDelay = vi.fn(() => 0);
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onStatus: (status) => {
        if (status === "reconnect failed: ClawChat hello failed: invalid connect payload") {
          terminalFailure.resolve();
        }
      },
      reconnect: true,
      reconnectDelay
    });

    await gateway.start();
    await terminalFailure.promise;
    expect(connections).toBe(2);
    expect(reconnectDelay).toHaveBeenCalledTimes(1);
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

  it("refreshes once per healthy connection cycle and single-flights concurrent failures", async () => {
    const server = await listen();
    const tokens: string[] = [];
    const statuses: string[] = [];
    const refreshResolvers: Array<(token: string) => void> = [];
    const { promise: secondHealthy, resolve: resolveSecondHealthy } =
      Promise.withResolvers<void>();
    let closeFirstHealthy!: () => void;
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      const current = connections;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${current}`,
          emitted_at: current,
          payload: { nonce: `nonce-${current}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        tokens.push(frame.payload.token);
        if (current === 1 || current === 3) {
          const failure = JSON.stringify({
            version: "2",
            event: "hello-fail",
            trace_id: frame.trace_id,
            emitted_at: current,
            payload: { reason: "authentication failed" }
          });
          socket.send(failure);
          socket.send(failure);
          return;
        }
        if (current === 2) closeFirstHealthy = () => socket.close();
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: current,
            payload: { device_id: "clawchat-pi-device-1", delivery_mode: "device_replay" }
          })
        );
        if (current === 4) resolveSecondHealthy();
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const refreshAccessToken = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      refreshResolvers.push(resolve);
      return promise;
    });
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      refreshAccessToken,
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      onStatus: (status) => statuses.push(status),
      reconnect: true,
      reconnectDelay: () => 0
    });

    const started = gateway.start();
    await waitFor(() => refreshResolvers.length === 1);
    refreshResolvers[0]?.("access-2");
    await started;
    closeFirstHealthy();
    await waitFor(() => refreshResolvers.length === 2);
    refreshResolvers[1]?.("access-3");
    await secondHealthy;
    await waitFor(() => statuses.filter((status) => status === "connected").length === 2);

    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(connections).toBe(4);
    expect(tokens).toEqual(["access-1", "access-2", "access-2", "access-3"]);
    await gateway.stop();
    store.close();
  });

  it("does not refresh an immediately rejected replacement token again", async () => {
    const server = await listen();
    const tokens: string[] = [];
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connections}`,
          emitted_at: 1,
          payload: { nonce: `nonce-${connections}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event !== "connect") return;
        tokens.push(frame.payload.token);
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-fail",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: { reason: "authentication failed" }
          })
        );
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
    await expect(gateway.start()).rejects.toThrow("authentication failed");
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(connections).toBe(3);
    expect(tokens).toEqual(["access-1", "access-2", "access-2"]);
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


  it("persists and acknowledges a forward-compatible unknown dseq event", async () => {
    const server = await listen();
    const acked = Promise.withResolvers<Record<string, any>>();
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
                ack_epoch: "future-event-epoch",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "conversation.future",
              dseq: 1,
              payload: { extension: true }
            })
          );
        } else if (frame.event === "message.sync_ack") {
          acked.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-unknown-"));
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
    await expect(acked.promise).resolves.toMatchObject({
      payload: { dseq: 1, epoch: "future-event-epoch" }
    });
    expect(store.listReliableFrames("conversation.future")).toEqual([
      expect.objectContaining({
        event: "conversation.future",
        payload: { extension: true }
      })
    ]);
    expect(store.listQuarantinedFrames()).toEqual([]);
    await gateway.stop();
    store.close();
  });

  it("persists and acknowledges a forward-compatible unknown cursor event", async () => {
    const server = await listen();
    const acked = Promise.withResolvers<Record<string, any>>();
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
                delivery_mode: "device_replay"
              }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "conversation.future",
              trace_id: "future-v1",
              emitted_at: 3,
              seq: 1,
              payload: { extension: true }
            })
          );
        } else if (frame.event === "message.cursor_ack") {
          acked.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-unknown-v1-"));
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
    await expect(acked.promise).resolves.toMatchObject({ payload: { seq: 1 } });
    expect(store.listReliableFrames("conversation.future")).toEqual([
      expect.objectContaining({
        event: "conversation.future",
        trace_id: "future-v1",
        payload: { extension: true }
      })
    ]);
    expect(store.listQuarantinedFrames()).toEqual([]);
    await gateway.stop();
    store.close();
  });

  it("quarantines invalid JSON without acknowledging it and reconnects fail-safe", async () => {
    const server = await listen();
    const secondReady = Promise.withResolvers<void>();
    let connectionCount = 0;
    const acknowledgements: Array<Record<string, any>> = [];
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connection = connectionCount;
      if (connection === 1) {
        socket.send("{");
        return;
      }
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connection}`,
          emitted_at: 1,
          payload: { nonce: `nonce-${connection}` }
        })
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        if (frame.event === "message.sync_ack") acknowledgements.push(frame);
        if (frame.event !== "connect") return;
        socket.send(
          JSON.stringify({
            version: "2",
            event: "hello-ok",
            trace_id: frame.trace_id,
            emitted_at: 2,
            payload: {
              ack_mode: "dseq",
              ack_epoch: "raw-poison-epoch",
              device_id: "clawchat-pi-device-1",
              delivery_mode: "device_replay"
            }
          })
        );
        secondReady.resolve();
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-raw-poison-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      ackDebounceMs: 0,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await gateway.start();
    await secondReady.promise;
    await waitFor(() => connectionCount === 2);
    expect(acknowledgements).toEqual([]);
    expect(store.listQuarantinedFrames()).toEqual([
      expect.objectContaining({
        ackEpoch: null,
        dseq: null,
        ackable: false,
        event: "<invalid-json>",
        frame: "{"
      })
    ]);
    await gateway.stop();
    store.close();
  });

  it("terminates poison replay by acknowledging the durable quarantine high-water", async () => {
    const server = await listen();
    const replayAcked = Promise.withResolvers<Record<string, any>>();
    let connectionCount = 0;
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connection = connectionCount;
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: `challenge-${connection}`,
          emitted_at: 1,
          payload: { nonce: `nonce-${connection}` }
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
                ack_epoch: "poison-replay-epoch",
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
              dseq: 1,
              chat_id: "chat-1",
              payload: { message_id: "msg-poison" }
            })
          );
        } else if (frame.event === "message.sync_ack" && frame.payload.dseq === 1) {
          if (connection === 1) {
            socket.close();
          } else {
            replayAcked.resolve(frame);
          }
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-poison-replay-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: async () => undefined,
      ackDebounceMs: 0,
      reconnect: true,
      reconnectDelay: () => 0
    });

    await gateway.start();
    await expect(replayAcked.promise).resolves.toMatchObject({
      payload: { dseq: 1, epoch: "poison-replay-epoch" }
    });
    expect(connectionCount).toBe(2);
    expect(store.getReliableHighWater("poison-replay-epoch")).toBe(1);
    expect(store.listQuarantinedFrames()).toEqual([
      expect.objectContaining({
        ackEpoch: "poison-replay-epoch",
        dseq: 1,
        ackable: true,
        event: "message.send"
      })
    ]);
    await gateway.stop();
    store.close();
  });
  it("persists and acknowledges a monotonic v2 replay truncation boundary", async () => {
    const server = await listen();
    const finalAck = Promise.withResolvers<Record<string, any>>();
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: "challenge",
          emitted_at: 1,
          payload: { nonce: "nonce" }
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
                ack_epoch: "truncation-epoch",
                device_id: "clawchat-pi-device-1",
                delivery_mode: "device_replay"
              }
            })
          );
          for (const [dseq, oldestSeq] of [
            [1, 40],
            [2, 40],
            [3, 20],
            [4, 0]
          ] as const) {
            socket.send(
              JSON.stringify({
                version: "2",
                event: "history.truncated",
                trace_id: `truncation-${dseq}`,
                emitted_at: dseq + 2,
                dseq,
                payload: { oldest_seq: oldestSeq }
              })
            );
          }
        } else if (frame.event === "message.sync_ack" && frame.payload.dseq === 4) {
          finalAck.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-truncation-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const received = vi.fn(async () => undefined);
    const statuses: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: received,
      onStatus: (status) => statuses.push(status),
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    await expect(finalAck.promise).resolves.toMatchObject({
      payload: { dseq: 4, epoch: "truncation-epoch" }
    });
    expect(store.getInboxHistoryBoundary()).toMatchObject({ oldestSeq: 40 });
    expect(store.getReliableHighWater("truncation-epoch")).toBe(4);
    expect(store.listQuarantinedFrames()).toEqual([
      expect.objectContaining({
        ackEpoch: "truncation-epoch",
        dseq: 4,
        ackable: true,
        event: "history.truncated",
        reason: "oldest_seq must be a positive integer"
      })
    ]);
    expect(statuses).toContain("inbox history before sequence 40 is unavailable");
    expect(received).not.toHaveBeenCalled();
    await gateway.stop();
    store.close();
  });

  it("diagnoses an invalid non-dseq truncation without moving the v1 boundary", async () => {
    const server = await listen();
    const cursorAck = Promise.withResolvers<Record<string, any>>();
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          version: "2",
          event: "connect.challenge",
          trace_id: "challenge",
          emitted_at: 1,
          payload: { nonce: "nonce" }
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
                delivery_mode: "device_replay"
              }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "history.truncated",
              trace_id: "valid-v1-boundary",
              emitted_at: 3,
              seq: 5,
              payload: { oldest_seq: 15 }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "history.truncated",
              trace_id: "invalid-v1-boundary",
              emitted_at: 4,
              seq: 6,
              payload: { oldest_seq: "unknown" }
            })
          );
        } else if (frame.event === "message.cursor_ack") {
          cursorAck.resolve(frame);
        }
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-truncation-v1-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const received = vi.fn(async () => undefined);
    const diagnosed = Promise.withResolvers<void>();
    const statuses: string[] = [];
    const gateway = new ClawChatGateway({
      websocketUrl: websocketUrl(server),
      accessToken: "access-1",
      deviceId: "clawchat-pi-device-1",
      userId: "agent-user-1",
      store,
      onInboundMessage: received,
      onStatus: (status) => {
        statuses.push(status);
        if (status.startsWith("ignored invalid history.truncated boundary")) diagnosed.resolve();
      },
      ackDebounceMs: 0,
      reconnect: false
    });

    await gateway.start();
    await diagnosed.promise;
    await expect(cursorAck.promise).resolves.toMatchObject({ payload: { seq: 5 } });
    expect(store.getInboxHistoryBoundary()).toMatchObject({ oldestSeq: 15 });
    expect(store.listQuarantinedFrames()).toEqual([]);
    expect(statuses).toContain(
      "ignored invalid history.truncated boundary: oldest_seq must be a positive integer"
    );
    expect(received).not.toHaveBeenCalled();
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

function createManualGatewayClock(start: number) {
  let current = start;
  let nextHandle = 1;
  const scheduled = new Map<number, { dueAt: number; callback: () => void }>();
  return {
    now: () => current,
    timer: {
      schedule(callback: () => void, delayMs: number): unknown {
        const handle = nextHandle;
        nextHandle += 1;
        scheduled.set(handle, { dueAt: current + delayMs, callback });
        return handle;
      },
      cancel(handle: unknown): void {
        if (typeof handle === "number") scheduled.delete(handle);
      }
    },
    advance(milliseconds: number): void {
      current += milliseconds;
      while (true) {
        let next: [number, { dueAt: number; callback: () => void }] | undefined;
        for (const entry of scheduled.entries()) {
          if (entry[1].dueAt <= current && (!next || entry[1].dueAt < next[1].dueAt)) {
            next = entry;
          }
        }
        if (!next) return;
        scheduled.delete(next[0]);
        next[1].callback();
      }
    },
    pendingTimers: () => scheduled.size
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
