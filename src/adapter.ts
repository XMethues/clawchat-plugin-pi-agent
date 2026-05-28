import type {
  ClawchatInboundMessage,
  ClawchatOutboundMessage,
  ClawchatTransport,
  PiAgentSession,
  PiAgentSessionEvent
} from "./types.js";

interface AdapterOptions {
  session: PiAgentSession;
  transport: ClawchatTransport;
  now?: () => number;
  idFactory?: () => string;
}

interface ActiveReply {
  chatId: string;
  inboundMessageId: string;
  outboundMessageId: string;
  created: boolean;
}

export class ClawchatPiAdapter {
  private readonly session: PiAgentSession;
  private readonly transport: ClawchatTransport;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private activeReply: ActiveReply | undefined;
  private unsubscribe: (() => void) | undefined;
  private pendingEvents: Promise<void> = Promise.resolve();

  constructor(options: AdapterOptions) {
    this.session = options.session;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.unsubscribe = this.session.subscribe((event) => {
      this.pendingEvents = this.pendingEvents.then(() => this.handlePiEvent(event));
      void this.pendingEvents;
    });
  }

  async handleInboundMessage(message: ClawchatInboundMessage): Promise<void> {
    const text = renderInboundPrompt(message);
    if (!text) return;
    this.activeReply = {
      chatId: message.chat_id,
      inboundMessageId: message.payload.message_id,
      outboundMessageId: this.idFactory(),
      created: false
    };

    try {
      await this.session.prompt(text, { source: "extension" });
      await this.pendingEvents;
    } catch (error: unknown) {
      await this.send({
        event: "message.failed",
        chat_id: this.activeReply.chatId,
        payload: {
          message_id: this.activeReply.outboundMessageId,
          reply_to_message_id: this.activeReply.inboundMessageId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    } finally {
      this.activeReply = undefined;
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose?.();
  }

  private async handlePiEvent(event: PiAgentSessionEvent): Promise<void> {
    const reply = this.activeReply;
    if (!reply) return;

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
          fragments: [{ type: "text", text: event.assistantMessageEvent.delta }]
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
    }
  }

  private async send(message: Pick<ClawchatOutboundMessage, "event" | "chat_id" | "payload">): Promise<void> {
    await this.transport.send({
      version: "2",
      trace_id: `pi-${this.idFactory()}`,
      emitted_at: this.now(),
      ...message
    });
  }
}

export function renderInboundPrompt(message: ClawchatInboundMessage): string {
  const senderName = message.sender.nick_name?.trim() || message.sender.id;
  const fragments = message.payload.fragments ?? message.payload.message?.body?.fragments ?? [];
  const text = fragments
    .filter((fragment) => fragment.type === "text" || fragment.kind === "text")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
  if (!text) return "";

  return [`ClawChat ${message.chat_type} message from ${senderName}:`, text].join("\n");
}
