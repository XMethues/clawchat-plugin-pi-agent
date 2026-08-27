import type { GatewayStore, SessionCommand } from "./gateway-store.js";
import { classifyGroupMention, extractInboundText, hasMediaFragments } from "./inbound.js";
import { parseOutputModeCommand } from "./output-settings.js";
import type { ClawchatOutputMode, ClawchatOutputModeOverride } from "./output-settings.js";
import type { ClawchatInboundMessage } from "./types.js";

export type InboundControl =
  | { type: "group"; value: "mention" | "all" | "muted" }
  | { type: "output"; value: ClawchatOutputModeOverride }
  | { type: "denied"; command: string }
  | { type: "invalid"; usage: string };

export interface InboundDecision {
  dispatch: boolean;
  control?: InboundControl;
  sessionCommand?: SessionCommand;
  stop?: boolean;
}

export interface ClawchatInboundRouterOptions {
  store: GatewayStore;
  agentUserId: string;
  agentOwnerId: string;
  reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  modeDefault?: ClawchatOutputMode;
  onOutputModeChanged?: (chatId: string) => Promise<void> | void;
}

export class ClawchatInboundRouter {
  private readonly store: GatewayStore;
  private readonly agentUserId: string;
  private readonly agentOwnerId: string;
  private readonly reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  private readonly modeDefault: ClawchatOutputMode;
  private readonly onOutputModeChanged: ((chatId: string) => Promise<void> | void) | undefined;

  constructor(options: ClawchatInboundRouterOptions) {
    this.store = options.store;
    this.agentUserId = options.agentUserId;
    this.agentOwnerId = options.agentOwnerId;
    this.reply = options.reply;
    this.modeDefault = options.modeDefault ?? "normal";
    this.onOutputModeChanged = options.onOutputModeChanged;
  }

  classify(message: ClawchatInboundMessage): InboundDecision {
    const text = extractInboundText(message);
    const hasMedia = hasMediaFragments(message.payload.message.body.fragments);
    if (!text && !hasMedia) return { dispatch: false };

    const sessionDecision = parseSessionCommand(text);
    if (sessionDecision) {
      if (message.sender.id !== this.agentOwnerId) {
        return {
          dispatch: false,
          control: { type: "denied", command: sessionDecision.command }
        };
      }
      if ("invalidUsage" in sessionDecision) {
        return {
          dispatch: false,
          control: { type: "invalid", usage: sessionDecision.invalidUsage }
        };
      }
      if ("stop" in sessionDecision) return { dispatch: false, stop: true };
      return { dispatch: false, sessionCommand: sessionDecision.sessionCommand };
    }

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
    return { dispatch: classifyGroupMention(message, this.agentUserId) !== "none" };
  }

  async applyAcceptedControl(message: ClawchatInboundMessage, decision: InboundDecision): Promise<void> {
    const control = decision.control;
    if (!control) return;
    if (control.type === "denied") {
      await this.reply(message, `${control.command} is available only to the Agent owner.`);
      return;
    }
    if (control.type === "invalid") {
      await this.reply(message, control.usage);
      return;
    }
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

type ParsedSessionCommand =
  | { command: "/new" | "/session" | "/resume"; sessionCommand: SessionCommand }
  | { command: "/stop"; stop: true }
  | { command: "/new" | "/session" | "/resume" | "/stop"; invalidUsage: string };

function parseSessionCommand(text: string): ParsedSessionCommand | null {
  if (/^\/new\s*$/i.test(text)) {
    return { command: "/new", sessionCommand: { type: "new" } };
  }
  if (/^\/new(?:\s|$)/i.test(text)) {
    return { command: "/new", invalidUsage: "Usage: /new" };
  }
  if (/^\/session\s*$/i.test(text)) {
    return { command: "/session", sessionCommand: { type: "session" } };
  }
  if (/^\/session(?:\s|$)/i.test(text)) {
    return { command: "/session", invalidUsage: "Usage: /session" };
  }
  if (/^\/stop\s*$/i.test(text)) {
    return { command: "/stop", stop: true };
  }
  if (/^\/stop(?:\s|$)/i.test(text)) {
    return { command: "/stop", invalidUsage: "Usage: /stop" };
  }
  const resume = /^\/resume(?:\s+(.*?))?\s*$/i.exec(text);
  if (!resume) return null;
  const args = resume[1]?.trim() ?? "";
  if (!args) {
    return { command: "/resume", sessionCommand: { type: "resume-list", page: 1 } };
  }
  const list = /^list(?:\s+(\d+))?$/i.exec(args);
  if (list) {
    const page = list[1] ? Number(list[1]) : 1;
    if (Number.isSafeInteger(page) && page > 0) {
      return { command: "/resume", sessionCommand: { type: "resume-list", page } };
    }
  } else if (/^\S+$/.test(args)) {
    return { command: "/resume", sessionCommand: { type: "resume", sessionId: args } };
  }
  return {
    command: "/resume",
    invalidUsage: "Usage: /resume, /resume list <page>, or /resume <session-id>"
  };
}

