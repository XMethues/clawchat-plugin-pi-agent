import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import { activateClawchat, type ActivateClawchatOptions, type ActivationResult } from "./activation.js";
import { DEFAULT_BASE_URL, DEFAULT_WEBSOCKET_URL } from "./config.js";
import { extractInboundText, renderInboundPrompt } from "./inbound.js";
import {
  ClawchatOutputProjector,
  outputTurnFromInbound,
  type PiOutputEvent
} from "./output-projector.js";
import {
  parseToolOutputCommand,
  resolveToolOutput,
  withToolOutputOverride
} from "./output-settings.js";
import {
  getClawchatGatewayStorePath,
  loadClawchatState,
  prepareClawchatState,
  saveClawchatState,
  type ClawchatState,
  type PreparedClawchatState,
  type StatePathOptions
} from "./state.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage, ClawchatTransport } from "./types.js";
import { ClawchatWebSocketClient, type ClawchatWebSocketClientOptions } from "./ws-client.js";

interface ClawchatExtensionClient extends ClawchatTransport {
  connect(): Promise<void>;
  close(): Promise<void> | void;
}

export interface ClawchatPiExtensionOptions {
  activate?: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  prepareState?: (options: StatePathOptions) => Promise<PreparedClawchatState>;
  loadState?: () => Promise<ClawchatState | null>;
  saveState?: (
    state: ClawchatState | ActivationResult,
    options?: StatePathOptions & { websocketUrl?: string }
  ) => Promise<string>;
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

    pi.registerCommand("clawchat-output", {
      description: "Configure ClawChat output visibility for the current chat",
      handler: async (args, ctx) => {
        await bridge.configureOutput(args, ctx);
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      await bridge.start(ctx);
    });
    pi.on("session_shutdown", async () => {
      await bridge.stop();
    });
    pi.on("message_end", async (event) => {
      await bridge.handlePiEvent(event);
    });
    pi.on("tool_execution_start", async (event) => {
      await bridge.handlePiEvent(event);
    });
    pi.on("tool_execution_end", async (event) => {
      await bridge.handlePiEvent(event);
    });
    pi.on("agent_settled", async () => {
      await bridge.handleAgentSettled();
    });
  };
}

class ClawchatPiExtensionBridge {
  private readonly pi: ExtensionAPI;
  private readonly activateFn: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  private readonly prepareStateFn: (options: StatePathOptions) => Promise<PreparedClawchatState>;
  private readonly loadStateFn: () => Promise<ClawchatState | null>;
  private readonly saveStateFn: (
    state: ClawchatState | ActivationResult,
    options?: StatePathOptions & { websocketUrl?: string }
  ) => Promise<string>;
  private readonly clientFactory: (options: ClawchatWebSocketClientOptions) => ClawchatExtensionClient;
  private readonly projector: ClawchatOutputProjector;
  private ctx: ExtensionContext | undefined;
  private client: ClawchatExtensionClient | undefined;
  private state: ClawchatState | undefined;
  private activeMessage: ClawchatInboundMessage | undefined;
  private lastMessage: ClawchatInboundMessage | undefined;
  private readonly pendingMessages: ClawchatInboundMessage[] = [];

