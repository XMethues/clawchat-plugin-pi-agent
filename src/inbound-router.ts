import type { GatewayStore } from "./gateway-store.js";
import { extractInboundText } from "./inbound.js";
import {
  parseOutputModeCommand,
  type ClawchatOutputMode,
  type ClawchatOutputModeOverride
} from "./output-settings.js";
import type { ClawchatInboundMessage } from "./types.js";

export type InboundControl =
  | { type: "group"; value: "mention" | "all" | "muted" }
  | { type: "output"; value: ClawchatOutputModeOverride };

export interface InboundDecision {
  dispatch: boolean;
  control?: InboundControl;
}

export interface ClawchatInboundRouterOptions {
  store: GatewayStore;
  agentUserId: string;
  reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  modeDefault?: ClawchatOutputMode;
  onOutputModeChanged?: (chatId: string) => Promise<void> | void;
}

export class ClawchatInboundRouter {
  private readonly store: GatewayStore;
  private readonly agentUserId: string;
  private readonly reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  private readonly modeDefault: ClawchatOutputMode;
  private readonly onOutputModeChanged: ((chatId: string) => Promise<void> | void) | undefined;

  constructor(options: ClawchatInboundRouterOptions) {
    this.store = options.store;
    this.agentUserId = options.agentUserId;
    this.reply = options.reply;
    this.modeDefault = options.modeDefault ?? "normal";
    this.onOutputModeChanged = options.onOutputModeChanged;
  }

  classify(message: ClawchatInboundMessage): InboundDecision {
    const text = extractInboundText(message);
    const hasMedia = message.payload.message.body.fragments.some(
      (fragment) =>
        fragment.kind === "image" ||
        fragment.kind === "file" ||
        fragment.kind === "audio" ||
        fragment.kind === "video"
    );
    if (!text && !hasMedia) return { dispatch: false };

    const groupCommand = /^\/clawchat-group\s+(mention|all|muted)\s*$/i.exec(text);
    if (groupCommand) {
      return {
        dispatch: false,
        control: { type: "group", value: groupCommand[1]!.toLowerCase() as "mention" | "all" | "muted" }
      };
    }
    const outputCommand = /^\/clawchat-output\s+(.+?)\s*$/i.exec(text);
    const outputMode = outputCommand ? parseOutputModeCommand(outputCommand[1]!) : undefined;
    if (outputMode) {
      return {
        dispatch: false,
        control: { type: "output", value: outputMode }
      };
    }
    if (/^\/clawchat-output(?:\s|$)/i.test(text)) return { dispatch: false };

    if (message.chat_type === "direct") return { dispatch: true };
    const mode = this.store.getGroupDispatchMode(message.chat_id);
    if (mode === "all") return { dispatch: true };
    if (mode === "muted") return { dispatch: false };
    return { dispatch: hasMention(message, this.agentUserId) };
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

    this.store.setOutputModeOverride(message.chat_id, control.value);
    await this.onOutputModeChanged?.(message.chat_id);
    const override = this.store.getOutputModeOverrides()[message.chat_id];
    const effective = override ?? this.modeDefault;
    await this.reply(
      message,
      `ClawChat output mode: effective ${effective}; profile default ${this.modeDefault}; override ${override ?? "inherit"}.`
    );
  }
}

function hasMention(message: ClawchatInboundMessage, userId: string): boolean {
  const mentions = message.payload.message.context?.mentions;
  if (!Array.isArray(mentions)) return false;
  return mentions.some((mention) => {
    if (typeof mention === "string") return mention === userId;
    if (!mention || typeof mention !== "object" || !("user_id" in mention)) return false;
    return mention.user_id === userId || mention.user_id === "all";
  });
}
