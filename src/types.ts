export type ClawchatEventName =
  | "message.send"
  | "message.reply"
  | "message.created"
  | "message.add"
  | "message.done"
  | "message.failed";

export interface ClawchatPeer {
  id: string;
  type: "direct" | "group";
  nick_name?: string;
}

export interface TextFragment {
  kind?: "text";
  type?: "text";
  text: string;
  delta?: string;
}

export type ClawchatFragment = TextFragment;

export interface ClawchatInboundMessage {
  version: "2";
  event: "message.send" | "message.reply";
  trace_id: string;
  emitted_at: number;
  chat_id: string;
  chat_type: "direct" | "group";
  sender: ClawchatPeer;
  payload: {
    message_id: string;
    fragments?: ClawchatFragment[];
    message?: {
      body?: {
        fragments?: ClawchatFragment[];
      };
      context?: Record<string, unknown>;
    };
  };
}

export interface ClawchatOutboundMessage {
  version: "2";
  event: "message.created" | "message.add" | "message.done" | "message.failed";
  trace_id: string;
  emitted_at: number;
  chat_id: string;
  payload: Record<string, unknown>;
}

export interface ClawchatTransport {
  send(message: ClawchatOutboundMessage): Promise<void>;
}

export interface PiAgentSessionEvent {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  [key: string]: unknown;
}

export interface PiAgentSession {
  prompt(message: string, options?: { source?: "interactive" | "rpc" | "extension" }): Promise<void>;
  subscribe(listener: (event: PiAgentSessionEvent) => void): () => void;
  dispose?: () => void;
}
