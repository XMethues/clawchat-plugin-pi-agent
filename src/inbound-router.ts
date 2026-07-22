import type { GatewayStore } from "./gateway-store.js";
import { extractInboundText } from "./inbound.js";
import type { ClawchatInboundMessage } from "./types.js";

export type InboundControl =
  | { type: "group"; value: "mention" | "all" | "muted" }
  | { type: "tools"; value: "on" | "off" | "inherit" };

export interface InboundDecision {
  dispatch: boolean;
  control?: InboundControl;
}

export interface ClawchatInboundRouterOptions {
  store: GatewayStore;
  agentUserId: string;
  reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  toolCallsDefault?: "on" | "off";
  onToolOutputChanged?: (chatId: string) => Promise<void> | void;
}

export class ClawchatInboundRouter {
  private readonly store: GatewayStore;
  private readonly agentUserId: string;
  private readonly reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  private readonly toolCallsDefault: "on" | "off";
  private readonly onToolOutputChanged: ((chatId: string) => Promise<void> | void) | undefined;

  constructor(options: ClawchatInboundRouterOptions) {
    this.store = options.store;
    this.agentUserId = options.agentUserId;
    this.reply = options.reply;
    this.toolCallsDefault = options.toolCallsDefault ?? "off";
    this.onToolOutputChanged = options.onToolOutputChanged;
  }

  classify(message: ClawchatInboundMessage): InboundDecision {
    const text = extractInboundText(message);
    if (!text) return { dispatch: false };

    const groupCommand = /^\/clawchat-group\s+(mention|all|muted)\s*$/i.exec(text);
    if (groupCommand) {
      return {
        dispatch: false,
        control: { type: "group", value: groupCommand[1]!.toLowerCase() as "mention" | "all" | "muted" }
      };
    }
    const toolsCommand = /^\/clawchat-output\s+tools\s+(on|off|inherit)\s*$/i.exec(text);
    if (toolsCommand) {
      return {
        dispatch: false,
        control: { type: "tools", value: toolsCommand[1]!.toLowerCase() as "on" | "off" | "inherit" }
      };
    }

    if (message.chat_type === "direct") return { dispatch: true };
    const mode = this.store.getGroupDispatchMode(message.chat_id);
    if (mode === "all") return { dispatch: true };
    if (mode === "muted") return { dispatch: false };
    return { dispatch: hasStructuredMention(message, this.agentUserId) };
  }

  async applyAcceptedControl(message: ClawchatInboundMessage, decision: InboundDecision): Promise<void> {
    const control = decision.control;
    if (!control) return;
    if (control.type === "group") {
      if (message.chat_type !== "group") {
        await this.reply(message, "/clawchat-group is available only in group chats.");
        return;
      }
      this.store.setGroupDispatchMode(message.chat_id, control.value);
      await this.reply(message, `ClawChat group dispatch: ${control.value}.`);
      return;
    }

    this.store.setToolOutputOverride(message.chat_id, control.value);
    await this.onToolOutputChanged?.(message.chat_id);
    const override = this.store.getToolOutputOverrides()[message.chat_id];
    const effective = override ?? this.toolCallsDefault;
    await this.reply(
      message,
      `ClawChat tool output: ${control.value} (effective: ${effective}).`
    );
  }
}

function hasStructuredMention(message: ClawchatInboundMessage, userId: string): boolean {
  const mentions = message.payload.message.context?.mentions;
  if (!Array.isArray(mentions)) return false;
  return mentions.some(
    (mention) =>
      Boolean(mention) &&
      typeof mention === "object" &&
      "id" in mention &&
      (mention as { id?: unknown }).id === userId
  );
}
