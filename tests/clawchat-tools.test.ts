import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ClawchatApiError } from "../src/clawchat-api.js";
import type { ClawchatMemoryStore } from "../src/clawchat-memory.js";
import { registerClawchatTools, type ClawchatToolEnvironment } from "../src/clawchat-tools.js";

interface RegisteredTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ details: unknown }>;
}

describe("registerClawchatTools", () => {
  it("registers the complete pinned default tool set and preserves canonical REST payloads", async () => {
    const tools = new Map<string, RegisteredTool>();
    const post = vi.fn(async () => ({ ok: true }));
    const environment = toolEnvironment({ post });
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;

    const names = registerClawchatTools(pi, environment);

    expect(names).toHaveLength(34);
    expect(names).toEqual(expect.arrayContaining([
      "clawchat_memory_search",
      "clawchat_metadata_update",
      "clawchat_send_friend_request",
      "clawchat_mention_message",
      "clawchat_react_message",
      "clawchat_liveware_login"
    ]));

    await tools.get("clawchat_send_friend_request")!.execute("call-1", { userId: "user-2", greeting: "hello" });
    await tools.get("clawchat_create_moment")!.execute("call-2", { text: "moment", images: ["https://cdn/image.png"] });
    await tools.get("clawchat_register_app")!.execute("call-3", {
      name: "Status",
      appId: "app-1",
      url: "https://app.example.com"
    });

    expect(post.mock.calls).toEqual([
      ["/v1/friendships", { user_id: "user-2", greeting: "hello" }],
      ["/v1/moments", { text: "moment", images: ["https://cdn/image.png"] }],
      ["/v1/agents/me/apps", { name: "Status", app_id: "app-1", url: "https://app.example.com" }]
    ]);
  });

  it("sends structured mentions only into the Active ClawChat Turn and marks them terminal", async () => {
    const tools = new Map<string, RegisteredTool>();
    const sendFrame = vi.fn(async () => undefined);
    const onTerminalSend = vi.fn();
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ sendFrame, onTerminalSend }));

    const result = await tools.get("clawchat_mention_message")!.execute("call-1", {
      chatId: "chat-1",
      chatType: "group",
      mentions: [{ userId: "user-2", display: "Alice" }],
      text: "please review"
    });

    expect(sendFrame).toHaveBeenCalledWith(expect.objectContaining({
      event: "message.send",
      chat_id: "chat-1",
      to: { id: "chat-1", type: "group" },
      payload: expect.objectContaining({
        message_mode: "normal",
        message: expect.objectContaining({
          body: { fragments: [
            { kind: "mention", user_id: "user-2", display: "Alice" },
            { kind: "text", text: " please review" }
          ] }
        })
      })
    }));
    expect(sendFrame).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.not.objectContaining({ message_id: expect.anything() })
    }));
    expect(result.details).toMatchObject({ traceId: "pi-tool-trace-1" });
    expect(result.details).toMatchObject({ sent: true, terminal: true, noFollowupReply: true });
    expect(onTerminalSend).toHaveBeenCalledOnce();

    const rejected = await tools.get("clawchat_mention_message")!.execute("call-2", {
      chatId: "other-chat",
      mentions: [{ userId: "user-2", display: "Alice" }]
    });
    expect(rejected.details).toMatchObject({ error: "validation" });
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("returns pending permission outcomes as terminal non-retryable results and audits the call", async () => {
    const tools = new Map<string, RegisteredTool>();
    const recordToolCall = vi.fn();
    const post = vi.fn(async () => {
      throw new ClawchatApiError("api", "approval required", {
        code: 21001,
        data: { request_id: "permission-1" }
      });
    });
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ post, recordToolCall }));

    const result = await tools.get("clawchat_add_group_member")!.execute("call-1", {
      conversationId: "group-1",
      userId: "user-2"
    });

    expect(result.details).toMatchObject({
      error: "permission",
      status: "pending",
      retryable: false,
      request_id: "permission-1"
    });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "clawchat_add_group_member",
      error: "approval required"
    }));
  });
});

function toolEnvironment(
  overrides: Partial<ClawchatToolEnvironment> & {
    post?: (path: string, body?: unknown) => Promise<unknown>;
  } = {}
): ClawchatToolEnvironment {
  const { post, ...environmentOverrides } = overrides;
  const api = {
    get: vi.fn(async () => ({})),
    post: post ?? vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({}))
  };
  return {
    profile: () => ({
      schemaVersion: 2,
      name: "default",
      workspace: "/tmp",
      deviceId: "device-1",
      restUrl: "https://app.clawling.com",
      websocketUrl: "wss://app.clawling.com/ws",
      mediaUrl: "https://app.clawling.com",
      accessToken: "token-1",
      agent: { id: "agent-id-1", userId: "agent-1", ownerId: "owner-1" },
      output: { toolCallsDefault: "off" }
    }),
    api: api as unknown as ClawchatToolEnvironment["api"],
    memory: {} as ClawchatMemoryStore,
    activeTurn: () => ({ chatId: "chat-1", chatType: "group", messageId: "message-1" }),
    sendFrame: vi.fn(async () => undefined),
    idFactory: () => "trace-1",
    now: () => 123,
    ...environmentOverrides
  };
}
