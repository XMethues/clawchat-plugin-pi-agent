import WebSocket from "ws";
import type { ClawchatInboundMessage, ClawchatOutboundMessage, ClawchatTransport } from "./types.js";

export interface ClawchatWebSocketClientOptions {
  websocketUrl: string;
  accessToken: string;
  deviceId?: string;
  onInboundMessage: (message: ClawchatInboundMessage) => Promise<void>;
  onStatus?: (message: string) => void;
}

interface ProtocolEnvelope {
  version: string;
  event: string;
  trace_id?: string;
  emitted_at?: number;
  payload?: Record<string, unknown>;
}

export class ClawchatWebSocketClient implements ClawchatTransport {
  private readonly options: ClawchatWebSocketClientOptions;
  private socket: WebSocket | undefined;

  constructor(options: ClawchatWebSocketClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.websocketUrl);
      this.socket = socket;

      socket.once("error", reject);
      socket.on("message", (data) => {
        void this.handleRawMessage(data, resolve);
      });
      socket.on("close", (code) => {
        this.options.onStatus?.(`ClawChat WebSocket closed with code ${code}`);
      });
    });
  }

  async send(message: ClawchatOutboundMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("ClawChat WebSocket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private async handleRawMessage(data: WebSocket.RawData, ready: () => void): Promise<void> {
    const envelope = parseEnvelope(data);
    if (!envelope) return;

    if (envelope.event === "connect.challenge") {
      this.sendConnect(envelope);
      return;
    }

    if (envelope.event === "hello-ok") {
      this.options.onStatus?.("ClawChat WebSocket ready");
      ready();
      return;
    }

    if (envelope.event === "ping") {
      await this.sendRaw({
        version: "2",
        event: "pong",
        trace_id: envelope.trace_id ?? `pong-${Date.now()}`,
        emitted_at: envelope.emitted_at ?? Date.now(),
        payload: {}
      });
      return;
    }

    if (envelope.event === "message.send" || envelope.event === "message.reply") {
      await this.options.onInboundMessage(envelope as unknown as ClawchatInboundMessage);
    }
  }

  private sendConnect(challenge: ProtocolEnvelope): void {
    const nonce = typeof challenge.payload?.nonce === "string" ? challenge.payload.nonce : "";
    void this.sendRaw({
      version: "2",
      event: "connect",
      trace_id: `connect-${Date.now()}`,
      emitted_at: Date.now(),
      payload: {
        token: this.options.accessToken,
        nonce,
        device_id: this.options.deviceId ?? "clawchat-pi",
        capabilities: {
          multi_device: true,
          device_replay: true,
          chat_meta_events: true
        }
      }
    });
  }

  private async sendRaw(message: ProtocolEnvelope): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}

function parseEnvelope(data: WebSocket.RawData): ProtocolEnvelope | undefined {
  try {
    const parsed = JSON.parse(data.toString()) as ProtocolEnvelope;
    return parsed.version === "2" && typeof parsed.event === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
