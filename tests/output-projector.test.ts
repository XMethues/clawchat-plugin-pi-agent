import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ClawchatOutputProjector, outputTurnFromInbound } from "../src/output-projector.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage, ClawchatTransport } from "../src/types.js";

function inboundMessage(): ClawchatInboundMessage {
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
    }
  };
}

describe("ClawchatOutputProjector", () => {
  it("sends assistant text, Markdown thinking, and completed tools in full mode", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const transport: ClawchatTransport = {
      send: vi.fn(async (message) => {
        sent.push(message);
      })
    };
    const projector = new ClawchatOutputProjector({
      transport,
      idFactory: () => "trace",
      now: () => 123
    });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "inspect first" },
            { type: "text", text: "I found it." }
          ]
        }
      } as unknown as MessageEndEvent,
      "full"
    );
    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "message.send"
    ]);
    await projector.handle(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } },
      "full"
    );
    await projector.handle(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "contents" }] },
        isError: false
      } as ToolExecutionEndEvent,
      "full"
    );
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "message.send",
      "message.send",
      "typing.update"
    ]);
    const replies = sent.filter((message) => message.event === "message.send");
    expect(replies.map((message) => message.payload.message_mode)).toEqual(["thinking", "normal", "tool"]);
    expect(replies[0]?.payload.message.body.fragments).toEqual([
      { kind: "text", text: "### Thinking\n\n```text\ninspect first\n```" }
    ]);
    expect(replies[1]?.payload.message.body.fragments).toEqual([{ kind: "text", text: "I found it." }]);
    expect(replies[2]?.payload.message.body.fragments).toEqual([{
      kind: "text",
      text: [
        "### 🔧 Tool: `read`",
        "**Arguments**\n```json\n{\n  \"path\": \"README.md\"\n}\n```",
        "**✅ Result**\n```json\n{\n  \"content\": [\n    {\n      \"type\": \"text\",\n      \"text\": \"contents\"\n    }\n  ]\n}\n```"
      ].join("\n\n")
    }]);
    expect(replies[1]).toMatchObject({
      chat_id: "chat-1",
      to: { id: "chat-1", type: "direct" },
      payload: {
        message: {
          context: {
            mentions: [],
            reply: null
          }
        }
      }
    });
    expect(replies[1]?.payload).not.toHaveProperty("message_id");
    expect(replies[1]?.payload.message).not.toHaveProperty("streaming");
    expect(sent.every((message) => !["message.created", "message.add", "message.done"].includes(message.event))).toBe(
      true
    );
  });

  it("uses a longer Markdown fence when tool output contains backticks", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: undefined },
      "full"
    );
    await projector.handle(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: "line\n```\nline",
        isError: true
      } as ToolExecutionEndEvent,
      "full"
    );
    await projector.endTurn();

    const tool = sent.find((message) => message.event === "message.send");
    expect(tool?.payload.message.body.fragments).toEqual([{
      kind: "text",
      text: "### 🔧 Tool: `bash`\n\n**❌ Error**\n````text\nline\n```\nline\n````"
    }]);
  });

  it("sends a group control response as an ordinary message", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";

    await projector.sendTo(inbound, "Group answer");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: "message.send",
      chat_id: "chat-1",
      to: { id: "chat-1", type: "group" },
      payload: {
        message: {
          context: { mentions: [], reply: null }
        }
      }
    });
  });

  it("sends only the final non-empty assistant result for a direct chat in minimal mode", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Draft answer" }
          ]
        }
      } as unknown as MessageEndEvent,
      "minimal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "   " }] }
      } as unknown as MessageEndEvent,
      "minimal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] }
      } as unknown as MessageEndEvent,
      "minimal"
    );
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "typing.update"
    ]);
    expect(sent[1]).toMatchObject({
      event: "message.send",
      chat_id: "chat-1",
      to: { id: "chat-1", type: "direct" },
      payload: {
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "Final answer" }] },
          context: { mentions: [], reply: null }
        }
      }
    });
  });

  it("sends the final assistant result as an ordinary group message in minimal mode", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";

    await projector.beginTurn(outputTurnFromInbound(inbound));
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Group draft" }] }
      } as unknown as MessageEndEvent,
      "minimal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [] }
      } as unknown as MessageEndEvent,
      "minimal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Group final" }] }
      } as unknown as MessageEndEvent,
      "minimal"
    );

    expect(sent.map((message) => message.event)).toEqual(["typing.update"]);
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "typing.update"
    ]);
    expect(sent[1]).toMatchObject({
      event: "message.send",
      payload: {
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "Group final" }] },
          context: { mentions: [], reply: null }
        }
      }
    });
  });

  it("buffers normal group output until the turn ends and preserves block order", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";
    await projector.beginTurn(outputTurnFromInbound(inbound));

    await projector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "First" }] }
    } as unknown as MessageEndEvent, "normal");
    await projector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Second" }] }
    } as unknown as MessageEndEvent, "normal");

    expect(sent.map((message) => message.event)).toEqual(["typing.update"]);
    await projector.endTurn();
    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "message.send",
      "typing.update"
    ]);
    expect(sent.filter((message) => message.event === "message.send")
      .map((message) => message.payload.message.body.fragments)).toEqual([
      [{ kind: "text", text: "First" }],
      [{ kind: "text", text: "Second" }]
    ]);
  });

  it("suppresses every buffered full-mode output when the final group block is SILENT", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";
    await projector.beginTurn(outputTurnFromInbound(inbound, "everyone"));

    await projector.handle({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "Earlier block" }
        ]
      }
    } as unknown as MessageEndEvent, "full");
    await projector.handle({
      type: "tool_execution_start",
      toolCallId: "call-silent",
      toolName: "read",
      args: { path: "README.md" }
    } as ToolExecutionStartEvent, "full");
    await projector.handle({
      type: "tool_execution_end",
      toolCallId: "call-silent",
      toolName: "read",
      result: "contents",
      isError: false
    } as ToolExecutionEndEvent, "full");
    await projector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "\n [SILENT] \n" }] }
    } as unknown as MessageEndEvent, "full");
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual(["typing.update", "typing.update"]);
  });

  it("does not silence a direct Agent mention or a lowercase marker", async () => {
    const directMentionSent: ClawchatOutboundMessage[] = [];
    const directMentionProjector = new ClawchatOutputProjector({
      transport: { send: async (message) => { directMentionSent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";
    await directMentionProjector.beginTurn(outputTurnFromInbound(inbound, "direct"));
    await directMentionProjector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "[SILENT]" }] }
    } as unknown as MessageEndEvent, "normal");
    await directMentionProjector.endTurn();

    const lowercaseSent: ClawchatOutboundMessage[] = [];
    const lowercaseProjector = new ClawchatOutputProjector({
      transport: { send: async (message) => { lowercaseSent.push(message); } }
    });
    await lowercaseProjector.beginTurn(outputTurnFromInbound(inbound));
    await lowercaseProjector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "[silent]" }] }
    } as unknown as MessageEndEvent, "normal");
    await lowercaseProjector.endTurn();

    expect(directMentionSent.find((message) => message.event === "message.send")
      ?.payload.message.body.fragments).toEqual([{ kind: "text", text: "[SILENT]" }]);
    expect(lowercaseSent.find((message) => message.event === "message.send")
      ?.payload.message.body.fragments).toEqual([{ kind: "text", text: "[silent]" }]);
  });

  it("discards buffered group output when the turn aborts", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";
    await projector.beginTurn(outputTurnFromInbound(inbound));
    await projector.handle({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
    } as unknown as MessageEndEvent, "normal");

    projector.discardPendingOutput();
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual(["typing.update", "typing.update"]);
  });

  it("sends every non-empty assistant text and excludes thinking and tools in normal mode", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } } as ToolExecutionStartEvent,
      "normal"
    );
    await projector.handle(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: "ok",
        isError: false
      } as ToolExecutionEndEvent,
      "normal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "First answer" }
          ]
        }
      } as unknown as MessageEndEvent,
      "normal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "" }] }
      } as unknown as MessageEndEvent,
      "normal"
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] }
      } as unknown as MessageEndEvent,
      "normal"
    );
    await projector.endTurn();

    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.send",
      "message.send",
      "typing.update"
    ]);
    const replies = sent.filter((message) => message.event === "message.send");
    expect(replies.map((message) => ({
      mode: message.payload.message_mode,
      fragments: message.payload.message.body.fragments
    }))).toEqual([
      { mode: "normal", fragments: [{ kind: "text", text: "First answer" }] },
      { mode: "normal", fragments: [{ kind: "text", text: "Final answer" }] }
    ]);
  });

  it.each(["minimal", "normal", "full"] as const)(
    "does not materialize empty assistant blocks in %s mode",
    async (mode) => {
      const sent: ClawchatOutboundMessage[] = [];
      const projector = new ClawchatOutputProjector({
        transport: { send: async (message) => { sent.push(message); } }
      });

      await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
      await projector.handle(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "   " },
              { type: "text", text: "   " }
            ]
          }
        } as unknown as MessageEndEvent,
        mode
      );
      await projector.endTurn();

      expect(sent.map((message) => message.event)).toEqual([
        "typing.update",
        "typing.update"
      ]);
    }
  );

  it("uploads MEDIA directives and can force images into document fragments", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const uploadMedia = vi.fn(async (path: string) => ({
      kind: path.endsWith(".png") ? "image" : "file",
      url: `https://cdn.example/${path.split("/").at(-1)}`,
      name: path.split("/").at(-1)
    }));
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } },
      uploadMedia
    });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: "Files attached MEDIA:/tmp/report.pdf MEDIA:\"/tmp/chart.png\" [[as_document]]"
          }]
        }
      } as unknown as MessageEndEvent,
      "normal"
    );
    await projector.endTurn();

    const reply = sent.find((message) => message.event === "message.send");
    expect(uploadMedia.mock.calls).toEqual([["/tmp/report.pdf"], ["/tmp/chart.png"]]);
    expect(reply?.payload.message.body.fragments).toEqual([
      { kind: "text", text: "Files attached" },
      { kind: "file", url: "https://cdn.example/report.pdf", name: "report.pdf" },
      { kind: "file", url: "https://cdn.example/chart.png", name: "chart.png" }
    ]);
  });

});
