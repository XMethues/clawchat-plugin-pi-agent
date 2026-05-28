import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activateClawchat, type ActivateClawchatOptions, type ActivationResult } from "./activation.js";
import { renderInboundPrompt } from "./adapter.js";
import { DEFAULT_BASE_URL, DEFAULT_WEBSOCKET_URL } from "./config.js";
import { loadClawchatState, saveClawchatState, type ClawchatState } from "./state.js";
import type {
  ClawchatInboundMessage,
  ClawchatOutboundMessage,
  ClawchatTransport,
  PiAgentSessionEvent
} from "./types.js";
import { ClawchatWebSocketClient, type ClawchatWebSocketClientOptions } from "./ws-client.js";

interface ClawchatExtensionClient extends ClawchatTransport {
  connect(): Promise<void>;
  close(): void;
}

interface ActiveReply {
  chatId: string;
  inboundMessageId: string;
  outboundMessageId: string;
  created: boolean;
}

export interface ClawchatPiExtensionOptions {
  activate?: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  loadState?: () => Promise<ClawchatState | null>;
  saveState?: (state: ClawchatState | ActivationResult, options?: { websocketUrl?: string }) => Promise<string>;
  clientFactory?: (options: ClawchatWebSocketClientOptions) => ClawchatExtensionClient;
  now?: () => number;
  idFactory?: () => string;
}

export function createClawchatPiExtension(options: ClawchatPiExtensionOptions = {}) {
  return function clawchatPiExtension(pi: ExtensionAPI): void {
    const bridge = new ClawchatPiExtensionBridge(pi, options);

    pi.registerCommand("clawchat-activate", {
      description: "Activate ClawChat with an invite code",
      handler: async (args, ctx) => {
        await bridge.activate(args, ctx);
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      await bridge.start(ctx);
    });
    pi.on("session_shutdown", () => {
      bridge.stop();
    });
    pi.on("message_update", async (event) => {
      await bridge.handlePiEvent(event as unknown as PiAgentSessionEvent);
    });
    pi.on("message_end", async (event) => {
      await bridge.handlePiEvent(event as unknown as PiAgentSessionEvent);
    });
  };
}

class ClawchatPiExtensionBridge {
  private readonly pi: ExtensionAPI;
  private readonly activateFn: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  private readonly loadStateFn: () => Promise<ClawchatState | null>;
  private readonly saveStateFn: (state: ClawchatState | ActivationResult, options?: { websocketUrl?: string }) => Promise<string>;
  private readonly clientFactory: (options: ClawchatWebSocketClientOptions) => ClawchatExtensionClient;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private ctx: ExtensionContext | undefined;
  private client: ClawchatExtensionClient | undefined;
  private activeReply: ActiveReply | undefined;

  constructor(pi: ExtensionAPI, options: ClawchatPiExtensionOptions) {
    this.pi = pi;
    this.activateFn = options.activate ?? activateClawchat;
    this.loadStateFn = options.loadState ?? loadClawchatState;
    this.saveStateFn = options.saveState ?? saveClawchatState;
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) => {
        return new ClawchatWebSocketClient(clientOptions);
      });
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async activate(args: string, ctx: ExtensionContext): Promise<void> {
    const code = args.trim();
    if (!code) {
      ctx.ui.notify("Usage: /clawchat-activate <code>", "warning");
      return;
    }

    const result = await this.activateFn({
      code,
      baseUrl: process.env.CLAWCHAT_BASE_URL ?? DEFAULT_BASE_URL
    });
    await this.saveStateFn(result, {
      websocketUrl: process.env.CLAWCHAT_WS_URL ?? DEFAULT_WEBSOCKET_URL
    });
    ctx.ui.notify("ClawChat activated and saved.", "info");
    try {
      await this.start(ctx, { reconnect: true });
    } catch (error: unknown) {
      ctx.ui.notify(`ClawChat saved, but connection failed: ${errorMessage(error)}`, "warning");
    }
  }

  async start(ctx: ExtensionContext, options: { reconnect?: boolean } = {}): Promise<void> {
    this.ctx = ctx;
    if (this.client && !options.reconnect) return;
    if (this.client) this.stop();

    const state = await this.loadStateFn();
    if (!state?.accessToken) {
      ctx.ui.setStatus("clawchat", "not activated");
      return;
    }

    const client = this.clientFactory({
      websocketUrl: process.env.CLAWCHAT_WS_URL ?? state.websocketUrl ?? DEFAULT_WEBSOCKET_URL,
      accessToken: state.accessToken,
      deviceId: process.env.CLAWCHAT_DEVICE_ID ?? "clawchat-pi",
      onStatus: (message) => {
        setStatus(ctx, message);
      },
      onInboundMessage: async (message) => {
        await this.handleInboundMessage(message);
      }
    });
    this.client = client;
    await client.connect();
    setStatus(ctx, "connected");
  }

  stop(): void {
    this.client?.close();
    this.client = undefined;
    if (this.ctx) setStatus(this.ctx, undefined);
  }

  async handleInboundMessage(message: ClawchatInboundMessage): Promise<void> {
    const text = renderInboundPrompt(message);
    if (!text) return;

    const activeReply: ActiveReply = {
      chatId: message.chat_id,
      inboundMessageId: message.payload.message_id,
      outboundMessageId: this.idFactory(),
      created: false
    };
    this.activeReply = activeReply;
    const deliverAs = this.ctx?.isIdle() === false ? { deliverAs: "followUp" as const } : undefined;
    this.pi.sendUserMessage(text, deliverAs);
  }

  async handlePiEvent(event: PiAgentSessionEvent): Promise<void> {
    const reply = this.activeReply;
    if (!reply || !this.client) return;

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta" &&
      event.assistantMessageEvent.delta
    ) {
      if (!reply.created) {
        await this.send({
          event: "message.created",
          chat_id: reply.chatId,
          payload: {
            message_id: reply.outboundMessageId,
            reply_to_message_id: reply.inboundMessageId
          }
        });
        reply.created = true;
      }
      await this.send({
        event: "message.add",
        chat_id: reply.chatId,
        payload: {
          message_id: reply.outboundMessageId,
          fragments: [{ kind: "text", text: event.assistantMessageEvent.delta }]
        }
      });
      return;
    }

    if (event.type === "message_end" && reply.created) {
      await this.send({
        event: "message.done",
        chat_id: reply.chatId,
        payload: {
          message_id: reply.outboundMessageId
        }
      });
      this.activeReply = undefined;
    }
  }

  private async send(message: Pick<ClawchatOutboundMessage, "event" | "chat_id" | "payload">): Promise<void> {
    await this.client?.send({
      version: "2",
      trace_id: `pi-${this.idFactory()}`,
      emitted_at: this.now(),
      ...message
    });
  }
}

export default createClawchatPiExtension();

function setStatus(ctx: ExtensionContext, message: string | undefined): void {
  try {
    ctx.ui.setStatus?.("clawchat", message);
  } catch {
    // Pi can mark the session UI context stale while a websocket shutdown callback is still unwinding.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
