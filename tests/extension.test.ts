import { describe, expect, it, vi } from "vitest";
import { createClawchatPiExtension } from "../src/extension.js";
import type { ClawchatInboundMessage, ClawchatOutboundMessage } from "../src/types.js";

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
        body: { fragments: [{ kind: "text", text: "hello pi plugin" }] }
      }
    }
  };
}

function fakePi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  return {
    handlers,
    commands,
    api: {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, command)
      ),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn()
    }
  };
}

describe("clawchat pi extension", () => {
  it("registers activation command and lifecycle handlers", () => {
    const pi = fakePi();

    createClawchatPiExtension()(pi.api as never);

    expect(pi.commands.has("clawchat-activate")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("message_update")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
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

    createClawchatPiExtension({ activate, saveState })(pi.api as never);
    await pi.commands.get("clawchat-activate")!.handler("CODE1", { ui: { notify } });

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CODE1", baseUrl: "https://app.clawling.com" })
    );
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "token-1" }), expect.any(Object));
    expect(notify).toHaveBeenCalledWith("ClawChat activated and saved.", "info");
  });

  it("injects inbound ClawChat text into Pi and streams Pi text back", async () => {
    const pi = fakePi();
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
      loadState: vi.fn(async () => ({
        accessToken: "token-1",
        baseUrl: "https://app.clawling.com",
        websocketUrl: "wss://app.clawling.com/ws",
        agent: { userId: "user-1", ownerId: "owner-1" }
      })),
      clientFactory: (options) => {
        inbound = options.onInboundMessage;
        return client;
      },
      idFactory: () => "reply-1",
      now: () => 123
    })(pi.api as never);

    await pi.handlers.get("session_start")!({}, { isIdle: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() } });
    await inbound!(inboundMessage());
    await pi.handlers.get("message_update")!({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello back" }
    });
    await pi.handlers.get("message_end")!({ type: "message_end" });

    expect(pi.api.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello pi plugin"), undefined);
    expect(sent.map((message) => message.event)).toEqual(["message.created", "message.add", "message.done"]);
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
      loadState: vi.fn(async () => ({
        accessToken: "token-1",
        baseUrl: "https://app.clawling.com",
        websocketUrl: "wss://app.clawling.com/ws",
        agent: { userId: "user-1", ownerId: "owner-1" }
      })),
      clientFactory: (options) => {
        onStatus = options.onStatus;
        return client;
      }
    })(pi.api as never);

    const ctx = {
      isIdle: () => true,
      ui: {
        setStatus: vi.fn(() => {
          throw new Error("stale ctx");
        }),
        notify: vi.fn()
      }
    };

    await expect(pi.handlers.get("session_start")!({}, ctx)).resolves.toBeUndefined();
    expect(() => pi.handlers.get("session_shutdown")!({}, ctx)).not.toThrow();
  });
});
