import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    expect(names).toHaveLength(35);
    expect(names).toEqual(expect.arrayContaining([
      "clawchat_memory_search",
      "clawchat_metadata_update",
      "clawchat_send_friend_request",
      "clawchat_no_reply",
      "clawchat_send_message",
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

  it("projects complete null-aware group metadata without clearing omitted participants", async () => {
    const tools = new Map<string, RegisteredTool>();
    const mergeMetadataIfChanged = vi.fn(
      async (_target: unknown, _metadata: Record<string, unknown>) => true
    );
    const read = vi.fn(async () => ({
      exists: true,
      metadata: { group_id: "group-1", participant_ids: "owner-1,agent-user-1" }
    }));
    const get = vi.fn(async () => ({
      conversation: {
        id: "group-1",
        type: "group",
        avatar_url: null,
        member_add_policy: null,
        group: { owner: null },
        updated_at: "2026-08-12T11:00:00.000Z"
      }
    }));
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool)
    } as unknown as ExtensionAPI;
    registerClawchatTools(
      pi,
      toolEnvironment({
        get,
        memory: {
          beginMetadataRefresh: () => 1,
          mergeMetadataIfChanged,
          read
        } as unknown as ClawchatMemoryStore
      })
    );

    const result = await tools.get("clawchat_metadata_sync")!.execute("call-group-pull", {
      targetType: "group",
      targetId: "group-1",
      direction: "pull"
    });

    expect(result.details).toMatchObject({ ok: true, targetId: "group-1" });
    const patch = mergeMetadataIfChanged.mock.calls[0]?.[1];
    expect(patch).toMatchObject({
      group_id: "group-1",
      group_type: "group",
      group_avatar_url: null,
      group_member_add_policy: null,
      group_owner_id: null,
      group_owner_nickname: null,
      group_owner_profile_type: null,
      updated_at: "2026-08-12T11:00:00.000Z"
    });
    expect(patch).not.toHaveProperty("participant_ids");
  });

  it("sends ordinary, reply, and mention messages into the Active ClawChat Turn", async () => {
    const tools = new Map<string, RegisteredTool>();
    const sendFrame = vi.fn(async (_frame: Record<string, unknown>) => undefined);
    const onTerminalCompletion = vi.fn();
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ sendFrame, onTerminalCompletion }));
    const sendMessage = tools.get("clawchat_send_message")!;

    const ordinary = await sendMessage.execute("call-1", { text: "ordinary answer" });
    await sendMessage.execute("call-2", {
      text: "direct answer",
      replyToCurrentMessage: true
    });
    await sendMessage.execute("call-3", {
      mentions: [{ userId: "user-2", display: "Alice" }],
      text: "please review"
    });

    expect(sendFrame.mock.calls[0]?.[0]).toMatchObject({
      event: "message.send",
      chat_id: "chat-1",
      to: { id: "chat-1", type: "group" },
      payload: {
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "ordinary answer" }] },
          context: { mentions: [], reply: null }
        }
      }
    });
    expect(sendFrame.mock.calls[1]?.[0]).toMatchObject({
      event: "message.reply",
      payload: {
        message: {
          body: { fragments: [{ kind: "text", text: "direct answer" }] },
          context: {
            mentions: [],
            reply: {
              reply_to_msg_id: "message-1",
              reply_preview: {
                id: "user-1",
                nick_name: "Bob",
                fragments: [{ kind: "text", text: "question" }]
              }
            }
          }
        }
      }
    });
    expect(sendFrame.mock.calls[2]?.[0]).toMatchObject({
      event: "message.send",
      payload: {
        message: {
          body: { fragments: [
            { kind: "mention", user_id: "user-2", display: "Alice" },
            { kind: "text", text: " please review" }
          ] },
          context: {
            mentions: [{ kind: "mention", user_id: "user-2", display: "Alice" }],
            reply: null
          }
        }
      }
    });
    expect(sendFrame).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.not.objectContaining({ message_id: expect.anything() })
    }));
    expect(ordinary.details).toMatchObject({
      sent: true,
      terminal: true,
      noFollowupReply: true,
      traceId: "pi-tool-trace-1"
    });
    expect(onTerminalCompletion).toHaveBeenCalledTimes(3);

    const rejected = await sendMessage.execute("call-4", {});
    expect(rejected.details).toMatchObject({ error: "validation" });
    expect(sendFrame).toHaveBeenCalledTimes(3);
  });

  it("completes eligible group turns without sending and rejects required replies", async () => {
    const tools = new Map<string, RegisteredTool>();
    const sendFrame = vi.fn(async (_frame: Record<string, unknown>) => undefined);
    const onTerminalCompletion = vi.fn();
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ sendFrame, onTerminalCompletion }));

    const result = await tools.get("clawchat_no_reply")!.execute("call-silent", {});

    expect(result.details).toEqual({
      ok: true,
      silent: true,
      terminal: true,
      noFollowupReply: true,
      instruction: "Silent Turn selected. Do not produce assistant text or call another tool."
    });
    expect(sendFrame).not.toHaveBeenCalled();
    expect(onTerminalCompletion).toHaveBeenCalledOnce();

    for (const activeTurn of [
      { chatId: "chat-1", chatType: "group" as const, mentionKind: "direct" as const },
      { chatId: "chat-1", chatType: "direct" as const }
    ]) {
      const rejectedTools = new Map<string, RegisteredTool>();
      const rejectedPi = {
        registerTool: (tool: RegisteredTool) => rejectedTools.set(tool.name, tool)
      } as unknown as ExtensionAPI;
      const rejectedCompletion = vi.fn();
      registerClawchatTools(rejectedPi, toolEnvironment({
        activeTurn: () => activeTurn,
        sendFrame,
        onTerminalCompletion: rejectedCompletion
      }));
      const rejected = await rejectedTools.get("clawchat_no_reply")!.execute("call-rejected", {});
      expect(rejected.details).toMatchObject({
        error: "validation",
        message: "clawchat_no_reply is available only for group messages that do not directly mention the Agent"
      });
      expect(rejectedCompletion).not.toHaveBeenCalled();
    }
  });

  it("can complete a turn with an emoji reaction and no follow-up text", async () => {
    const tools = new Map<string, RegisteredTool>();
    const sendFrame = vi.fn(async (_frame: Record<string, unknown>) => undefined);
    const onTerminalCompletion = vi.fn();
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ sendFrame, onTerminalCompletion }));
    const react = tools.get("clawchat_react_message")!;

    const complete = await react.execute("call-reaction-complete", {
      chatId: "chat-1",
      emoji: "👍",
      completeTurn: true
    });
    const nonTerminal = await react.execute("call-reaction-continue", {
      chatId: "chat-1",
      emoji: "❤️"
    });

    expect(sendFrame.mock.calls[0]?.[0]).toMatchObject({
      event: "message.reaction",
      chat_id: "chat-1",
      payload: {
        target_message_id: "message-1",
        emoji: "👍",
        removed: false
      }
    });
    expect(complete.details).toMatchObject({
      reacted: true,
      terminal: true,
      noFollowupReply: true
    });
    expect(nonTerminal.details).toEqual({
      reacted: true,
      targetMessageId: "message-1",
      emoji: "❤️",
      removed: false
    });
    expect(onTerminalCompletion).toHaveBeenCalledOnce();
  });

  it("resolves and logs in with an installed Liveware CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-liveware-tool-"));
    const executable = join(directory, "liveware");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.exit(process.argv.slice(2).join(' ').startsWith('login --access-token ') ? 0 : 1);\n"
    );
    await chmod(executable, 0o755);
    const ensureLivewareExecutable = vi.fn(async () => executable);
    const tools = new Map<string, RegisteredTool>();
    const pi = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
    registerClawchatTools(pi, toolEnvironment({ ensureLivewareExecutable }));

    const result = await tools.get("clawchat_liveware_login")!.execute("call-liveware", {});

    expect(result.details).toEqual({ ok: true });
    expect(ensureLivewareExecutable).toHaveBeenCalledOnce();
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
    get?: (path: string) => Promise<unknown>;
    post?: (path: string, body?: unknown) => Promise<unknown>;
  } = {}
): ClawchatToolEnvironment {
  const { get, post, ...environmentOverrides } = overrides;
  const api = {
    get: get ?? vi.fn(async () => ({})),
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
      output: { modeDefault: "normal" }
    }),
    api: api as unknown as ClawchatToolEnvironment["api"],
    memory: {} as ClawchatMemoryStore,
    activeTurn: () => ({
      chatId: "chat-1",
      chatType: "group",
      messageId: "message-1",
      sender: { id: "user-1", type: "group", nick_name: "Bob" },
      preview: [{ kind: "text", text: "question" }]
    }),
    sendFrame: vi.fn(async () => undefined),
    idFactory: () => "trace-1",
    now: () => 123,
    ...environmentOverrides
  };
}
