import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ClawChatGateway } from "../dist/src/gateway.js";
import { GatewayStore } from "../dist/src/gateway-store.js";

const TIMEOUT_MS = 5_000;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-built-gateway-smoke-"));
const store = GatewayStore.open(join(directory, "gateway.sqlite"));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const connected = Promise.withResolvers();
const replayAcknowledged = Promise.withResolvers();
const materialized = Promise.withResolvers();
let serverSocket;
let gateway;

try {
  await withTimeout(
    new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "WebSocket server startup"
  );
  const address = server.address();
  assert(address && typeof address === "object", "WebSocket server did not expose an address");

  server.on("connection", (socket) => {
    serverSocket = socket;
    socket.send(
      JSON.stringify({
        version: "2",
        event: "connect.challenge",
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "smoke-nonce" }
      })
    );
    socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.event === "connect") {
          connected.resolve(frame);
          socket.send(
            JSON.stringify({
              version: "2",
              event: "hello-ok",
              trace_id: frame.trace_id,
              emitted_at: 2,
              payload: {
                device_id: "smoke-device",
                delivery_mode: "device_replay",
                ack_mode: "dseq",
                ack_epoch: "01JSMOKEGATEWAYACK00000000"
              }
            })
          );
          socket.send(
            JSON.stringify({
              version: "2",
              event: "replay.done",
              trace_id: "replay-smoke",
              emitted_at: 3,
              dseq: 1,
              payload: {}
            })
          );
        } else if (frame.event === "message.sync_ack") {
          replayAcknowledged.resolve(frame);
        } else if (frame.event === "message.send") {
          materialized.resolve(frame);
        }
      } catch (error) {
        connected.reject(error);
        replayAcknowledged.reject(error);
        materialized.reject(error);
      }
    });
  });

  gateway = new ClawChatGateway({
    websocketUrl: `ws://127.0.0.1:${address.port}`,
    accessToken: "opaque-smoke-token",
    deviceId: "smoke-device",
    userId: "smoke-agent-user",
    store,
    onInboundMessage: async () => undefined,
    onAwarenessSignal: async () => undefined,
    onHistoryTransit: async () => undefined,
    onDeliveryReceipt: async () => undefined,
    reconnect: false,
    ackDebounceMs: 0,
    now: () => 1_776_162_601_000,
    idFactory: () => "smoke"
  });

  await gateway.start();
  const connect = await withTimeout(connected.promise, "connect frame");
  assert.equal(connect.payload.token, "opaque-smoke-token");
  assert.equal(connect.payload.nonce, "smoke-nonce");
  assert.equal(connect.payload.device_id, "smoke-device");
  assert.deepEqual(connect.payload.capabilities, {
    multi_device: true,
    device_replay: true,
    chat_meta_events: true,
    notify_signals: true,
    delivery_receipt: true,
    history_sync: true,
    reliable_delivery: true,
    reliable_delivery_v2: true
  });

  await gateway.send({
    version: "2",
    event: "message.send",
    trace_id: "smoke-outbound",
    emitted_at: 4,
    chat_id: "chat-smoke",
    payload: {
      message: {
        body: { fragments: [{ kind: "text", text: "built Gateway smoke" }] },
        context: { mentions: [], reply: null }
      }
    }
  });

  const [syncAck, outbound] = await Promise.all([
    withTimeout(replayAcknowledged.promise, "replay acknowledgement"),
    withTimeout(materialized.promise, "materialized outbound frame")
  ]);
  assert.deepEqual(syncAck.payload, {
    dseq: 1,
    epoch: "01JSMOKEGATEWAYACK00000000"
  });
  assert.match(outbound.payload.message_id, /^msg-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

  const [pending] = store.listPendingOutbound();
  assert(pending, "materialized frame was not durably pending before ACK");
  assert.equal(pending.traceId, "smoke-outbound");
  assert.equal(pending.messageId, outbound.payload.message_id);
  assert.equal(pending.frame.payload.message_id, outbound.payload.message_id);
  assert.equal(pending.attempts, 1);

  serverSocket.send(
    JSON.stringify({
      version: "2",
      event: "message.ack",
      trace_id: "smoke-outbound",
      emitted_at: 5,
      chat_id: "chat-smoke",
      payload: {
        message_id: outbound.payload.message_id,
        accepted_at: 5
      }
    })
  );
  await waitFor(() => store.listPendingOutbound().length === 0, "Outbox ACK settlement");
  assert.equal(store.getStatus().failedOutbound, 0);

  console.log(`built Gateway smoke passed (${outbound.payload.message_id})`);
} finally {
  await gateway?.stop().catch(() => undefined);
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(directory, { recursive: true, force: true });
}