  constructor(pi: ExtensionAPI, options: ClawchatPiExtensionOptions) {
    this.pi = pi;
    this.activateFn = options.activate ?? activateClawchat;
    this.prepareStateFn = options.prepareState ?? prepareClawchatState;
    this.loadStateFn = options.loadState ?? loadClawchatState;
    this.saveStateFn = options.saveState ?? saveClawchatState;
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) => {
        return new ClawchatWebSocketClient(clientOptions);
      });
    this.projector = new ClawchatOutputProjector({
      transport: {
        send: async (message) => {
          if (!this.client) throw new Error("ClawChat client is not connected");
          await this.client.send(message);
        }
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {})
    });
  }

  async activate(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const code = args.trim();
    if (!code) {
      ctx.ui.notify("Usage: /clawchat-activate <code>", "warning");
      return;
    }

    const prepared = await this.prepareStateFn({ workspace: ctx.cwd });
    const result = await this.activateFn({
      code,
      baseUrl: process.env.CLAWCHAT_BASE_URL ?? DEFAULT_BASE_URL,
      deviceId: prepared.deviceId
    });
    await this.saveStateFn(result, {
      websocketUrl: process.env.CLAWCHAT_WS_URL ?? DEFAULT_WEBSOCKET_URL,
      workspace: prepared.workspace
    });
    ctx.ui.notify("ClawChat activated and saved.", "info");
    try {
      if (this.ctx) await this.start(this.ctx, { reconnect: true });
    } catch (error: unknown) {
      ctx.ui.notify(`ClawChat saved, but connection failed: ${errorMessage(error)}`, "warning");
    }
  }

  async configureOutput(
    args: string,
    ctx?: ExtensionCommandContext,
    inbound?: ClawchatInboundMessage
  ): Promise<void> {
    const override = parseToolOutputCommand(args);
    const target = inbound ?? this.lastMessage;
    if (!override) {
      await this.reportCommandResult(target, ctx, "Usage: /clawchat-output tools on|off|inherit", "warning");
      return;
    }
    if (!target) {
      ctx?.ui.notify("No ClawChat chat is associated with this Pi session yet.", "warning");
      return;
    }

    const state = this.state ?? (await this.loadStateFn());
    if (!state) {
      await this.reportCommandResult(target, ctx, "ClawChat is not activated.", "warning");
      return;
    }

    const nextState: ClawchatState = {
      ...state,
      output: withToolOutputOverride(state.output, target.chat_id, override)
    };
    await this.saveStateFn(nextState);
    this.state = nextState;

    const effective = resolveToolOutput(nextState.output, target.chat_id);
    await this.reportCommandResult(
      target,
      ctx,
      `ClawChat tool output: ${override} (effective: ${effective}).`,
      "info"
    );
  }

  async start(ctx: ExtensionContext, options: { reconnect?: boolean } = {}): Promise<void> {
    this.ctx = ctx;
    if (this.client && !options.reconnect) return;
    if (this.client) await this.stopClient();

    const state = await this.loadStateFn();
    if (!state?.accessToken) {
      ctx.ui.setStatus("clawchat", "not activated");
      return;
    }
    this.state = state;

    const client = this.clientFactory({
      websocketUrl: process.env.CLAWCHAT_WS_URL ?? state.websocketUrl ?? DEFAULT_WEBSOCKET_URL,
      accessToken: state.accessToken,
      deviceId: process.env.CLAWCHAT_DEVICE_ID ?? state.deviceId,
      userId: state.agent.userId,
      gatewayStorePath: getClawchatGatewayStorePath(),
      queueTurns: false,
      routeInbound: true,
      toolCallsDefault: state.output.toolCallsDefault,
      onToolOutputChanged: async () => {
        const refreshed = await this.loadStateFn();
        if (refreshed) this.state = refreshed;
      },
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

  async stop(): Promise<void> {
    try {
      await this.projector.endTurn();
    } finally {
      this.activeMessage = undefined;
      this.pendingMessages.length = 0;
      await this.stopClient();
    }
  }

  async handleInboundMessage(message: ClawchatInboundMessage): Promise<void> {
    const text = extractInboundText(message);
    if (!text) return;
    this.lastMessage = message;

    const outputCommand = /^\/clawchat-output(?:\s+(.*))?$/i.exec(text);
    if (outputCommand) {
      await this.configureOutput(outputCommand[1] ?? "", undefined, message);
      return;
    }

    this.pendingMessages.push(message);
    await this.dispatchNext();
  }

  async handlePiEvent(event: MessageEndEvent | ToolExecutionStartEvent | ToolExecutionEndEvent): Promise<void> {
    const active = this.activeMessage;
    if (!active || !this.state) return;
    await this.projector.handle(event as PiOutputEvent, {
      thinking: this.pi.getThinkingLevel() !== "off",
      tools: resolveToolOutput(this.state.output, active.chat_id) === "on"
    });
  }

  async handleAgentSettled(): Promise<void> {
    if (this.activeMessage) {
      await this.projector.endTurn();
      this.activeMessage = undefined;
    }
    await this.dispatchNext(true);
  }

  private async dispatchNext(force = false): Promise<void> {
    if (this.activeMessage || (!force && this.ctx?.isIdle() === false)) return;
    const message = this.pendingMessages.shift();
    if (!message) return;

    const prompt = renderInboundPrompt(message);
    if (!prompt) return;
    this.activeMessage = message;
    try {
      await this.projector.beginTurn(outputTurnFromInbound(message));
      this.pi.sendUserMessage(prompt);
    } catch (error) {
      await this.projector.endTurn();
      this.activeMessage = undefined;
      throw error;
    }
  }

  private async reportCommandResult(
    target: ClawchatInboundMessage | undefined,
    ctx: ExtensionCommandContext | undefined,
    text: string,
    level: "info" | "warning"
  ): Promise<void> {
    if (target && !ctx) {
      await this.projector.replyTo(target, text);
      return;
    }
    ctx?.ui.notify(text, level);
  }

  private async stopClient(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    if (this.ctx) setStatus(this.ctx, undefined);
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
