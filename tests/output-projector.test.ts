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
  it("materializes completed output without quoting a direct message", async () => {
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
      { thinking: true, tools: true }
    );
    await projector.handle(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } },
      { thinking: true, tools: true }
    );
    await projector.handle(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "contents" }] },
        isError: false
      } as ToolExecutionEndEvent,
      { thinking: true, tools: true }
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
    expect(replies[0]?.payload.message.body.fragments).toEqual([{ kind: "text", text: "inspect first" }]);
    expect(replies[1]?.payload.message.body.fragments).toEqual([{ kind: "text", text: "I found it." }]);
    expect(replies[2]?.payload.message.body.fragments[0]).toMatchObject({ text: expect.stringContaining("README.md") });
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

  it("quotes the triggering message in a group reply", async () => {
    const sent: ClawchatOutboundMessage[] = [];
    const projector = new ClawchatOutputProjector({
      transport: { send: async (message) => { sent.push(message); } }
    });
    const inbound = inboundMessage();
    inbound.chat_type = "group";
    inbound.sender.type = "group";

    await projector.replyTo(inbound, "Group answer");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: "message.reply",
      chat_id: "chat-1",
      to: { id: "chat-1", type: "group" },
      payload: {
        message: {
          context: {
            mentions: [],
            reply: {
              reply_to_msg_id: "message-1",
              reply_preview: {
                id: "user-1",
                nick_name: "Alice",
                fragments: [{ kind: "text", text: "hello pi" }]
              }
            }
          }
        }
      }
    });
  });

  it("does not materialize thinking or tool events when their visibility is off", async () => {
    const transport: ClawchatTransport = { send: vi.fn(async () => undefined) };
    const projector = new ClawchatOutputProjector({ transport });

    await projector.beginTurn(outputTurnFromInbound(inboundMessage()));
    await projector.handle(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } } as ToolExecutionStartEvent,
      { thinking: false, tools: false }
    );
    await projector.handle(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: "ok",
        isError: false
      } as ToolExecutionEndEvent,
      { thinking: false, tools: false }
    );
    await projector.handle(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }
      } as unknown as MessageEndEvent,
      { thinking: false, tools: false }
    );
    await projector.endTurn();

    expect(vi.mocked(transport.send).mock.calls.map(([message]) => message.event)).toEqual([
      "typing.update",
      "typing.update"
    ]);
  });
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
      { thinking: false, tools: false }
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
