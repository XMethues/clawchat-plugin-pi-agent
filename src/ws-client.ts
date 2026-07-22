import { ClawChatGateway } from "./gateway.js";
import { GatewayStore } from "./gateway-store.js";
import { ClawchatInboundRouter } from "./inbound-router.js";
import { ClawchatOutputProjector } from "./output-projector.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage, ClawchatTransport } from "./types.js";

export interface ClawchatWebSocketClientOptions {
  websocketUrl: string;
  accessToken: string;
  deviceId: string;
  userId: string;
  gatewayStorePath: string;
  queueTurns?: boolean;
  routeInbound?: boolean;
  toolCallsDefault?: "on" | "off";
  onToolOutputChanged?: (chatId: string) => Promise<void> | void;
  onInboundMessage: (message: ClawchatInboundMessage) => Promise<void>;
  onStatus?: (message: string) => void;
}

export class ClawchatWebSocketClient implements ClawchatTransport {
  private readonly store: GatewayStore;
  private readonly gateway: ClawChatGateway;
  private closed = false;

  constructor(options: ClawchatWebSocketClientOptions) {
    this.store = GatewayStore.open(options.gatewayStorePath);
    let gateway: ClawChatGateway;
    const routeInbound = options.routeInbound
      ? new ClawchatInboundRouter({
          store: this.store,
          agentUserId: options.userId,
          toolCallsDefault: options.toolCallsDefault ?? "off",
          reply: async (message, text) => {
            const projector = new ClawchatOutputProjector({
              transport: { send: async (outbound) => gateway.send(outbound) }
            });
            await projector.replyTo(message, text);
          },
          ...(options.onToolOutputChanged
            ? { onToolOutputChanged: options.onToolOutputChanged }
            : {})
        })
      : undefined;
    gateway = new ClawChatGateway({
      websocketUrl: options.websocketUrl,
      accessToken: options.accessToken,
      deviceId: options.deviceId,
      userId: options.userId,
      store: this.store,
      onInboundMessage: options.onInboundMessage,
      queueTurns: options.queueTurns ?? false,
      ...(routeInbound
        ? {
            classifyInbound: (message) => routeInbound.classify(message),
            onAcceptedControl: (message, decision) =>
              routeInbound.applyAcceptedControl(message, decision)
          }
        : {}),
      reconnect: true,
      ...(options.onStatus ? { onStatus: options.onStatus } : {})
    });
    this.gateway = gateway;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("ClawChat WebSocket client is closed");
    await this.gateway.start();
  }

  async send(message: ClawchatOutboundMessage): Promise<void> {
    if (this.closed) throw new Error("ClawChat WebSocket client is closed");
    await this.gateway.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.gateway.stop();
    } finally {
      this.store.close();
    }
  }
}
