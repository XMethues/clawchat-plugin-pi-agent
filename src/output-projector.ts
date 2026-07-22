import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import type {
  ClawchatInboundMessage,
  ClawchatMessageMode,
  ClawchatOutboundContent,
  ClawchatOutboundMessage,
  ClawchatTransport,
  TextFragment
} from "./types.js";

export type PiOutputEvent = MessageEndEvent | ToolExecutionStartEvent | ToolExecutionEndEvent;

export interface OutputVisibility {
  thinking: boolean;
  tools: boolean;
}

export interface OutputTurn {
  chatId: string;
  chatType: ClawchatInboundMessage["chat_type"];
  inboundMessageId: string;
  sender: ClawchatInboundMessage["sender"];
  preview: TextFragment[];
}

export interface OutputProjectorOptions {
  transport: ClawchatTransport;
  now?: () => number;
  idFactory?: () => string;
}

export class ClawchatOutputProjector {
  private readonly transport: ClawchatTransport;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly toolArguments = new Map<string, unknown>();
  private activeTurn: OutputTurn | undefined;

  constructor(options: OutputProjectorOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async beginTurn(turn: OutputTurn): Promise<void> {
    if (this.activeTurn) throw new Error("A ClawChat output turn is already active");
    this.activeTurn = turn;
    await this.sendTyping(turn, true);
  }

  async handle(event: PiOutputEvent, visibility: OutputVisibility): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;

    if (event.type === "tool_execution_start") {
      this.toolArguments.set(event.toolCallId, event.args);
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.toolArguments.get(event.toolCallId);
      this.toolArguments.delete(event.toolCallId);
      if (visibility.tools) {
        await this.sendMaterialized(turn, formatToolOutput(event, args), "tool");
      }
      return;
    }

    if (event.message.role !== "assistant") return;

    if (visibility.thinking) {
      const thinking = event.message.content
        .flatMap((part) =>
          part.type === "thinking" && !part.redacted && part.thinking ? [part.thinking] : []
        )
        .join("\n\n");
      if (thinking) await this.sendMaterialized(turn, thinking, "thinking");
    }

    const text = event.message.content
      .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("\n\n");
    if (text) await this.sendMaterialized(turn, text, "normal");
  }

  async endTurn(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;
    try {
      await this.sendTyping(turn, false);
    } finally {
      this.activeTurn = undefined;
      this.toolArguments.clear();
    }
  }

  async replyTo(message: ClawchatInboundMessage, text: string, mode: ClawchatMessageMode = "normal"): Promise<void> {
    await this.sendMaterialized(outputTurnFromInbound(message), text, mode);
  }

  private async sendMaterialized(turn: OutputTurn, text: string, mode: ClawchatMessageMode): Promise<void> {
    await this.send({
      event: "message.reply",
      chat_id: turn.chatId,
      to: { id: turn.chatId, type: turn.chatType },
      payload: {
        message_mode: mode,
        message: {
          body: { fragments: [{ kind: "text", text }] },
          context: {
            mentions: [],
            reply: {
              reply_to_msg_id: turn.inboundMessageId,
              reply_preview: {
                id: turn.sender.id,
                ...(turn.sender.nick_name ? { nick_name: turn.sender.nick_name } : {}),
                fragments: turn.preview
              }
            }
          }
        }
      }
    });
  }

  private async sendTyping(turn: OutputTurn, isTyping: boolean): Promise<void> {
    await this.send({
      event: "typing.update",
      chat_id: turn.chatId,
      to: { id: turn.chatId, type: turn.chatType },
      payload: { is_typing: isTyping }
    });
  }

  private async send(message: ClawchatOutboundContent): Promise<void> {
    const envelope: ClawchatOutboundMessage = {
      version: "2",
      trace_id: `pi-${this.idFactory()}`,
      emitted_at: this.now(),
      ...message
    };
    await this.transport.send(envelope);
  }
}

export function outputTurnFromInbound(message: ClawchatInboundMessage): OutputTurn {
  return {
    chatId: message.chat_id,
    chatType: message.chat_type,
    inboundMessageId: message.payload.message_id,
    sender: message.sender,
    preview: trimPreview(message.payload.message.body.fragments)
  };
}

function trimPreview(fragments: TextFragment[]): TextFragment[] {
  const text = fragments.map((fragment) => fragment.text).join("").trim();
  if (!text) return [];
  return [{ kind: "text", text: text.length > 240 ? `${text.slice(0, 237)}...` : text }];
}

function formatToolOutput(event: ToolExecutionEndEvent, args: unknown): string {
  const sections = [`Tool: ${event.toolName}`];
  if (args !== undefined) sections.push(`Arguments:\n${formatValue(args)}`);
  sections.push(`${event.isError ? "Error" : "Result"}:\n${formatValue(event.result)}`);
  return sections.join("\n\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
