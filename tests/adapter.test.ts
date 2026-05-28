import { describe, expect, it, vi } from "vitest";
import { ClawchatPiAdapter } from "../src/adapter.js";
import type { ClawchatInboundMessage, ClawchatTransport, PiAgentSession, PiAgentSessionEvent } from "../src/types.js";

function inboundMessage(overrides: Partial<ClawchatInboundMessage> = {}): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-1",
    emitted_at: 1,
    chat_id: "chat-1",
    chat_type: "direct",
    sender: { id: "user-1", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: "message-1",
      fragments: [{ type: "text", text: "hello pi" }]
    },
    ...overrides
  };
}

describe("ClawchatPiAdapter", () => {
  it("prompts pi with inbound text and streams text deltas back to ClawChat", async () => {
    const listeners: Array<(event: PiAgentSessionEvent) => void> = [];
    const session: PiAgentSession = {
      subscribe(listener) {
        listeners.push(listener);
        return () => undefined;
      },
      prompt: vi.fn(async () => {
        listeners.forEach((listener) => {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "hi" }
          });
        });
        listeners.forEach((listener) => {
          listener({ type: "message_end", message: { id: "assistant-1" } });
        });
      })
    };
    const transport: ClawchatTransport = {
      send: vi.fn(async () => undefined)
    };

    const adapter = new ClawchatPiAdapter({ session, transport });
    await adapter.handleInboundMessage(inboundMessage());

    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("hello pi"),
      expect.objectContaining({ source: "extension" })
    );
    expect(transport.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "message.created",
        chat_id: "chat-1",
        payload: expect.objectContaining({ reply_to_message_id: "message-1" })
      })
    );
    expect(transport.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "message.add",
        payload: expect.objectContaining({
          fragments: [{ type: "text", text: "hi" }]
        })
      })
    );
    expect(transport.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event: "message.done",
        chat_id: "chat-1"
      })
    );
  });
});
