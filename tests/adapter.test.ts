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
      message: {
        body: { fragments: [{ kind: "text", text: "hello pi" }] }
      }
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

  it("ignores inbound messages without renderable fragments", async () => {
    const session: PiAgentSession = {
      subscribe() {
        return () => undefined;
      },
      prompt: vi.fn(async () => undefined)
    };
    const transport: ClawchatTransport = {
      send: vi.fn(async () => undefined)
    };

    const adapter = new ClawchatPiAdapter({
      session,
      transport
    });
    await adapter.handleInboundMessage(
      inboundMessage({
        payload: {
          message_id: "message-2",
          message: {
            body: {}
          }
        } as never
      })
    );

    expect(session.prompt).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("keeps the adapter alive and sends message.failed when pi prompt fails", async () => {
    const session: PiAgentSession = {
      subscribe() {
        return () => undefined;
      },
      prompt: vi.fn(async () => {
        throw new Error("missing provider auth");
      })
    };
    const transport: ClawchatTransport = {
      send: vi.fn(async () => undefined)
    };

    const adapter = new ClawchatPiAdapter({
      session,
      transport,
      idFactory: () => "outbound-1",
      now: () => 123
    });

    await expect(adapter.handleInboundMessage(inboundMessage())).resolves.toBeUndefined();
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "message.failed",
        chat_id: "chat-1",
        payload: expect.objectContaining({
          message_id: "outbound-1",
          reply_to_message_id: "message-1",
          error: "missing provider auth"
        })
      })
    );
  });
});
