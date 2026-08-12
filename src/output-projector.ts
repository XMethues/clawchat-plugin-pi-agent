import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import type {
  ClawchatInboundMessage,
  ClawchatMessageMode,
  ClawchatFragment,
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

export type OutputTurn =
  | {
      chatId: string;
      chatType: "direct";
    }
  | {
      chatId: string;
      chatType: "group";
      inboundMessageId: string;
      sender: ClawchatInboundMessage["sender"];
      preview: TextFragment[];
    };

export interface OutputProjectorOptions {
  transport: ClawchatTransport;
  now?: () => number;
  idFactory?: () => string;
  uploadMedia?: (filePath: string) => Promise<Record<string, unknown>>;
}

export class ClawchatOutputProjector {
  private readonly transport: ClawchatTransport;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly uploadMedia: ((filePath: string) => Promise<Record<string, unknown>>) | undefined;
  private readonly toolArguments = new Map<string, unknown>();
  private activeTurn: OutputTurn | undefined;

  constructor(options: OutputProjectorOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.uploadMedia = options.uploadMedia;
  }

  async beginTurn(turn: OutputTurn): Promise<void> {
    if (this.activeTurn) throw new Error("A ClawChat output turn is already active");
    this.activeTurn = turn;
    try {
      await this.sendTyping(turn, true);
    } catch (error: unknown) {
      this.activeTurn = undefined;
      this.toolArguments.clear();
      throw error;
    }
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
    const fragments = mode === "normal" ? await this.materializeFragments(text) : [{ kind: "text" as const, text }];
    if (fragments.length === 0) return;
    if (turn.chatType === "direct") {
      await this.send({
        event: "message.send",
        chat_id: turn.chatId,
        to: { id: turn.chatId, type: turn.chatType },
        payload: {
          message_mode: mode,
          message: {
            body: { fragments },
            context: { mentions: [], reply: null }
          }
        }
      });
      return;
    }
    await this.send({
      event: "message.reply",
      chat_id: turn.chatId,
      to: { id: turn.chatId, type: turn.chatType },
      payload: {
        message_mode: mode,
        message: {
          body: { fragments },
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

  private async materializeFragments(text: string): Promise<ClawchatFragment[]> {
    if (!this.uploadMedia || !text.includes("MEDIA:")) return [{ kind: "text", text }];
    const forceDocument = text.includes("[[as_document]]");
    const paths: string[] = [];
    const body = text
      .replace(/MEDIA:(?:"([^"]+)"|'([^']+)'|(\S+))/g, (_match, doubleQuoted, singleQuoted, bare) => {
        paths.push(doubleQuoted ?? singleQuoted ?? bare);
        return "";
      })
      .replaceAll("[[as_document]]", "")
      .replace(/[ \\t]+\\n/g, "\\n")
      .trim();
    const fragments: ClawchatFragment[] = body ? [{ kind: "text", text: body }] : [];
    for (const path of paths) {
      try {
        const uploaded = await this.uploadMedia(path);
        const fragment = mediaFragment(uploaded);
        fragments.push(forceDocument && fragment.kind === "image" ? { ...fragment, kind: "file" } : fragment);
      } catch (error: unknown) {
        fragments.push({
          kind: "text",
          text: `Attachment upload failed for ${path}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    return fragments.length > 0 ? fragments : [{ kind: "text", text }];
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
  if (message.chat_type === "direct") {
    return { chatId: message.chat_id, chatType: "direct" };
  }
  return {
    chatId: message.chat_id,
    chatType: "group",
    inboundMessageId: message.payload.message_id,
    sender: message.sender,
    preview: trimPreview(message.payload.message.body.fragments)
  };
}

function trimPreview(fragments: ClawchatFragment[]): TextFragment[] {
  const text = fragments
    .filter((fragment): fragment is TextFragment => fragment.kind === "text")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
  if (!text) return [];
  return [{ kind: "text", text: text.length > 240 ? `${text.slice(0, 237)}...` : text }];
}

function mediaFragment(value: Record<string, unknown>): Extract<ClawchatFragment, { url: string }> {
  const kind = value.kind;
  const url = value.url;
  if (kind !== "image" && kind !== "file" && kind !== "audio" && kind !== "video") {
    throw new Error("media upload returned an unsupported fragment kind");
  }
  if (typeof url !== "string" || !url) throw new Error("media upload returned no URL");
  return {
    kind,
    url,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.mime === "string" ? { mime: value.mime } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    ...(typeof value.duration === "number" ? { duration: value.duration } : {})
  };
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
