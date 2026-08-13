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
      outputMode: () => "full",
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
      "message.send",
      "message.send",
      "typing.update"
    ]);
    expect(controller.isActive()).toBe(false);
  });

  it("keeps only the final assistant text when the active chat uses minimal mode", async () => {
    const handlers = new Map<string, Function>();
    const sent: ClawchatOutboundMessage[] = [];
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          sent.push(message);
        }
      },
      outputMode: () => "minimal"
    });
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as never);

    await controller.beginTurn(inboundMessage());
    await handlers.get("message_end")!({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I will check." }] }
    });
    await handlers.get("message_end")!({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "It is raining." }] }
    });
    expect(sent.filter((message) => message.event === "message.send")).toHaveLength(0);

    await handlers.get("agent_settled")!({ type: "agent_settled" });

    const replies = sent.filter((message) => message.event === "message.send");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.message.body.fragments).toEqual([{ kind: "text", text: "It is raining." }]);
  });

  it("does not flush buffered minimal text after a terminal ClawChat tool sends the reply", async () => {
    const handlers = new Map<string, Function>();
    const registeredTools = new Map<string, { execute: (id: string, args: unknown) => Promise<unknown> }>();
    const sent: ClawchatOutboundMessage[] = [];
    const sendFrame = vi.fn(async () => undefined);
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          sent.push(message);
        }
      },
      outputMode: () => "minimal",
      tools: {
        api: {},
        memory: {},
        profile: () => ({}),
        sendFrame
      } as never
    });
    extension({
      on: (event: string, handler: Function) => handlers.set(event, handler),
      registerTool: (tool: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }) =>
        registeredTools.set(tool.name, tool)
    } as never);

    await controller.beginTurn(inboundMessage());
    await handlers.get("message_end")!({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I will send it." }] }
    });
    await registeredTools.get("clawchat_mention_message")!.execute("call-1", {
      chatId: "chat-1",
      chatType: "direct",
      mentions: [{ userId: "user-2", display: "Alice" }],
      text: "done"
    });
    await handlers.get("agent_settled")!({ type: "agent_settled" });

    expect(sendFrame).toHaveBeenCalledOnce();
    expect(sent.filter((message) => message.event === "message.send")).toHaveLength(0);
  });

  it("binds an Awareness Turn to owner memory, tools, direct output, and cleanup", async () => {
    const handlers = new Map<string, Function>();
    const registeredTools = new Map<string, { execute: (id: string, args: unknown) => Promise<unknown> }>();
    const sent: ClawchatOutboundMessage[] = [];
    const sendFrame = vi.fn(async () => undefined);
    const recordToolCall = vi.fn();
    const renderTurnContext = vi.fn(async () => "## Owner Turn Memory\n\nowner-memory");
    const pi = {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      registerTool: vi.fn((tool: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }) =>
        registeredTools.set(tool.name, tool)
      ),
      getThinkingLevel: vi.fn(() => "high")
    };
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          sent.push(message);
        }
      },
      outputMode: () => "normal",
      tools: {
        api: {},
        memory: { renderTurnContext },
        profile: () => ({}),
        sendFrame,
        recordToolCall
      } as never,
      now: () => 123,
      idFactory: () => "trace-awareness"
    });
    extension(pi as never);

    await controller.beginAwarenessTurn({
      target: { chatId: "owner-chat-1", chatType: "direct" },
      auditSource: "notify-1",
      outputMode: "normal",
      toolContext: { chatId: "owner-chat-1", chatType: "direct" }
    });
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" });
    await registeredTools.get("clawchat_react_message")!.execute("call-1", {
      chatId: "owner-chat-1",
      targetMessageId: "target-message-1",
      emoji: "ok"
    });
    await handlers.get("message_end")!({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Owner state changed." }
        ]
      }
    });
    await handlers.get("agent_settled")!({ type: "agent_settled" });

    expect(renderTurnContext).toHaveBeenCalledWith({
      chatId: "owner-chat-1",
      chatType: "direct"
    });
    expect(prompt.systemPrompt).toContain("owner-memory");
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "message.reaction",
        chat_id: "owner-chat-1",
        to: { id: "owner-chat-1", type: "direct" }
      })
    );
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "owner-chat-1", auditSource: "notify-1" })
    );
    expect(recordToolCall.mock.calls[0]![0]).not.toHaveProperty("messageId");
    const visible = sent.find((message) => message.event === "message.send");
    expect(visible).toMatchObject({
      chat_id: "owner-chat-1",
      to: { id: "owner-chat-1", type: "direct" },
      payload: {
        message_mode: "normal",
        message: { context: { mentions: [], reply: null } }
      }
    });
    expect(sent.filter((message) => message.event === "message.send")).toHaveLength(1);
    expect(controller.isActive()).toBe(false);
  });

  it("clears an Awareness Turn binding when output projection fails", async () => {
    const handlers = new Map<string, Function>();
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          if (message.event === "message.send") throw new Error("transport failed");
        }
      },
      outputMode: () => "normal"
    });
    extension({
      on: (event: string, handler: Function) => handlers.set(event, handler),
      getThinkingLevel: () => "off"
    } as never);
    await controller.beginAwarenessTurn({
      target: { chatId: "owner-chat-1", chatType: "direct" },
      outputMode: "normal",
      toolContext: { chatId: "owner-chat-1", chatType: "direct" }
    });

    await expect(
      handlers.get("message_end")!({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "visible" }] }
      })
    ).rejects.toThrow("transport failed");
    expect(controller.isActive()).toBe(false);
  });

  it("clears an Awareness Turn binding on explicit abort", async () => {
    const handlers = new Map<string, Function>();
    const sent: ClawchatOutboundMessage[] = [];
    const { extension, controller } = createHeadlessClawchatPiExtension({
      transport: {
        send: async (message) => {
          sent.push(message);
        }
      },
      outputMode: () => "minimal"
    });
    extension({
      on: (event: string, handler: Function) => handlers.set(event, handler),
      getThinkingLevel: () => "off"
    } as never);
    await controller.beginAwarenessTurn({
      target: { chatId: "owner-chat-1", chatType: "direct" },
      outputMode: "minimal",
      toolContext: { chatId: "owner-chat-1", chatType: "direct" }
    });
    await handlers.get("message_end")!({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] }
    });

    await controller.abortTurn();

    expect(sent.map((message) => message.event)).toEqual(["typing.update", "typing.update"]);
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
