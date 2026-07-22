import { describe, expect, it, vi } from "vitest";
import { defaultClawchatOutputSettings } from "../src/output-settings.js";
import { createClawchatPiExtension } from "../src/extension.js";
import type { ClawchatState } from "../src/state.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage } from "../src/types.js";

function inboundMessage(
  overrides: Partial<Pick<ClawchatInboundMessage, "chat_id" | "chat_type">> & { text?: string } = {}
): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-1",
    emitted_at: 1,
    chat_id: overrides.chat_id ?? "chat-1",
    chat_type: overrides.chat_type ?? "direct",
    sender: { id: "user-1", type: overrides.chat_type ?? "direct", nick_name: "Alice" },
    payload: {
      message_id: "message-1",
      message: {
        body: { fragments: [{ kind: "text", text: overrides.text ?? "hello pi plugin" }] }
      }
    }
  };
}

function activeState(): ClawchatState {
  return {
    accessToken: "token-1",
    baseUrl: "https://app.clawling.com",
    websocketUrl: "wss://app.clawling.com/ws",
    deviceId: "clawchat-pi-device-1",
    workspace: "/workspace",
    agent: { userId: "user-1", ownerId: "owner-1" },
    output: defaultClawchatOutputSettings()
  };
}

function fakePi(thinkingLevel = "high") {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  return {
    handlers,
    commands,
    api: {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) =>
        commands.set(name, command)
      ),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      getThinkingLevel: vi.fn(() => thinkingLevel)
    }
  };
}

function sessionContext(setStatus: (key: string, message?: string) => void = vi.fn()) {
  return {
    isIdle: () => true,
    ui: { notify: vi.fn(), setStatus }
  };
}

