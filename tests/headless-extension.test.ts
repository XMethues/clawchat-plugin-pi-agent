import { describe, expect, it, vi } from "vitest";
import { createHeadlessClawchatPiExtension } from "../src/headless-extension.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage } from "../src/types.js";

describe("Headless ClawChat Pi Extension", () => {
  it("projects one SDK-driven Pi turn through the shared ClawChat transport", async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      getThinkingLevel: vi.fn(() => "high")
    };
    const sent: ClawchatOutboundMessage[] = [];
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          sent.push(message);
        }
      },
      toolsVisible: () => false,
      now: () => 123,
      idFactory: () => "trace-1"
    });
    extension(pi as never);

    await controller.beginTurn(inboundMessage());
    await handlers.get("message_end")!({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect" },
          { type: "text", text: "done" }
        ]
      }
    });
    await handlers.get("agent_settled")!({ type: "agent_settled" });

    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.reply",
      "message.reply",
      "typing.update"
    ]);
    expect(controller.isActive()).toBe(false);
  });
});

function inboundMessage(): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-in-1",
    emitted_at: 1,
    chat_id: "chat-1",
    chat_type: "direct",
    sender: { id: "human-1", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      message: {
        body: { fragments: [{ kind: "text", text: "hello" }] },
        context: { mentions: [], reply: null }
      }
    }
  };
}
