export type ClawchatChatType = "direct" | "group";
export type ClawchatMessageMode = "normal" | "thinking" | "tool";

export interface ClawchatPeer {
  id: string;
  type: ClawchatChatType;
  nick_name?: string;
}

export interface TextFragment {
  kind: "text";
  text: string;
}

export interface MentionFragment {
  kind: "mention";
  user_id?: string;
  display?: string;
}

export interface MediaFragment {
  kind: "image" | "file" | "audio" | "video";
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export type ClawchatFragment = TextFragment | MentionFragment | MediaFragment;

export interface ClawchatInboundMessage {
  version: "2";
  event: "message.send" | "message.reply";
  trace_id: string;
  emitted_at: number;
  chat_id: string;
  chat_type: ClawchatChatType;
  sender: ClawchatPeer;
  payload: {
    message_id: string;
    message: {
      body: {
        fragments: ClawchatFragment[];
      };
      context?: Record<string, unknown>;
    };
  };
}

interface ClawchatOutboundBase {
  version: "2";
  trace_id: string;
  emitted_at: number;
  chat_id: string;
  to: {
    id: string;
    type: ClawchatChatType;
  };
}

export interface ClawchatReplyMessage extends ClawchatOutboundBase {
  event: "message.reply";
  payload: {
    message_mode: ClawchatMessageMode;
    message: {
      body: {
        fragments: ClawchatFragment[];
      };
      context: {
        mentions: [];
        reply: {
          reply_to_msg_id: string;
          reply_preview: {
            id: string;
            nick_name?: string;
            fragments: ClawchatFragment[];
          };
        };
      };
    };
  };
}

export interface ClawchatTypingUpdate extends ClawchatOutboundBase {
  event: "typing.update";
  payload: {
    is_typing: boolean;
  };
}

export type ClawchatOutboundMessage = ClawchatReplyMessage | ClawchatTypingUpdate;
type WithoutEnvelope<T> = T extends ClawchatOutboundMessage
  ? Omit<T, "version" | "trace_id" | "emitted_at">
  : never;
export type ClawchatOutboundContent = WithoutEnvelope<ClawchatOutboundMessage>;

export interface ClawchatTransport {
  send(message: ClawchatOutboundMessage): Promise<void>;
}