describe("clawchat pi extension", () => {
  it("registers output commands and completed-output lifecycle handlers", () => {
    const pi = fakePi();

    createClawchatPiExtension()(pi.api as never);

    expect(pi.commands.has("clawchat-activate")).toBe(true);
    expect(pi.commands.has("clawchat-output")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("tool_execution_start")).toBe(true);
    expect(pi.handlers.has("tool_execution_end")).toBe(true);
    expect(pi.handlers.has("agent_settled")).toBe(true);
    expect(pi.handlers.has("message_update")).toBe(false);
  });

  it("saves activation state from the slash command without exposing the token", async () => {
    const pi = fakePi();
    const notify = vi.fn();
    const activate = vi.fn(async () => ({
      accessToken: "token-1",
      baseUrl: "https://app.clawling.com",
      agent: { userId: "user-1", ownerId: "owner-1" }
    }));
    const saveState = vi.fn(async () => "/tmp/clawchat.json");
    const prepareState = vi.fn(async () => ({
      deviceId: "clawchat-pi-device-1",
      workspace: "/workspace"
    }));

    createClawchatPiExtension({ activate, prepareState, saveState })(pi.api as never);
    await pi.commands.get("clawchat-activate")!.handler("CODE1", { cwd: "/workspace", ui: { notify } });

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "CODE1",
        baseUrl: "https://app.clawling.com",
        deviceId: "clawchat-pi-device-1"
      })
    );
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "token-1" }),
      expect.objectContaining({ workspace: "/workspace" })
    );
    expect(notify).toHaveBeenCalledWith("ClawChat activated and saved.", "info");
  });

  it("forwards completed Pi thinking and text as materialized replies", async () => {
    const pi = fakePi("high");
    const sent: ClawchatOutboundMessage[] = [];
    let inbound: ((message: ClawchatInboundMessage) => Promise<void>) | undefined;
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      send: vi.fn(async (message: ClawchatOutboundMessage) => {
        sent.push(message);
      })
    };

    createClawchatPiExtension({
      loadState: vi.fn(async () => activeState()),
      clientFactory: (options) => {
        inbound = options.onInboundMessage;
        return client;
      },
      idFactory: () => "trace-1",
      now: () => 123
    })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext());
    await inbound!(inboundMessage());
    await pi.handlers.get("message_end")!({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "text", text: "hello back" }
        ]
      }
    });
    await pi.handlers.get("agent_settled")!({ type: "agent_settled" });

    expect(pi.api.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello pi plugin"));
    expect(sent.map((message) => message.event)).toEqual([
      "typing.update",
      "message.reply",
      "message.reply",
      "typing.update"
    ]);
    const replies = sent.filter((message) => message.event === "message.reply");
    expect(replies.map((message) => message.payload.message_mode)).toEqual(["thinking", "normal"]);
  });

  it("connects with the stable device stored in the Host Profile", async () => {
    const pi = fakePi();
    let connectedDevice: string | undefined;
    let connectedUser: string | undefined;
    let queuesHostTurns: boolean | undefined;

    createClawchatPiExtension({
      loadState: vi.fn(async () => activeState()),
      clientFactory: (options) => {
        connectedDevice = options.deviceId;
        connectedUser = options.userId;
        queuesHostTurns = options.queueTurns;
        return {
          connect: vi.fn(async () => undefined),
          close: vi.fn(),
          send: vi.fn(async () => undefined)
        };
      }
    })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext());
    expect(connectedDevice).toBe("clawchat-pi-device-1");
    expect(connectedUser).toBe("user-1");
    expect(queuesHostTurns).toBe(false);
  });

  it("persists a per-chat tool output command and materializes later tool output", async () => {
    const pi = fakePi("off");
    let state = activeState();
    const sent: ClawchatOutboundMessage[] = [];
    let inbound: ((message: ClawchatInboundMessage) => Promise<void>) | undefined;

    createClawchatPiExtension({
      loadState: vi.fn(async () => state),
      saveState: vi.fn(async (next) => {
        state = next as ClawchatState;
        return "/tmp/clawchat.json";
      }),
      clientFactory: (options) => {
        inbound = options.onInboundMessage;
        return {
          connect: vi.fn(async () => undefined),
          close: vi.fn(),
          send: vi.fn(async (message: ClawchatOutboundMessage) => {
            sent.push(message);
          })
        };
      }
    })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext());
    await inbound!(inboundMessage({ text: "/clawchat-output tools on" }));

    expect(pi.api.sendUserMessage).not.toHaveBeenCalled();
    expect(state.output.chatOverrides).toEqual({ "chat-1": "on" });
    expect(sent.at(-1)).toMatchObject({ event: "message.reply", payload: { message_mode: "normal" } });

    await inbound!(inboundMessage({ text: "read the file" }));
    await pi.handlers.get("tool_execution_start")!({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" }
    });
    await pi.handlers.get("tool_execution_end")!({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "contents",
      isError: false
    });
    await pi.handlers.get("agent_settled")!({ type: "agent_settled" });

    expect(sent.some((message) => message.event === "message.reply" && message.payload.message_mode === "tool")).toBe(
      true
    );
  });

  it("queues a second inbound message until the active Pi run settles", async () => {
    const pi = fakePi("off");
    let inbound: ((message: ClawchatInboundMessage) => Promise<void>) | undefined;

    createClawchatPiExtension({
      loadState: vi.fn(async () => activeState()),
      clientFactory: (options) => {
        inbound = options.onInboundMessage;
        return {
          connect: vi.fn(async () => undefined),
          close: vi.fn(),
          send: vi.fn(async () => undefined)
        };
      }
    })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext());
    await inbound!(inboundMessage({ text: "first" }));
    await inbound!(inboundMessage({ chat_id: "chat-2", text: "second" }));
    expect(pi.api.sendUserMessage).toHaveBeenCalledTimes(1);

    await pi.handlers.get("agent_settled")!({ type: "agent_settled" });
    expect(pi.api.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.api.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("second"));
  });

  it("does not throw when Pi marks the UI context stale while the websocket closes", async () => {
    const pi = fakePi();
    let onStatus: ((message: string) => void) | undefined;
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(() => {
        onStatus?.("ClawChat WebSocket closed with code 1000");
      }),
      send: vi.fn(async () => undefined)
    };

    createClawchatPiExtension({
      loadState: vi.fn(async () => activeState()),
      clientFactory: (options) => {
        onStatus = options.onStatus;
        return client;
      }
    })(pi.api as never);

    const ctx = sessionContext(
      vi.fn(() => {
        throw new Error("stale ctx");
      })
    );
    await expect(pi.handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
    await expect(pi.handlers.get("session_shutdown")!({}, ctx)).resolves.toBeUndefined();
  });
});
