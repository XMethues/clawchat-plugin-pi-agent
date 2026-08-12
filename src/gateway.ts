import WebSocket from "ws";
import { createProtocolMessageId, type GatewayStore } from "./gateway-store.js";
import type { InboundDecision } from "./inbound-router.js";
import type { ClawchatFragment, ClawchatInboundMessage, ClawchatPeer } from "./types.js";
import { isUnknownRecord } from "./type-guards.js";

export interface ClawchatGatewayEvent {
  version: "2";
  event: string;
  trace_id?: string;
  emitted_at?: number;
  chat_id?: string;
  target_device_id?: string;
  origin_device_id?: string;
  chat_type?: unknown;
  sender?: unknown;
  payload?: Record<string, unknown>;
}
export function isClawchatGatewayEvent(value: unknown): value is ClawchatGatewayEvent {
  if (!isUnknownRecord(value)) return false;
  if (value.version !== "2" || typeof value.event !== "string") return false;
  return value.payload === undefined || isUnknownRecord(value.payload);
}

export interface GatewayTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const DEFAULT_OUTBOUND_ACK_DEADLINE_MS = 30_000;

const DEFAULT_GATEWAY_TIMER: GatewayTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export interface ClawChatGatewayOptions {
  websocketUrl: string;
  accessToken: string;
  deviceId: string;
  refreshAccessToken?: () => Promise<string>;
  userId: string;
  store: GatewayStore;
  onInboundMessage: (message: ClawchatInboundMessage) => Promise<void>;
  shouldDispatch?: (message: ClawchatInboundMessage) => boolean;
  classifyInbound?: (message: ClawchatInboundMessage) => InboundDecision;
  onAcceptedControl?: (message: ClawchatInboundMessage, decision: InboundDecision) => Promise<void>;
  onAwarenessSignal?: (event: ClawchatGatewayEvent) => Promise<void>;
  onHistoryTransit?: (event: ClawchatGatewayEvent) => Promise<void>;
  onDeliveryReceipt?: (event: ClawchatGatewayEvent) => Promise<void>;
  onConnectionReady?: () => Promise<void> | void;
  queueTurns?: boolean;
  onStatus?: (status: string) => void;
  reconnect?: boolean;
  reconnectDelay?: (attempt: number) => number;
  ackDebounceMs?: number;
  ackHeartbeatMs?: number;
  replayIdleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  outboundAckDeadlineMs?: number;
  timer?: GatewayTimer;
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

interface InboundStreamState {
  chatId: string;
  chatType: "direct" | "group";
  sender: ClawchatPeer;
  messageMode: unknown;
  nextSequence: number;
}
interface OutboundAckDeadline {
  handle: unknown;
}

export class ClawChatGateway {
  private readonly options: ClawChatGatewayOptions;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly timer: GatewayTimer;
  private readonly outboundAckDeadlineMs: number;
  private socket: WebSocket | undefined;
  private stopping = false;
  private accessToken: string;
  private frameQueue: Promise<void> = Promise.resolve();
  private ackMode: "dseq" | "cursor" | "legacy" = "legacy";
  private ackEpoch: string | undefined;
  private lastReadDseq = 0;
  private ackHighWater = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private ackImmediate: NodeJS.Immediate | undefined;
  private ackGeneration = 0;
  private ackHeartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private replayIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private replayIdleGeneration = 0;
  private reconnectAttempt = 0;
  private replayComplete = false;
  private refreshAttemptedSinceHelloOk = false;
  private readonly outboundAckDeadlines = new Map<string, OutboundAckDeadline>();
  private outboxReconciliationPending = false;
  private readonly inboundStreams = new Map<string, InboundStreamState>();

  constructor(options: ClawChatGatewayOptions) {
    this.options = options;
    this.accessToken = options.accessToken;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.timer = options.timer ?? DEFAULT_GATEWAY_TIMER;
    this.outboundAckDeadlineMs =
      options.outboundAckDeadlineMs ?? DEFAULT_OUTBOUND_ACK_DEADLINE_MS;
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
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearReplayIdleFallback();
    this.clearOutboundAckDeadlines();
    this.outboxReconciliationPending = false;
    this.clearAcknowledgementScheduling();
    clearInterval(this.ackHeartbeat);
    this.ackHeartbeat = undefined;
    this.flushAcknowledgement();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const { promise, resolve } = Promise.withResolvers<void>();
      socket.once("close", () => resolve());
      socket.close();
      await promise;
    }
    await this.frameQueue;
  }

  async send(message: unknown): Promise<void> {
    const envelope = cloneOutboundEnvelope(message);
    if (envelope.event === "message.reply" || envelope.event === "message.send") {
      const traceId = requireString(envelope.trace_id, "trace_id");
      const payload = envelope.payload ?? {};
      envelope.payload = payload;
      if (typeof payload.message_id !== "string" || payload.message_id.length === 0) {
        payload.message_id = createProtocolMessageId(this.now());
      }
      const pending = this.options.store.enqueueOutbound({
        traceId,
        chatId: requireString(envelope.chat_id, "chat_id"),
        frame: envelope
      });
      this.sendApplicationFrame(pending.serializedFrame, traceId);
      return;
    }
    if (envelope.event === "typing.update") {
      this.sendRaw(envelope);
      return;
    }
    if (envelope.event === "message.reaction" || envelope.event === "history.transit") {
      if (envelope.event === "history.transit") {
        requireString(envelope.target_device_id, "target_device_id");
        requireString(envelope.origin_device_id, "origin_device_id");
        if (!isUnknownRecord(envelope.sender)) throw new Error("Outbound frame missing sender");
        requireString(envelope.sender.id, "sender.id");
      }
      if (this.socket?.readyState !== WebSocket.OPEN) {
        throw new Error(`Cannot send ${envelope.event} while the ClawChat Gateway is disconnected`);
      }
      this.sendRaw(envelope);
      return;
    }
    throw new Error(`Unsupported outbound event '${envelope.event}'`);
  }

  private openConnection(): Promise<void> {
    this.resetAcknowledgementState();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = new WebSocket(this.options.websocketUrl);
    this.socket = socket;
    this.frameQueue = Promise.resolve();
    this.clearReplayIdleFallback();
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
      if (ready && !this.replayComplete) this.armReplayIdleFallback();
      this.frameQueue = this.frameQueue
        .then(() =>
          this.handleRawFrame(raw, {
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
      this.resetAcknowledgementState();
      if (ready && this.options.store.listPendingOutbound().length > 0) {
        this.outboxReconciliationPending = true;
      }
      this.clearOutboundAckDeadlines();
      this.clearReplayIdleFallback();
      if (!ready) reject(new ReconnectableHandshakeError("ClawChat WebSocket closed before hello-ok"));
      if (!this.stopping) {
        this.options.onStatus?.("disconnected");
        if (ready) this.scheduleReconnect();
      }
    });
    return promise;
  }

  private async handleRawFrame(
    raw: WebSocket.RawData,
    handshake: { ready: () => void; reject: (error: Error) => void }
  ): Promise<void> {
    const rawText = raw.toString();
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawText) as unknown;
    } catch (error: unknown) {
      const reason = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
      this.options.store.quarantineRawInbound({
        event: "<invalid-json>",
        reason,
        frame: rawText
      });
      this.options.onStatus?.("quarantined non-ackable invalid JSON frame");
      throw new ReconnectableProtocolError(reason);
    }
    if (!isUnknownRecord(decoded)) {
      const reason = "invalid outer envelope: expected a JSON object";
      this.options.store.quarantineRawInbound({
        event: "<invalid-envelope>",
        reason,
        frame: decoded
      });
      this.options.onStatus?.("quarantined non-ackable invalid outer envelope");
      throw new ReconnectableProtocolError(reason);
    }

    if (this.ackMode === "dseq" && Object.hasOwn(decoded, "dseq")) {
      const dseq = decoded.dseq;
      if (typeof dseq !== "number" || !Number.isSafeInteger(dseq) || dseq < 1) {
        const reason = `untrusted dseq ${String(dseq)}`;
        this.options.store.quarantineRawInbound({
          event: eventLabel(decoded.event),
          reason,
          frame: decoded
        });
        this.options.onStatus?.("quarantined non-ackable frame with untrusted dseq");
        throw new ReconnectableProtocolError(reason);
      }
      await this.handleDseqFrame(decoded, dseq);
      return;
    }

    let envelope: ProtocolEnvelope;
    try {
      envelope = mapProtocolEnvelope(decoded);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.store.quarantineRawInbound({
        event: eventLabel(decoded.event),
        reason,
        frame: decoded
      });
      this.options.onStatus?.("quarantined non-ackable invalid outer envelope");
      throw new ReconnectableProtocolError(reason);
    }
    if (this.ackMode === "dseq" && isReliableDeliveryEvent(envelope.event)) {
      const reason = `reliable ${envelope.event} frame has no trustworthy dseq`;
      this.options.store.quarantineRawInbound({
        event: envelope.event,
        reason,
        frame: decoded
      });
      this.options.onStatus?.("quarantined non-ackable reliable frame without dseq");
      throw new ReconnectableProtocolError(reason);
    }
    await this.handleFrame(envelope, handshake);
  }

  private async handleFrame(
    envelope: ProtocolEnvelope,
    handshake: { ready: () => void; reject: (error: Error) => void }
  ): Promise<void> {
    if (envelope.event === "connect.challenge") {
      this.sendRaw({
        version: "2",
        event: "connect",
        trace_id: `connect-${this.idFactory()}`,
        emitted_at: this.now(),
        payload: {
          token: this.accessToken,
          nonce: typeof envelope.payload?.nonce === "string" ? envelope.payload.nonce : "",
          device_id: this.options.deviceId,
          capabilities: {
            multi_device: true,
            device_replay: true,
            ...(this.options.onAwarenessSignal
              ? { chat_meta_events: true, notify_signals: true }
              : {}),
            ...(this.options.onDeliveryReceipt ? { delivery_receipt: true } : {}),
            ...(this.options.onHistoryTransit ? { history_sync: true } : {}),
            reliable_delivery: true,
            reliable_delivery_v2: true
          }
        }
      });
      return;
    }
    if (envelope.event === "hello-ok") {
      this.resetAcknowledgementState();
      this.refreshAttemptedSinceHelloOk = false;
      if (
        envelope.payload?.ack_mode === "dseq" &&
        typeof envelope.payload.ack_epoch === "string" &&
        envelope.payload.ack_epoch.length > 0
      ) {
        this.ackMode = "dseq";
        this.ackEpoch = envelope.payload.ack_epoch;
        const durableHighWater = this.options.store.getReliableHighWater(this.ackEpoch);
        this.lastReadDseq = durableHighWater;
        this.ackHighWater = durableHighWater;
      } else {
        this.ackMode = "cursor";
        this.ackEpoch = undefined;
      }
      const ackGeneration = this.ackGeneration;
      this.ackHeartbeat = setInterval(() => {
        if (ackGeneration === this.ackGeneration) this.flushAcknowledgement();
      }, this.options.ackHeartbeatMs ?? 30_000);
      handshake.ready();
      setImmediate(() => {
        if (this.stopping) return;
        void Promise.resolve()
          .then(() => this.options.onConnectionReady?.())
          .catch((error: unknown) => {
            this.options.onStatus?.(
              `connection-ready observer failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
      });
      this.armReplayIdleFallback();
      return;
    }
    if (envelope.event === "hello-fail") {
      const reason =
        typeof envelope.payload?.reason === "string" ? envelope.payload.reason : "unknown reason";
      if (reason === "remote auth service unavailable") {
        handshake.reject(new TransientHandshakeError(`ClawChat hello failed: ${reason}`));
      } else if (
        reason === "authentication failed" &&
        this.options.refreshAccessToken &&
        !this.refreshAttemptedSinceHelloOk
      ) {
        this.refreshAttemptedSinceHelloOk = true;
        try {
          this.accessToken = await this.options.refreshAccessToken();
          handshake.reject(new ReconnectableHandshakeError("ClawChat token refreshed"));
        } catch (error: unknown) {
          handshake.reject(
            new Error(
              `ClawChat token refresh failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
      } else if (reason === "nonce mismatch") {
        handshake.reject(new ReconnectableHandshakeError(`ClawChat hello failed: ${reason}`));
      } else if (
        reason === "authentication failed" ||
        reason === "invalid connect event" ||
        reason === "invalid connect payload"
      ) {
        handshake.reject(new Error(`ClawChat hello failed: ${reason}`));
      } else {
        handshake.reject(new TransientHandshakeError(`ClawChat hello failed: ${reason}`));
      }
      this.socket?.terminate();
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
      if (typeof envelope.trace_id === "string") {
        this.cancelOutboundAckDeadline(envelope.trace_id);
        this.options.store.acknowledgeOutbound(envelope.trace_id);
      }
      return;
    }
    if (envelope.event === "message.error") {
      const code = envelope.payload?.code;
      if (typeof envelope.trace_id === "string" && typeof code === "string") {
        this.cancelOutboundAckDeadline(envelope.trace_id);
        const reason =
          typeof envelope.payload?.reason === "string" ? envelope.payload.reason : undefined;
        this.options.store.failOutbound(envelope.trace_id, code, reason);
        this.options.onStatus?.(`outbound ${envelope.trace_id} failed: ${code}`);
      }
      return;
    }
    if (envelope.event === "chat.metadata.invalidated") {
      await this.options.onAwarenessSignal?.(envelope);
      return;
    }
    if (envelope.event === "message.delivered") {
      await this.options.onDeliveryReceipt?.(envelope);
      return;
    }
    if (
      envelope.event === "message.created" ||
      envelope.event === "message.add" ||
      envelope.event === "message.done" ||
      envelope.event === "message.failed"
    ) {
      await this.handleInboundStream(envelope);
      return;
    }

    if (envelope.event === "history.truncated") {
      try {
        await this.persistReliableInbound(envelope);
      } catch (error: unknown) {
        this.options.onStatus?.(
          `ignored invalid history.truncated boundary: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
      if (this.ackMode === "cursor" && typeof envelope.seq === "number") {
        this.ackHighWater = Math.max(this.ackHighWater, envelope.seq);
        this.scheduleAcknowledgement();
      }
      return;
    }

    if (this.ackMode === "cursor" && typeof envelope.seq === "number") {
      await this.persistReliableInbound(envelope);
      this.ackHighWater = Math.max(this.ackHighWater, envelope.seq);
      this.scheduleAcknowledgement(envelope.event === "replay.done");
      if (envelope.event === "replay.done") this.completeReplay();
      return;
    }
    if (envelope.event === "replay.done") {
      this.completeReplay();
      return;
    }
    if (envelope.event === "notify.signal" || envelope.event === "history.transit") {
      await this.persistReliableInbound(envelope);
      return;
    }
    if (envelope.event === "message.send" || envelope.event === "message.reply") {
      await this.persistInboundMessage(envelope);
    }
  }

  private async handleDseqFrame(decoded: Record<string, unknown>, dseq: number): Promise<void> {
    if (dseq <= this.lastReadDseq) {
      this.ackHighWater = Math.max(this.ackHighWater, this.lastReadDseq);
      this.scheduleAcknowledgement();
      return;
    }
    if (dseq !== this.lastReadDseq + 1) {
      throw new Error(`expected dseq ${this.lastReadDseq + 1}, received ${dseq}`);
    }
    this.lastReadDseq = dseq;
    let envelope: ProtocolEnvelope | undefined;
    try {
      envelope = mapProtocolEnvelope(decoded);
      await this.persistReliableInbound(envelope, dseq);
      this.options.store.advanceReliableHighWater(this.ackEpoch!, dseq);
    } catch (error: unknown) {
      this.options.store.quarantineReliableInbound({
        ackEpoch: this.ackEpoch!,
        dseq,
        event: eventLabel(decoded.event),
        reason: error instanceof Error ? error.message : String(error),
        frame: decoded
      });
      this.options.onStatus?.(`quarantined dseq ${dseq}`);
    }
    this.ackHighWater = dseq;
    this.scheduleAcknowledgement(envelope?.event === "replay.done");
    if (envelope?.event === "replay.done") this.completeReplay();
  }

  private async persistReliableInbound(envelope: ProtocolEnvelope, dseq?: number): Promise<void> {
    if (envelope.event === "message.send" || envelope.event === "message.reply") {
      await this.persistInboundMessage(envelope);
      return;
    }
    if (envelope.event === "history.transit") {
      const traceId = requireString(envelope.trace_id, "trace_id");
      const inserted = this.options.store.persistReliableFrame(
        `history:${traceId}`,
        envelope.event,
        envelope
      );
      if (inserted) await this.options.onHistoryTransit?.(envelope);
      return;
    }
    if (envelope.event === "notify.signal") {
      const eventId = requireString(envelope.payload?.event_id, "payload.event_id");
      const inserted = this.options.store.persistReliableFrame(
        `notify:${eventId}`,
        envelope.event,
        envelope
      );
      if (inserted) await this.options.onAwarenessSignal?.(envelope);
      return;
    }
    if (envelope.event === "history.truncated") {
      const oldestSeq = envelope.payload?.oldest_seq;
      if (typeof oldestSeq !== "number" || !Number.isSafeInteger(oldestSeq) || oldestSeq < 1) {
        throw new Error("oldest_seq must be a positive integer");
      }
      this.options.store.recordInboxHistoryBoundary(oldestSeq, this.now());
      const boundary = this.options.store.getInboxHistoryBoundary()!;
      this.options.onStatus?.(
        `inbox history before sequence ${boundary.oldestSeq} is unavailable`
      );
      return;
    }

    if (envelope.event === "sync.mark" || envelope.event === "replay.done") return;
    if (
      envelope.event === "message.created" ||
      envelope.event === "message.add" ||
      envelope.event === "message.done" ||
      envelope.event === "message.failed"
    ) {
      await this.handleInboundStream(envelope);
      return;
    }
    const dedupeKey =
      dseq === undefined
        ? `event:${requireString(envelope.trace_id, "trace_id")}`
        : `dseq:${this.ackEpoch}:${dseq}`;
    if (envelope.event === "chat.metadata.invalidated") {
      const inserted = this.options.store.persistReliableFrame(dedupeKey, envelope.event, envelope);
      if (inserted) await this.options.onAwarenessSignal?.(envelope);
      return;
    }
    if (envelope.event === "message.delivered") {
      const inserted = this.options.store.persistReliableFrame(dedupeKey, envelope.event, envelope);
      if (inserted) await this.options.onDeliveryReceipt?.(envelope);
      return;
    }
    this.options.store.persistReliableFrame(dedupeKey, envelope.event, envelope);
  }

  private async persistInboundMessage(
    envelope: ProtocolEnvelope | ClawchatInboundMessage,
    emitReceipt = true
  ): Promise<void> {
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
    if (!ownMessage && emitReceipt) this.sendDeliveryReceipt(envelope);
    if (admission.status !== "accepted") return;
    if (decision.control) {
      await this.options.onAcceptedControl?.(envelope, decision);
    } else if (decision.dispatch) {
      await this.options.onInboundMessage(envelope);
    }
  }

  private async handleInboundStream(envelope: ProtocolEnvelope): Promise<void> {
    const messageId = requireString(envelope.payload?.message_id, "payload.message_id");
    if (envelope.event === "message.created") {
      this.inboundStreams.set(messageId, {
        chatId: requireString(envelope.chat_id, "chat_id"),
        chatType: requireChatType(envelope.chat_type),
        sender: requirePeer(envelope.sender),
        messageMode: envelope.payload?.message_mode,
        nextSequence: 0
      });
      return;
    }
    const stream = this.inboundStreams.get(messageId);
    if (!stream) {
      this.options.onStatus?.(`ignored ${envelope.event} for unknown stream ${messageId}`);
      return;
    }
    if (envelope.event === "message.failed") {
      this.inboundStreams.delete(messageId);
      return;
    }
    if (envelope.event === "message.add") {
      const sequence = envelope.payload?.sequence;
      if (sequence !== stream.nextSequence) {
        this.inboundStreams.delete(messageId);
        this.options.onStatus?.(
          `dropped stream ${messageId}: expected sequence ${stream.nextSequence}, received ${String(sequence)}`
        );
        return;
      }
      if (!Array.isArray(envelope.payload?.fragments)) {
        this.inboundStreams.delete(messageId);
        this.options.onStatus?.(`dropped stream ${messageId}: invalid fragments`);
        return;
      }
      stream.nextSequence += 1;
      return;
    }

    this.inboundStreams.delete(messageId);
    const fragments = parseStreamFragments(envelope.payload?.fragments);
    if (!fragments) {
      this.options.onStatus?.(`dropped stream ${messageId}: invalid final fragments`);
      return;
    }
    const materialized: ClawchatInboundMessage = {
      version: "2",
      event: "message.send",
      trace_id: requireString(envelope.trace_id, "trace_id"),
      emitted_at: typeof envelope.emitted_at === "number" ? envelope.emitted_at : this.now(),
      chat_id: stream.chatId,
      chat_type: stream.chatType,
      sender: stream.sender,
      payload: {
        message_id: messageId,
        ...(typeof stream.messageMode === "string" ? { message_mode: stream.messageMode } : {}),
        message: {
          body: { fragments },
          context: { mentions: [], reply: null },
          streaming: {
            status: "static",
            sequence: Math.max(0, stream.nextSequence - 1),
            mutation_policy: "sealed"
          }
        }
      }
    };
    await this.persistInboundMessage(materialized, false);
  }

  private sendDeliveryReceipt(message: ClawchatInboundMessage): void {
    this.sendRaw({
      version: "2",
      event: "message.delivered",
      trace_id: `delivered-${this.idFactory()}`,
      emitted_at: this.now(),
      chat_id: message.chat_id,
      to: { id: message.sender.id, type: "direct" },
      payload: {
        message_id: message.payload.message_id,
        delivered_at: this.now()
      }
    });
  }

  private armReplayIdleFallback(): void {
    if (this.replayComplete || this.stopping) return;
    clearTimeout(this.replayIdleTimer);
    const generation = ++this.replayIdleGeneration;
    const enqueueCompletion = () => {
      if (generation !== this.replayIdleGeneration || this.replayComplete || this.stopping) return;
      this.replayIdleTimer = undefined;
      this.frameQueue = this.frameQueue.then(() => {
        if (generation === this.replayIdleGeneration && !this.replayComplete && !this.stopping) {
          this.completeReplay();
        }
      });
    };
    const timeout = this.options.replayIdleTimeoutMs ?? 5_000;
    if (timeout === 0) {
      queueMicrotask(enqueueCompletion);
    } else {
      this.replayIdleTimer = setTimeout(enqueueCompletion, timeout);
    }
  }

  private clearReplayIdleFallback(): void {
    this.replayIdleGeneration += 1;
    clearTimeout(this.replayIdleTimer);
    this.replayIdleTimer = undefined;
  }

  private completeReplay(): void {
    if (this.replayComplete) return;
    this.clearReplayIdleFallback();
    this.reconnectAttempt = 0;
    this.replayComplete = true;
    this.reconcileOutboxAfterReplay();
  }

  private scheduleAcknowledgement(immediate = false): void {
    if (immediate || (this.options.ackDebounceMs ?? 200) === 0) {
      this.flushAcknowledgement();
      return;
    }
    if (!this.ackImmediate) {
      const generation = this.ackGeneration;
      this.ackImmediate = setImmediate(() => {
        if (generation !== this.ackGeneration) return;
        this.ackImmediate = undefined;
        this.flushAcknowledgement();
      });
    }
    if (this.ackTimer) return;
    const generation = this.ackGeneration;
    this.ackTimer = setTimeout(() => {
      if (generation !== this.ackGeneration) return;
      this.ackTimer = undefined;
      this.flushAcknowledgement();
    }, this.options.ackDebounceMs ?? 200);
  }

  private clearAcknowledgementScheduling(): void {
    this.ackGeneration += 1;
    clearImmediate(this.ackImmediate);
    this.ackImmediate = undefined;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
  }

  private resetAcknowledgementState(): void {
    this.clearAcknowledgementScheduling();
    clearInterval(this.ackHeartbeat);
    this.ackHeartbeat = undefined;
    this.ackMode = "legacy";
    this.ackEpoch = undefined;
    this.lastReadDseq = 0;
    this.ackHighWater = 0;
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

  private reconcileOutboxAfterReplay(): void {
    const pending = this.options.store.listPendingOutbound();
    if (this.outboxReconciliationPending) {
      this.outboxReconciliationPending = false;
      for (const record of pending) {
        this.sendApplicationFrame(record.serializedFrame, record.traceId);
      }
      return;
    }
    for (const record of pending) {
      if (record.lastAttemptAt === null) {
        this.sendApplicationFrame(record.serializedFrame, record.traceId);
      } else {
        this.armOutboundAckDeadline(record.traceId, record.lastAttemptAt);
      }
    }
  }

  private sendApplicationFrame(serializedFrame: string, traceId: string): void {
    const socket = this.socket;
    if (!this.replayComplete || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(serializedFrame);
    const attemptedAt = this.now();
    this.options.store.recordOutboundAttempt(traceId, attemptedAt);
    this.armOutboundAckDeadline(traceId, attemptedAt);
  }

  private armOutboundAckDeadline(traceId: string, attemptedAt: number): void {
    this.cancelOutboundAckDeadline(traceId);
    const deadline: OutboundAckDeadline = { handle: undefined };
    this.outboundAckDeadlines.set(traceId, deadline);
    const delayMs = Math.max(0, attemptedAt + this.outboundAckDeadlineMs - this.now());
    deadline.handle = this.timer.schedule(() => {
      if (this.outboundAckDeadlines.get(traceId) !== deadline) return;
      this.outboundAckDeadlines.delete(traceId);
      this.handleOutboundAckDeadline();
    }, delayMs);
  }

  private cancelOutboundAckDeadline(traceId: string): void {
    const deadline = this.outboundAckDeadlines.get(traceId);
    if (!deadline) return;
    this.outboundAckDeadlines.delete(traceId);
    if (deadline.handle !== undefined) this.timer.cancel(deadline.handle);
  }

  private clearOutboundAckDeadlines(): void {
    for (const deadline of this.outboundAckDeadlines.values()) {
      if (deadline.handle !== undefined) this.timer.cancel(deadline.handle);
    }
    this.outboundAckDeadlines.clear();
  }

  private handleOutboundAckDeadline(): void {
    if (this.stopping || this.outboxReconciliationPending) return;
    const now = this.now();
    const expired = this.options.store
      .listPendingOutbound()
      .filter(
        (record) =>
          record.lastAttemptAt !== null &&
          record.lastAttemptAt + this.outboundAckDeadlineMs <= now
      );
    if (expired.length === 0) return;
    this.outboxReconciliationPending = true;
    this.clearOutboundAckDeadlines();
    this.options.onStatus?.(
      `${expired.length} outbound message${expired.length === 1 ? "" : "s"} exceeded the ACK deadline; closing the socket to reconcile after replay`
    );
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
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
        if (error instanceof ReconnectableHandshakeError) this.scheduleReconnect();
      });
    }, delay);
  }

  private sendRaw(frame: ProtocolEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }
}
function mapProtocolEnvelope(value: Record<string, unknown>): ProtocolEnvelope {
  if (value.version !== "2") throw new Error("invalid outer envelope version");
  if (typeof value.event !== "string" || value.event.length === 0) {
    throw new Error("invalid outer envelope event");
  }
  if (value.payload !== undefined && !isUnknownRecord(value.payload)) {
    throw new Error("invalid outer envelope payload");
  }
  return value as ProtocolEnvelope;
}

function eventLabel(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "<invalid-event>";
}

function isReliableDeliveryEvent(event: string): boolean {
  return (
    event === "message.send" ||
    event === "message.reply" ||
    event === "history.transit" ||
    event === "notify.signal" ||
    event === "sync.mark" ||
    event === "replay.done" ||
    event === "history.truncated"
  );
}

function isInboundMessage(
  envelope: ProtocolEnvelope | ClawchatInboundMessage
): envelope is ClawchatInboundMessage {
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

function requireChatType(value: unknown): "direct" | "group" {
  if (value !== "direct" && value !== "group") throw new Error("invalid chat_type");
  return value;
}

function requirePeer(value: unknown): ClawchatPeer {
  if (!isUnknownRecord(value)) throw new Error("invalid sender");
  return {
    id: requireString(value.id, "sender.id"),
    type: requireChatType(value.type),
    ...(typeof value.nick_name === "string" ? { nick_name: value.nick_name } : {})
  };
}

function parseStreamFragments(value: unknown): ClawchatFragment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fragments: ClawchatFragment[] = [];
  for (const candidate of value) {
    if (!isUnknownRecord(candidate) || typeof candidate.kind !== "string") return undefined;
    if (candidate.kind === "text") {
      if (typeof candidate.text !== "string") return undefined;
      fragments.push({ kind: "text", text: candidate.text });
      continue;
    }
    if (candidate.kind === "mention") {
      fragments.push({
        kind: "mention",
        ...(typeof candidate.user_id === "string" ? { user_id: candidate.user_id } : {}),
        ...(typeof candidate.display === "string" ? { display: candidate.display } : {})
      });
      continue;
    }
    if (
      candidate.kind !== "image" &&
      candidate.kind !== "file" &&
      candidate.kind !== "audio" &&
      candidate.kind !== "video"
    ) {
      return undefined;
    }
    if (typeof candidate.url !== "string") return undefined;
    fragments.push({
      kind: candidate.kind,
      url: candidate.url,
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      ...(typeof candidate.mime === "string" ? { mime: candidate.mime } : {}),
      ...(typeof candidate.size === "number" ? { size: candidate.size } : {}),
      ...(typeof candidate.width === "number" ? { width: candidate.width } : {}),
      ...(typeof candidate.height === "number" ? { height: candidate.height } : {}),
      ...(typeof candidate.duration === "number" ? { duration: candidate.duration } : {})
    });
  }
  return fragments;
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

class ReconnectableProtocolError extends ReconnectableHandshakeError {}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
