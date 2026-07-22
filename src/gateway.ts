import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { GatewayStore } from "./gateway-store.js";
import type { InboundDecision } from "./inbound-router.js";
import type { ClawchatInboundMessage } from "./types.js";

export interface ClawChatGatewayOptions {
  websocketUrl: string;
  accessToken: string;
  deviceId: string;
  userId: string;
  store: GatewayStore;
  onInboundMessage: (message: ClawchatInboundMessage) => Promise<void>;
  shouldDispatch?: (message: ClawchatInboundMessage) => boolean;
  classifyInbound?: (message: ClawchatInboundMessage) => InboundDecision;
  onAcceptedControl?: (message: ClawchatInboundMessage, decision: InboundDecision) => Promise<void>;
  queueTurns?: boolean;
  onStatus?: (status: string) => void;
  reconnect?: boolean;
  reconnectDelay?: (attempt: number) => number;
  ackDebounceMs?: number;
  ackHeartbeatMs?: number;
  handshakeTimeoutMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

interface ProtocolEnvelope {
  version: "2";
  event: string;
  trace_id?: string;
  emitted_at?: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export class ClawChatGateway {
  private readonly options: ClawChatGatewayOptions;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private socket: WebSocket | undefined;
  private stopping = false;
  private frameQueue: Promise<void> = Promise.resolve();
  private ackMode: "dseq" | "cursor" | "legacy" = "legacy";
  private ackEpoch: string | undefined;
  private lastReadDseq = 0;
  private ackHighWater = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private ackHeartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private replayComplete = false;

  constructor(options: ClawChatGatewayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async start(): Promise<void> {
    this.stopping = false;
    let attempt = 0;
    while (!this.stopping) {
      try {
        await this.openConnection();
        return;
      } catch (error: unknown) {
        if (!(error instanceof ReconnectableHandshakeError) || this.options.reconnect === false) throw error;
        const wait = this.options.reconnectDelay?.(attempt) ?? defaultReconnectDelay(attempt);
        attempt += 1;
        this.options.onStatus?.(`transient handshake failure; reconnecting in ${wait}ms`);
        await delay(wait);
      }
    }
    throw new Error("ClawChat Gateway stopped before connecting");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.ackHeartbeat) clearInterval(this.ackHeartbeat);
    this.ackHeartbeat = undefined;
    this.flushAcknowledgement();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  async send(message: unknown): Promise<void> {
    const envelope = cloneOutboundEnvelope(message);
    if (envelope.event === "message.reply") {
      const messageId =
        typeof envelope.payload?.message_id === "string"
          ? envelope.payload.message_id
          : createMessageId(this.now());
      envelope.payload = { ...envelope.payload, message_id: messageId };
      this.options.store.enqueueOutbound({
        messageId,
        chatId: requireString(envelope.chat_id, "chat_id"),
        frame: envelope
      });
      this.sendApplicationFrame(envelope);
      return;
    }
    if (envelope.event === "typing.update") {
      this.sendRaw(envelope);
      return;
    }
    throw new Error(`Unsupported outbound event '${envelope.event}'`);
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.websocketUrl);
      this.socket = socket;
      this.frameQueue = Promise.resolve();
      this.replayComplete = false;
      let ready = false;
      const handshakeTimer = setTimeout(() => {
        if (ready) return;
        reject(new ReconnectableHandshakeError("ClawChat handshake timed out"));
        socket.close();
      }, this.options.handshakeTimeoutMs ?? 10_000);

      const failBeforeReady = (error: Error) => {
        if (!ready) reject(new ReconnectableHandshakeError(error.message));
      };
      socket.once("error", failBeforeReady);
      socket.on("message", (raw) => {
        this.frameQueue = this.frameQueue
          .then(() =>
            this.handleFrame(parseEnvelope(raw), {
              ready: () => {
                if (ready) return;
                ready = true;
                clearTimeout(handshakeTimer);
                socket.off("error", failBeforeReady);
                this.options.onStatus?.("connected");
                resolve();
              },
              reject
            })
          )
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.options.onStatus?.(`protocol error: ${message}`);
            if (!ready) reject(error instanceof Error ? error : new Error(message));
            socket.close();
          });
      });
      socket.on("close", () => {
        clearTimeout(handshakeTimer);
        if (!ready) reject(new ReconnectableHandshakeError("ClawChat WebSocket closed before hello-ok"));
        if (!this.stopping) {
          this.options.onStatus?.("disconnected");
          if (ready) this.scheduleReconnect();
        }
      });
    });
  }

  private async handleFrame(
    envelope: ProtocolEnvelope | null,
    handshake: { ready: () => void; reject: (error: Error) => void }
  ): Promise<void> {
    if (!envelope) return;
    if (envelope.event === "connect.challenge") {
      this.sendRaw({
        version: "2",
        event: "connect",
        trace_id: `connect-${this.idFactory()}`,
        emitted_at: this.now(),
        payload: {
          token: this.options.accessToken,
          nonce: typeof envelope.payload?.nonce === "string" ? envelope.payload.nonce : "",
          device_id: this.options.deviceId,
          capabilities: {
            multi_device: true,
            device_replay: true,
            reliable_delivery: true,
            reliable_delivery_v2: true
          }
        }
      });
      return;
    }
    if (envelope.event === "hello-ok") {
      if (envelope.payload?.ack_mode === "dseq" && typeof envelope.payload.ack_epoch === "string") {
        this.ackMode = "dseq";
        this.ackEpoch = envelope.payload.ack_epoch;
        this.lastReadDseq = 0;
        this.ackHighWater = 0;
      } else {
        this.ackMode = "cursor";
        this.ackEpoch = undefined;
      }
      if (this.ackHeartbeat) clearInterval(this.ackHeartbeat);
      this.ackHeartbeat = setInterval(
        () => this.flushAcknowledgement(),
        this.options.ackHeartbeatMs ?? 30_000
      );
      handshake.ready();
      return;
    }
    if (envelope.event === "hello-fail") {
      const reason = typeof envelope.payload?.reason === "string" ? envelope.payload.reason : "unknown reason";
      handshake.reject(
        reason === "remote auth service unavailable"
          ? new TransientHandshakeError(`ClawChat hello failed: ${reason}`)
          : new Error(`ClawChat hello failed: ${reason}`)
      );
      this.socket?.close();
      return;
    }
    if (envelope.event === "ping") {
      this.sendRaw({
        version: "2",
        event: "pong",
        trace_id: envelope.trace_id ?? `pong-${this.idFactory()}`,
        emitted_at: envelope.emitted_at ?? this.now(),
        payload: {}
      });
      return;
    }

    if (envelope.event === "message.ack") {
      const messageId = envelope.payload?.message_id;
      if (typeof messageId === "string") this.options.store.acknowledgeOutbound(messageId);
      return;
    }

    if (envelope.event === "message.error") {
      const messageId = envelope.payload?.message_id;
      const code = envelope.payload?.code;
      if (typeof messageId === "string" && typeof code === "string") {
        const reason = typeof envelope.payload?.reason === "string" ? envelope.payload.reason : undefined;
        this.options.store.failOutbound(messageId, code, reason);
        this.options.onStatus?.(`outbound ${messageId} failed: ${code}`);
      }
      return;
    }

    if (this.ackMode === "dseq" && typeof envelope.dseq === "number") {
      await this.handleDseqFrame(envelope);
      return;
    }

    if (envelope.event === "replay.done") {
      this.reconnectAttempt = 0;
      this.replayComplete = true;
      this.flushOutbox();
      return;
    }

    if (
      this.ackMode === "cursor" &&
      typeof envelope.seq === "number" &&
      (envelope.event === "message.send" || envelope.event === "message.reply")
    ) {
      await this.persistInboundMessage(envelope);
      this.ackHighWater = Math.max(this.ackHighWater, envelope.seq);
      this.scheduleAcknowledgement(false);
      return;
    }

    if (envelope.event === "message.send" || envelope.event === "message.reply") {
      await this.persistInboundMessage(envelope);
    }
  }

  private async handleDseqFrame(envelope: ProtocolEnvelope): Promise<void> {
    const dseq = envelope.dseq as number;
    if (!Number.isSafeInteger(dseq) || dseq !== this.lastReadDseq + 1) {
      throw new Error(`expected dseq ${this.lastReadDseq + 1}, received ${dseq}`);
    }
    this.lastReadDseq = dseq;

    if (envelope.event === "message.send" || envelope.event === "message.reply") {
      try {
        await this.persistInboundMessage(envelope);
      } catch (error: unknown) {
        this.options.store.quarantineInboundFrame({
          ...(this.ackEpoch ? { ackEpoch: this.ackEpoch } : {}),
          dseq,
          event: envelope.event,
          reason: error instanceof Error ? error.message : String(error),
          frame: envelope
        });
        this.options.onStatus?.(`quarantined dseq ${dseq}`);
      }
    }
    this.ackHighWater = dseq;
    this.scheduleAcknowledgement(envelope.event === "replay.done");
    if (envelope.event === "replay.done") {
      this.reconnectAttempt = 0;
      this.replayComplete = true;
      this.flushOutbox();
    }
  }

  private async persistInboundMessage(envelope: ProtocolEnvelope): Promise<void> {
    if (!isInboundMessage(envelope)) {
      throw new Error(`invalid ${envelope.event} frame`);
    }
    const ownMessage = envelope.sender.id === this.options.userId;
    const decision = ownMessage
      ? { dispatch: false }
      : (this.options.classifyInbound?.(envelope) ?? {
          dispatch: this.options.shouldDispatch?.(envelope) ?? true
        });
    const admission = this.options.store.admitInbound({
      dedupeKey: `message:${envelope.payload.message_id}`,
      messageId: envelope.payload.message_id,
      chatId: envelope.chat_id,
      frame: envelope,
      dispatch: decision.dispatch,
      queueTurn: this.options.queueTurns !== false
    });
    if (admission.status !== "accepted") return;
    if (decision.control) {
      await this.options.onAcceptedControl?.(envelope, decision);
    } else if (decision.dispatch) {
      await this.options.onInboundMessage(envelope);
    }
  }

  private scheduleAcknowledgement(immediate = false): void {
    if (immediate || (this.options.ackDebounceMs ?? 200) === 0) {
      this.flushAcknowledgement();
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      this.flushAcknowledgement();
    }, this.options.ackDebounceMs ?? 200);
  }

  private flushAcknowledgement(): void {
    if (this.ackHighWater <= 0) return;
    if (this.ackMode === "dseq" && this.ackEpoch) {
      this.sendRaw({
        version: "2",
        event: "message.sync_ack",
        trace_id: `sync-ack-${this.idFactory()}`,
        emitted_at: this.now(),
        payload: { dseq: this.ackHighWater, epoch: this.ackEpoch }
      });
    } else if (this.ackMode === "cursor") {
      this.sendRaw({
        version: "2",
        event: "message.cursor_ack",
        trace_id: `cursor-ack-${this.idFactory()}`,
        emitted_at: this.now(),
        payload: { seq: this.ackHighWater }
      });
    }
  }

  private flushOutbox(): void {
    for (const pending of this.options.store.listPendingOutbound()) {
      this.sendApplicationFrame(cloneOutboundEnvelope(pending.frame));
    }
  }

  private sendApplicationFrame(frame: ProtocolEnvelope): void {
    if (!this.replayComplete || this.socket?.readyState !== WebSocket.OPEN) return;
    const messageId = requireString(frame.payload?.message_id, "payload.message_id");
    this.options.store.recordOutboundAttempt(messageId);
    this.socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.options.reconnect === false || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const delay = this.options.reconnectDelay?.(attempt) ?? defaultReconnectDelay(attempt);
    this.options.onStatus?.(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.openConnection().catch((error: unknown) => {
        this.options.onStatus?.(
          `reconnect failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.scheduleReconnect();
      });
    }, delay);
  }

  private sendRaw(frame: ProtocolEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }
}

function parseEnvelope(raw: WebSocket.RawData): ProtocolEnvelope | null {
  try {
    const parsed = JSON.parse(raw.toString()) as Partial<ProtocolEnvelope>;
    return parsed.version === "2" && typeof parsed.event === "string" ? (parsed as ProtocolEnvelope) : null;
  } catch {
    return null;
  }
}

function isInboundMessage(envelope: ProtocolEnvelope): envelope is ProtocolEnvelope & ClawchatInboundMessage {
  const candidate = envelope as Partial<ClawchatInboundMessage>;
  return (
    (candidate.event === "message.send" || candidate.event === "message.reply") &&
    typeof candidate.chat_id === "string" &&
    (candidate.chat_type === "direct" || candidate.chat_type === "group") &&
    typeof candidate.sender?.id === "string" &&
    typeof candidate.payload?.message_id === "string" &&
    Array.isArray(candidate.payload.message?.body?.fragments)
  );
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createMessageId(timestamp: number, entropy: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error("ULID timestamp is outside the 48-bit range");
  }
  if (entropy.length !== 10) throw new Error("ULID entropy must contain 10 bytes");

  let time = BigInt(timestamp);
  const timeChars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = CROCKFORD_BASE32[Number(time & 31n)]!;
    time >>= 5n;
  }
  let randomness = 0n;
  for (const byte of entropy) randomness = (randomness << 8n) | BigInt(byte);
  const randomChars = new Array<string>(16);
  for (let index = 15; index >= 0; index -= 1) {
    randomChars[index] = CROCKFORD_BASE32[Number(randomness & 31n)]!;
    randomness >>= 5n;
  }
  return `msg-${timeChars.join("")}${randomChars.join("")}`;
}

function cloneOutboundEnvelope(message: unknown): ProtocolEnvelope {
  if (!message || typeof message !== "object") throw new Error("Outbound frame must be an object");
  const cloned = JSON.parse(JSON.stringify(message)) as Partial<ProtocolEnvelope>;
  if (cloned.version !== "2" || typeof cloned.event !== "string") {
    throw new Error("Outbound frame must be a Protocol v2 envelope");
  }
  return cloned as ProtocolEnvelope;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Outbound frame missing ${field}`);
  return value;
}

function defaultReconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 10));
  return Math.floor(Math.random() * (ceiling + 1));
}

class ReconnectableHandshakeError extends Error {}

class TransientHandshakeError extends ReconnectableHandshakeError {}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
