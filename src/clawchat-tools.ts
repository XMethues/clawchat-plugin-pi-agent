import { basename, extname, isAbsolute } from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ClawchatApiClient, ClawchatApiError } from "./clawchat-api.js";
import { materializeClawchatGroupMemory } from "./clawchat-awareness.js";
import {
  ClawchatMemoryStore,
  clawchatMemoryTarget,
  type ClawchatMemoryTarget,
  type ClawchatMemoryTargetType
} from "./clawchat-memory.js";
import type { HostProfile } from "./host-profile.js";
import type { ClawchatGroupMention } from "./inbound.js";
import type { ClawchatFragment, ClawchatInboundMessage } from "./types.js";
import { isUnknownRecord } from "./type-guards.js";

export interface ActiveClawchatTurn {
  chatId: string;
  chatType: "direct" | "group";
  messageId?: string;
  mentionKind?: ClawchatGroupMention;
  sender?: ClawchatInboundMessage["sender"];
  preview?: ClawchatFragment[];
}

export interface ClawchatToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
  startedAt: number;
  endedAt: number;
  auditSource?: string;
  chatId?: string;
  messageId?: string;
}

export interface ClawchatToolEnvironment {
  profile: () => HostProfile;
  api: ClawchatApiClient;
  memory: ClawchatMemoryStore;
  activeTurn?: () => ActiveClawchatTurn | undefined;
  sendFrame?: (frame: Record<string, unknown>) => Promise<void>;
  recordToolCall?: (record: ClawchatToolCallRecord) => void;
  onTerminalCompletion?: () => void;
  onConversationLeft?: (chatId: string) => Promise<void>;
  livewareExecutable?: string;
  ensureLivewareExecutable?: () => Promise<string>;
  now?: () => number;
  idFactory?: () => string;
}

interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  requiresGateway?: boolean;
  execute: (args: Record<string, unknown>, environment: ClawchatToolEnvironment) => Promise<unknown>;
}

const TARGET_TYPE = Type.String({ enum: ["owner", "user", "group"] });
const TARGET = { targetType: TARGET_TYPE, targetId: Type.String({ minLength: 1 }) };
const EMPTY = Type.Object({});
const DIRECT_TOOL_INSTRUCTION =
  "Use this registered ClawChat tool directly; do not bypass it with shell, curl, scripts, or handwritten HTTP clients.";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function appendClawchatSystemPrompt(
  systemPrompt: string,
  turn?: Pick<ActiveClawchatTurn, "chatType" | "mentionKind">
): string {
  const capabilities = `${systemPrompt}

## ClawChat capabilities

This runtime includes the inherited \`clawchat-core\` and \`clawchat-liveware\` skills plus registered \`clawchat_*\` tools. Use those tools directly for supported ClawChat operations. Never bypass them with shell commands, curl, scripts, or handwritten HTTP clients. Tool schemas are authoritative; if a named tool is unavailable in this runtime, report that limitation instead of bypassing it.

Normal assistant text is delivered as an ordinary unquoted ClawChat message. When the conversation calls for an explicit reply to the current message, a structured mention, or both, use \`clawchat_send_message\`; a successful call sends the response and suppresses a duplicate normal follow-up.`;
  if (turn?.chatType !== "group") return capabilities;

  const mentionKind = turn.mentionKind ?? "none";
  if (mentionKind === "direct") {
    return `${capabilities}

## Group response policy

This message directly mentions you. You must respond normally and must not call \`clawchat_no_reply\` or use the Silent Marker.`;
  }
  const mentionRule = mentionKind === "everyone"
    ? "This message contains a group-wide @everyone mention. You may still choose a Silent Turn."
    : "This message does not mention you. Default to listening unless a response would add clear value.";
  return `${capabilities}

## Group response policy

Before producing assistant text or calling any tool, decide whether this group message needs a response. ${mentionRule}

When the message is unrelated, belongs to the human conversation, or needs no useful response, prefer \`clawchat_no_reply\` as the first and only action. Do not produce assistant text or call another tool. Only if \`clawchat_no_reply\` is unavailable, call no tools and output exactly \`[SILENT]\` as the only assistant text. The marker is uppercase and must contain no other text. Otherwise respond normally.`;
}

export async function appendClawchatMemoryPrompt(
  systemPrompt: string,
  memory: ClawchatMemoryStore,
  turn: Pick<ActiveClawchatTurn, "chatId" | "chatType">
): Promise<string> {
  const context = await memory.renderTurnContext(turn);
  if (!context) return systemPrompt;
  return `${systemPrompt}

${context}

User memory is intentionally excluded from automatic turn context. Read a user target explicitly with a ClawChat memory tool when needed.`;
}

export function registerClawchatTools(pi: ExtensionAPI, environment: ClawchatToolEnvironment): string[] {
  const registered: string[] = [];
  for (const spec of TOOL_SPECS) {
    if (spec.requiresGateway && !environment.sendFrame) continue;
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: `${spec.description} ${DIRECT_TOOL_INSTRUCTION}`,
      parameters: spec.parameters,
      async execute(_toolCallId, params) {
        const args = params as Record<string, unknown>;
        const startedAt = Date.now();
        try {
          const result = await spec.execute(args, environment);
          if (isUnknownRecord(result) && result.terminal === true) environment.onTerminalCompletion?.();
          recordToolCallSafely(environment, {
            toolName: spec.name,
            args,
            result,
            startedAt,
            endedAt: Date.now()
          });
          return toolResult(result);
        } catch (error: unknown) {
          const result = mapToolError(error);
          recordToolCallSafely(environment, {
            toolName: spec.name,
            args,
            result,
            error: error instanceof Error ? error.message : String(error),
            startedAt,
            endedAt: Date.now()
          });
          return toolResult(result);
        }
      }
    });
    registered.push(spec.name);
  }
  return registered;
}
function recordToolCallSafely(
  environment: ClawchatToolEnvironment,
  record: ClawchatToolCallRecord
): void {
  try {
    environment.recordToolCall?.(record);
  } catch {
    // Audit persistence must not turn a completed side effect into a retryable tool failure.
  }
}


const TOOL_SPECS: ToolSpec[] = [
  {
    name: "clawchat_memory_search",
    label: "Search ClawChat Memory",
    description: "Search owner.md, users/*.md, and groups/*.md metadata and agent-authored body text.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      targetTypes: Type.Optional(Type.Array(TARGET_TYPE, { minItems: 1 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
    }),
    execute: async (args, env) =>
      env.memory.search(
        requiredString(args.query, "query"),
        optionalTargetTypes(args.targetTypes),
        optionalInteger(args.maxResults, 10)
      )
  },
  {
    name: "clawchat_memory_read",
    label: "Read ClawChat Memory",
    description: "Read one explicit local ClawChat memory Markdown target.",
    parameters: Type.Object({
      ...TARGET,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 0 }))
    }),
    execute: async (args, env) => {
      const memory = await env.memory.read(memoryTarget(args));
      const offset = optionalInteger(args.offset, 0);
      const limit = optionalInteger(args.limit, 12_000);
      return {
        targetType: memory.targetType,
        targetId: memory.targetId,
        exists: memory.exists,
        content: memory.content.slice(offset, offset + limit),
        metadata: memory.metadata,
        offset,
        limit,
        total: memory.content.length,
        truncated: offset + limit < memory.content.length
      };
    }
  },
  {
    name: "clawchat_memory_write",
    label: "Write ClawChat Memory",
    description: "Append or replace only the agent-authored body of one explicit memory target.",
    parameters: Type.Object({
      ...TARGET,
      mode: Type.String({ enum: ["append", "replace"] }),
      content: Type.String()
    }),
    execute: async (args, env) => {
      const target = memoryTarget(args);
      const mode = requiredString(args.mode, "mode");
      if (mode !== "append" && mode !== "replace") throw new Error("mode must be append or replace");
      await env.memory.writeBody(target, mode, String(args.content ?? ""));
      return { ok: true, ...target, mode };
    }
  },
  {
    name: "clawchat_memory_edit",
    label: "Edit ClawChat Memory",
    description: "Replace exactly one body text occurrence without changing synchronized metadata.",
    parameters: Type.Object({
      ...TARGET,
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String()
    }),
    execute: async (args, env) => {
      const target = memoryTarget(args);
      await env.memory.editBody(
        target,
        requiredString(args.oldText, "oldText"),
        String(args.newText ?? "")
      );
      return { ok: true, ...target };
    }
  },
  {
    name: "clawchat_metadata_sync",
    label: "Sync ClawChat Metadata",
    description: "Pull authoritative metadata or push selected locally synchronized fields.",
    parameters: Type.Object({
      ...TARGET,
      direction: Type.String({ enum: ["pull", "push"] }),
      fields: Type.Optional(Type.Array(Type.String(), { minItems: 1 }))
    }),
    execute: async (args, env) =>
      syncMetadata(
        env,
        memoryTarget(args),
        requiredString(args.direction, "direction"),
        optionalStringArray(args.fields)
      )
  },
  {
    name: "clawchat_metadata_update",
    label: "Update ClawChat Metadata",
    description: "Update allowed server metadata and refresh the local metadata block.",
    parameters: Type.Object({
      ...TARGET,
      patch: Type.Object(
        {
          nickname: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.String()),
          bio: Type.Optional(Type.String()),
          agent_behavior: Type.Optional(Type.String()),
          group_title: Type.Optional(Type.String()),
          group_description: Type.Optional(Type.String())
        },
        { additionalProperties: false, minProperties: 1 }
      )
    }),
    execute: async (args, env) =>
      updateMetadata(
        env,
        memoryTarget(args),
        requiredRecord(args.patch, "patch")
      )
  },
  apiSpec("clawchat_get_account_profile", "Get ClawChat Account Profile", "Fetch the connected account profile.", EMPTY, (args, env) => env.api.get("/v1/users/me")),
  apiSpec(
    "clawchat_get_user_profile",
    "Get ClawChat User Profile",
    "Fetch a public user profile by explicit userId.",
    Type.Object({ userId: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.get(`/v1/users/${encodeURIComponent(requiredString(args.userId, "userId"))}`)
  ),
  apiSpec("clawchat_list_account_friends", "List ClawChat Account Friends", "List connected-account friends.", EMPTY, (_args, env) => env.api.get("/v1/friendships")),
  apiSpec(
    "clawchat_send_friend_request",
    "Send ClawChat Friend Request",
    "Send a friend request to an explicit userId.",
    Type.Object({ userId: Type.String({ minLength: 1 }), greeting: Type.Optional(Type.String()) }),
    (args, env) =>
      env.api.post("/v1/friendships", {
        user_id: requiredString(args.userId, "userId"),
        ...(typeof args.greeting === "string" ? { greeting: args.greeting } : {})
      })
  ),
  apiSpec(
    "clawchat_list_friend_requests",
    "List ClawChat Friend Requests",
    "List incoming or outgoing pending friend requests.",
    Type.Object({ direction: Type.Optional(Type.String({ enum: ["incoming", "outgoing"] })) }),
    (args, env) => env.api.get(`/v1/friendships/requests/${typeof args.direction === "string" ? args.direction : "incoming"}`)
  ),
  requestDecisionSpec("accept"),
  requestDecisionSpec("reject"),
  apiSpec(
    "clawchat_remove_friend",
    "Remove ClawChat Friend",
    "Remove an accepted friend by explicit user id.",
    Type.Object({ friendUserId: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.delete(`/v1/friendships/${encodeURIComponent(requiredString(args.friendUserId, "friendUserId"))}`)
  ),
  apiSpec(
    "clawchat_search_users",
    "Search ClawChat Users",
    "Search the server-side user directory.",
    Type.Object({ q: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    (args, env) => env.api.get("/v1/users/search", { q: typeof args.q === "string" ? args.q : "", limit: optionalValueInteger(args.limit) })
  ),
  apiSpec(
    "clawchat_list_moments",
    "List ClawChat Moments",
    "List the visible moments feed.",
    Type.Object({ before: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    (args, env) => env.api.get("/v1/moments", { before: optionalValueInteger(args.before), limit: optionalValueInteger(args.limit) })
  ),
  momentIdSpec("clawchat_get_moment", "Get ClawChat Moment", "GET"),
  apiSpec(
    "clawchat_get_conversation",
    "Get ClawChat Conversation",
    "Fetch one conversation by explicit id.",
    Type.Object({ conversationId: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.get(`/v1/conversations/${encodeURIComponent(requiredString(args.conversationId, "conversationId"))}`)
  ),
  {
    ...apiSpec(
      "clawchat_leave_group",
      "Leave ClawChat Group",
      "Leave one group conversation.",
      Type.Object({ conversationId: Type.String({ minLength: 1 }) }),
      (args, env) => env.api.post(`/v1/conversations/${encodeURIComponent(requiredString(args.conversationId, "conversationId"))}/leave`)
    ),
    execute: async (args, env) => {
      const conversationId = requiredString(args.conversationId, "conversationId");
      const result = await env.api.post(`/v1/conversations/${encodeURIComponent(conversationId)}/leave`);
      await env.memory.delete(clawchatMemoryTarget("group", conversationId));
      await env.onConversationLeft?.(conversationId);
      return result;
    }
  },
  apiSpec(
    "clawchat_add_group_member",
    "Add ClawChat Group Member",
    "Add an explicit user to a group conversation.",
    Type.Object({ conversationId: Type.String({ minLength: 1 }), userId: Type.String({ minLength: 1 }) }),
    (args, env) =>
      env.api.post(`/v1/conversations/${encodeURIComponent(requiredString(args.conversationId, "conversationId"))}/members`, {
        user_id: requiredString(args.userId, "userId")
      })
  ),
  {
    name: "clawchat_no_reply",
    label: "Complete ClawChat Turn Without Reply",
    description:
      "Complete the Active Group Chat Turn without sending a ClawChat message. Use before producing text or calling another tool when no response is useful.",
    requiresGateway: true,
    parameters: EMPTY,
    execute: completeWithoutReply
  },
  {
    name: "clawchat_send_message",
    label: "Send ClawChat Message",
    description:
      "Send one message in the Active ClawChat Turn's conversation. Omit replyToCurrentMessage for an ordinary message; set it for an explicit reply; include mentions for structured mentions.",
    requiresGateway: true,
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      mentions: Type.Optional(Type.Array(
        Type.Object({ userId: Type.String({ minLength: 1 }), display: Type.String({ minLength: 1 }) }),
        { minItems: 1 }
      )),
      replyToCurrentMessage: Type.Optional(Type.Boolean())
    }),
    execute: sendMessage
  },
  {
    name: "clawchat_react_message",
    label: "React to ClawChat Message",
    description: "Add or remove an emoji reaction on a message in the Active ClawChat Turn.",
    requiresGateway: true,
    parameters: Type.Object({
      chatId: Type.String({ minLength: 1 }),
      emoji: Type.String({ minLength: 1 }),
      targetMessageId: Type.Optional(Type.String()),
      remove: Type.Optional(Type.Boolean())
    }),
    execute: sendReaction
  },
  apiSpec(
    "clawchat_create_moment",
    "Create ClawChat Moment",
    "Publish a moment with text and/or hosted image URLs.",
    Type.Object({ text: Type.Optional(Type.String()), images: Type.Optional(Type.Array(Type.String())) }),
    (args, env) => {
      const text = typeof args.text === "string" ? args.text : "";
      const images = optionalStringArray(args.images);
      if (!text.trim() && images.length === 0) throw new Error("at least one of text or images is required");
      return env.api.post("/v1/moments", { text, images });
    }
  ),
  momentIdSpec("clawchat_delete_moment", "Delete ClawChat Moment", "DELETE"),
  apiSpec(
    "clawchat_toggle_moment_reaction",
    "Toggle ClawChat Moment Reaction",
    "Toggle one emoji reaction on a moment.",
    Type.Object({ momentId: Type.Integer({ minimum: 1 }), emoji: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.post(`/v1/moments/${requiredPositiveInteger(args.momentId, "momentId")}/reactions`, { emoji: requiredString(args.emoji, "emoji") })
  ),
  apiSpec(
    "clawchat_create_moment_comment",
    "Create ClawChat Moment Comment",
    "Create a top-level comment on a moment.",
    Type.Object({ momentId: Type.Integer({ minimum: 1 }), text: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.post(`/v1/moments/${requiredPositiveInteger(args.momentId, "momentId")}/comments`, { text: requiredString(args.text, "text") })
  ),
  apiSpec(
    "clawchat_reply_moment_comment",
    "Reply To ClawChat Moment Comment",
    "Reply to an existing moment comment.",
    Type.Object({ momentId: Type.Integer({ minimum: 1 }), replyToCommentId: Type.Integer({ minimum: 1 }), text: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.post(`/v1/moments/${requiredPositiveInteger(args.momentId, "momentId")}/comments`, {
      text: requiredString(args.text, "text"),
      reply_to_comment_id: requiredPositiveInteger(args.replyToCommentId, "replyToCommentId")
    })
  ),
  apiSpec(
    "clawchat_delete_moment_comment",
    "Delete ClawChat Moment Comment",
    "Delete one comment from a moment.",
    Type.Object({ momentId: Type.Integer({ minimum: 1 }), commentId: Type.Integer({ minimum: 1 }) }),
    (args, env) => env.api.delete(`/v1/moments/${requiredPositiveInteger(args.momentId, "momentId")}/comments/${requiredPositiveInteger(args.commentId, "commentId")}`)
  ),
  {
    name: "clawchat_update_account_profile",
    label: "Update ClawChat Account Profile",
    description: "Update nickname, avatar URL, or bio on the connected account and refresh local owner metadata.",
    parameters: Type.Object({ nickname: Type.Optional(Type.String()), avatar_url: Type.Optional(Type.String()), bio: Type.Optional(Type.String()) }),
    execute: async (args, env) => {
      const patch = pickStringFields(args, ["nickname", "avatar_url", "bio"]);
      if (Object.keys(patch).length === 0) throw new Error("at least one profile field is required");
      const result = await env.api.patch("/v1/users/me", patch);
      await pullMetadata(env, clawchatMemoryTarget("owner", "owner"));
      return result;
    }
  },
  {
    name: "clawchat_upload_avatar_image",
    label: "Upload ClawChat Avatar Image",
    description: "Upload an absolute local image path for use as the connected account avatar.",
    parameters: Type.Object({ filePath: Type.String({ minLength: 1 }) }),
    execute: async (args, env) => uploadLocalFile(env.api, requiredString(args.filePath, "filePath"), "/v1/files/upload-url", true)
  },
  apiSpec(
    "clawchat_register_app",
    "Register Liveware App",
    "Register a liveware-tunneled web app to ClawChat.",
    Type.Object({ name: Type.String({ minLength: 1 }), appId: Type.String({ minLength: 1 }), url: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.post("/v1/agents/me/apps", {
      name: requiredString(args.name, "name"),
      app_id: requiredString(args.appId, "appId"),
      url: requiredHttpUrl(args.url)
    })
  ),
  apiSpec("clawchat_list_apps", "List Liveware Apps", "List apps registered by this agent.", EMPTY, (_args, env) => env.api.get("/v1/agents/me/apps")),
  apiSpec(
    "clawchat_unregister_app",
    "Unregister Liveware App",
    "Unregister one app by liveware app id.",
    Type.Object({ appId: Type.String({ minLength: 1 }) }),
    (args, env) => env.api.delete(`/v1/agents/me/apps/${encodeURIComponent(requiredString(args.appId, "appId"))}`)
  ),
  {
    name: "clawchat_liveware_login",
    label: "Liveware Login",
    description: "Log in to liveware using the active Host Profile token without exposing it to the model.",
    parameters: EMPTY,
    execute: (_args, env) => livewareLogin(env)
  }
];

export async function uploadClawchatMediaFile(api: ClawchatApiClient, filePath: string): Promise<Record<string, unknown>> {
  return uploadLocalFile(api, filePath, "/media/upload", false);
}

function apiSpec(
  name: string,
  label: string,
  description: string,
  parameters: TSchema,
  execute: ToolSpec["execute"]
): ToolSpec {
  return { name, label, description, parameters, execute };
}

function requestDecisionSpec(decision: "accept" | "reject"): ToolSpec {
  const title = decision === "accept" ? "Accept" : "Reject";
  return apiSpec(
    `clawchat_${decision}_friend_request`,
    `${title} ClawChat Friend Request`,
    `${title} one pending incoming friend request.`,
    Type.Object({ requestId: Type.Integer({ minimum: 1 }) }),
    (args, env) => env.api.post(`/v1/friendships/requests/${requiredPositiveInteger(args.requestId, "requestId")}/${decision}`)
  );
}

function momentIdSpec(name: string, label: string, method: "GET" | "DELETE"): ToolSpec {
  return apiSpec(name, label, `${label} by concrete id.`, Type.Object({ momentId: Type.Integer({ minimum: 1 }) }), (args, env) => {
    const path = `/v1/moments/${requiredPositiveInteger(args.momentId, "momentId")}`;
    return method === "GET" ? env.api.get(path) : env.api.delete(path);
  });
}

interface MetadataTargetHandler {
  allowedPatchFields: ReadonlySet<string>;
  pull: (
    env: ClawchatToolEnvironment,
    target: ClawchatMemoryTarget
  ) => Promise<Record<string, unknown>>;
  update: (
    env: ClawchatToolEnvironment,
    target: ClawchatMemoryTarget,
    patch: Record<string, unknown>
  ) => Promise<void>;
}

const METADATA_TARGET_HANDLERS: Record<ClawchatMemoryTargetType, MetadataTargetHandler> = {
  owner: {
    allowedPatchFields: new Set(["agent_behavior"]),
    pull: pullOwnerMetadata,
    update: async (env, _target, patch) => {
      const behavior = requiredString(patch.agent_behavior, "patch.agent_behavior");
      await env.api.patch("/v1/agents/me/behavior", { behavior });
    }
  },
  user: {
    allowedPatchFields: new Set(["nickname", "avatar_url", "bio"]),
    pull: pullUserMetadata,
    update: async (env, target, patch) => {
      if (target.targetId !== env.profile().agent.userId) {
        throw new Error("user metadata update is allowed only for the connected user");
      }
      await env.api.patch(
        "/v1/users/me",
        pickStringFields(patch, ["nickname", "avatar_url", "bio"])
      );
    }
  },
  group: {
    allowedPatchFields: new Set(["group_title", "group_description"]),
    pull: pullGroupMetadata,
    update: async (env, target, patch) => {
      await env.api.patch(`/v1/conversations/${encodeURIComponent(target.targetId)}`, {
        ...(typeof patch.group_title === "string" ? { title: patch.group_title } : {}),
        ...(typeof patch.group_description === "string"
          ? { description: patch.group_description }
          : {})
      });
    }
  }
};

async function syncMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget,
  direction: string,
  fields: string[]
): Promise<unknown> {
  if (direction === "pull") return pullMetadata(env, target);
  if (direction !== "push") throw new Error("direction must be pull or push");
  if (fields.length === 0) throw new Error("fields are required for direction=push");
  const memory = await env.memory.read(target);
  const patch: Record<string, string> = {};
  for (const field of fields) {
    const value = memory.metadata[field];
    if (value === undefined) throw new Error(`missing_metadata_field:${field}`);
    patch[field] = value;
  }
  return updateMetadata(env, target, patch);
}

async function updateMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget,
  patch: Record<string, unknown>
): Promise<unknown> {
  const handler = METADATA_TARGET_HANDLERS[target.targetType];
  const unsupported = Object.keys(patch).filter(
    (field) => !handler.allowedPatchFields.has(field)
  );
  if (unsupported.length > 0) {
    throw new Error(`unsupported metadata patch fields: ${unsupported.sort().join(", ")}`);
  }
  const nonStrings = Object.entries(patch)
    .filter(([, value]) => typeof value !== "string")
    .map(([field]) => field);
  if (nonStrings.length > 0) {
    throw new Error(`metadata patch values must be strings: ${nonStrings.sort().join(", ")}`);
  }
  await handler.update(env, target, patch);
  return pullMetadata(env, target);
}

function pullMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget
): Promise<Record<string, unknown>> {
  return METADATA_TARGET_HANDLERS[target.targetType].pull(env, target);
}

async function pullOwnerMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget
): Promise<Record<string, unknown>> {
  const profile = env.profile();
  const agentId = profile.agent.id;
  if (!agentId) throw new Error("agent id is required for owner metadata sync");
  const [agentResult, ownerResult] = await Promise.all([
    env.api.get(`/v1/agents/${encodeURIComponent(agentId)}`),
    env.api.get("/v1/agents/me/owner")
  ]);
  const agent = unwrapDetail(agentResult, "agent");
  const owner = unwrapDetail(ownerResult, "user");
  const metadata: Record<string, unknown> = {
    agent_user_id: profile.agent.userId,
    agent_owner_id: profile.agent.ownerId,
    agent_nickname: firstValue(agent, ["nickname", "name"]),
    agent_avatar_url: firstValue(agent, ["avatar_url", "avatarUrl"]),
    agent_bio: agent.bio,
    agent_behavior: firstValue(agent, ["behavior", "agent_behavior"]),
    agent_owner_nickname: owner.nickname,
    agent_owner_avatar_url: firstValue(owner, ["avatar_url", "avatarUrl"]),
    agent_owner_bio: owner.bio,
    agent_owner_locale: owner.locale
  };
  await env.memory.writeMetadata(target, metadata);
  return { ok: true, ...target, metadata };
}

async function pullUserMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget
): Promise<Record<string, unknown>> {
  const result = await env.api.get(`/v1/users/${encodeURIComponent(target.targetId)}`);
  const user = unwrapDetail(result, "user");
  const metadata: Record<string, unknown> = {
    id: target.targetId,
    nickname: user.nickname,
    avatar_url: firstValue(user, ["avatar_url", "avatarUrl"]),
    bio: user.bio,
    profile_type: firstValue(user, ["profile_type", "type"]),
    updated_at: firstValue(user, ["updated_at", "updatedAt"])
  };
  await env.memory.writeMetadata(target, metadata);
  return { ok: true, ...target, metadata };
}

async function pullGroupMetadata(
  env: ClawchatToolEnvironment,
  target: ClawchatMemoryTarget
): Promise<Record<string, unknown>> {
  const refreshGeneration = env.memory.beginMetadataRefresh(target);
  const result = await env.api.get(
    `/v1/conversations/${encodeURIComponent(target.targetId)}`
  );
  const conversation = unwrapDetail(result, "conversation");
  const participants = Array.isArray(conversation.participants)
    ? conversation.participants.filter(isUnknownRecord)
    : undefined;
  const participantIds = (participants ?? [])
    .map((participant) => firstValue(participant, ["id", "user_id", "userId"]))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  await materializeClawchatGroupMemory({
    api: env.api,
    memory: env.memory,
    chatId: target.targetId,
    conversationState: result,
    requireGroup: true,
    refreshGeneration
  });
  const current = await env.memory.read(target);
  const failures: Array<Record<string, string>> = [];
  for (const userId of participantIds) {
    const userTarget = clawchatMemoryTarget("user", userId);
    const existing = await env.memory.read(userTarget);
    if (existing.exists) continue;
    try {
      await pullMetadata(env, userTarget);
    } catch (error: unknown) {
      failures.push({
        targetType: "user",
        targetId: userId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    ok: failures.length === 0,
    ...target,
    metadata: current.metadata,
    partialFailures: failures
  };
}

async function completeWithoutReply(
  _args: Record<string, unknown>,
  env: ClawchatToolEnvironment
): Promise<unknown> {
  const turn = requireActiveTurn(env);
  if (turn.chatType !== "group" || turn.mentionKind === "direct") {
    throw new Error(
      "clawchat_no_reply is available only for group messages that do not directly mention the Agent"
    );
  }
  return {
    ok: true,
    silent: true,
    terminal: true,
    noFollowupReply: true,
    instruction: "Silent Turn selected. Do not produce assistant text or call another tool."
  };
}

async function sendMessage(args: Record<string, unknown>, env: ClawchatToolEnvironment): Promise<unknown> {
  const turn = requireActiveTurn(env);
  if (args.text !== undefined && typeof args.text !== "string") throw new Error("text must be a string");
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const mentions = parseMessageMentions(args.mentions);
  if (!text && mentions.length === 0) throw new Error("text or mentions is required");
  if (args.replyToCurrentMessage !== undefined && typeof args.replyToCurrentMessage !== "boolean") {
    throw new Error("replyToCurrentMessage must be a boolean");
  }

  const replyToCurrentMessage = args.replyToCurrentMessage === true;
  if (replyToCurrentMessage && (!turn.messageId || !turn.sender || !turn.preview)) {
    throw new Error("The Active ClawChat Turn has no current message to reply to");
  }
  const mentionFragments = mentions.map((mention) => ({
    kind: "mention" as const,
    user_id: mention.userId,
    display: mention.display
  }));
  const fragments: Array<Record<string, unknown>> = [...mentionFragments];
  if (text) fragments.push({ kind: "text", text: mentions.length > 0 ? ` ${text}` : text });
  const now = env.now?.() ?? Date.now();
  const traceId = `pi-tool-${env.idFactory?.() ?? crypto.randomUUID()}`;
  await env.sendFrame?.({
    version: "2",
    event: replyToCurrentMessage ? "message.reply" : "message.send",
    trace_id: traceId,
    emitted_at: now,
    chat_id: turn.chatId,
    to: { id: turn.chatId, type: turn.chatType },
    payload: {
      message_mode: "normal",
      message: {
        body: { fragments },
        context: {
          mentions: mentionFragments,
          reply: replyToCurrentMessage
            ? {
                reply_to_msg_id: turn.messageId,
                reply_preview: {
                  id: turn.sender!.id,
                  ...(turn.sender!.nick_name ? { nick_name: turn.sender!.nick_name } : {}),
                  fragments: turn.preview
                }
              }
            : null
        }
      }
    }
  });
  return {
    sent: true,
    terminal: true,
    noFollowupReply: true,
    instruction: "The ClawChat message has already been sent; do not send a duplicate normal follow-up reply.",
    traceId,
    delivery: replyToCurrentMessage ? "reply" : mentions.length > 0 ? "mention" : "normal",
    mentions: mentions.map((mention) => mention.userId)
  };
}

function parseMessageMentions(value: unknown): Array<{ userId: string; display: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) throw new Error("mentions must be a non-empty array");
  const seen = new Set<string>();
  const mentions: Array<{ userId: string; display: string }> = [];
  for (const [index, raw] of value.entries()) {
    if (!isUnknownRecord(raw)) throw new Error(`mentions[${index}] must be an object`);
    const userId = requiredString(raw.userId, `mentions[${index}].userId`);
    if (seen.has(userId)) continue;
    seen.add(userId);
    const display = requiredString(raw.display, `mentions[${index}].display`).replace(/^@/, "");
    if (!display) throw new Error(`mentions[${index}].display is required`);
    mentions.push({ userId, display });
  }
  return mentions;
}

async function sendReaction(args: Record<string, unknown>, env: ClawchatToolEnvironment): Promise<unknown> {
  const turn = requireActiveTurn(env);
  const chatId = requiredString(args.chatId, "chatId");
  if (chatId !== turn.chatId) throw new Error("chatId must match the Active ClawChat Turn");
  const targetMessageId = typeof args.targetMessageId === "string" && args.targetMessageId.trim()
    ? args.targetMessageId.trim()
    : requiredString(turn.messageId, "targetMessageId");
  const emoji = requiredString(args.emoji, "emoji");
  await env.sendFrame?.({
    version: "2",
    event: "message.reaction",
    trace_id: `pi-tool-${env.idFactory?.() ?? crypto.randomUUID()}`,
    emitted_at: env.now?.() ?? Date.now(),
    chat_id: chatId,
    to: { id: chatId, type: turn.chatType },
    payload: { target_message_id: targetMessageId, emoji, removed: args.remove === true }
  });
  return { reacted: true, targetMessageId, emoji, removed: args.remove === true };
}

function requireActiveTurn(env: ClawchatToolEnvironment): ActiveClawchatTurn {
  const turn = env.activeTurn?.();
  if (!turn) throw new Error("This tool requires an Active ClawChat Turn");
  return turn;
}

async function uploadLocalFile(
  api: ClawchatApiClient,
  filePath: string,
  endpoint: string,
  requireImage: boolean
): Promise<Record<string, unknown>> {
  if (!isAbsolute(filePath)) throw new Error(`filePath must be absolute (got ${JSON.stringify(filePath)})`);
  await access(filePath);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`not a regular file: ${filePath}`);
  if (info.size <= 0) throw new Error(`file is empty: ${filePath}`);
  if (info.size > MAX_UPLOAD_BYTES) throw new Error(`file too large (${info.size} bytes; max ${MAX_UPLOAD_BYTES})`);
  const mime = inferMime(filePath);
  if (requireImage && !mime.startsWith("image/")) throw new Error(`avatar file must be an image (got ${mime})`);
  return api.upload(endpoint, { bytes: await readFile(filePath), filename: basename(filePath), mime });
}

async function livewareLogin(env: ClawchatToolEnvironment): Promise<unknown> {
  const executable = env.livewareExecutable ?? await env.ensureLivewareExecutable?.() ?? "liveware";
  const token = env.profile().accessToken;
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const child = spawn(executable, ["login", "--access-token", token], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const finish = (result: unknown) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ error: "validation", message: "liveware login timed out" });
  }, 30_000);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => {
    clearTimeout(timer);
    finish({ error: "validation", message: error.message.includes("ENOENT") ? "liveware CLI not found in PATH" : error.message });
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      finish({ ok: true });
      return;
    }
    const detail = Buffer.concat(stderr.length > 0 ? stderr : stdout).toString("utf8").replaceAll(token, "***").trim();
    finish({ error: "subprocess", message: `liveware login failed (exit ${code ?? "unknown"}): ${detail}` });
  });
  return promise;
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result
  };
}

function mapToolError(error: unknown): Record<string, unknown> {
  if (error instanceof ClawchatApiError) {
    const code = error.options.code;
    if (code === 21001 || code === 21003) {
      const pending = code === 21001;
      return {
        error: "permission",
        status: pending ? "pending" : "forbidden",
        retryable: false,
        message: pending
          ? "This operation requires owner approval and is pending. Do not retry; wait for the result in chat."
          : "This operation is forbidden by owner policy. Do not retry until the policy changes.",
        ...(typeof error.options.data?.request_id === "string" ? { request_id: error.options.data.request_id } : {}),
        meta: error.options
      };
    }
    return { error: error.kind, message: error.message, meta: error.options };
  }
  return { error: "validation", message: error instanceof Error ? error.message : String(error) };
}
function memoryTarget(args: Record<string, unknown>): ClawchatMemoryTarget {
  return clawchatMemoryTarget(args.targetType, args.targetId);
}


function targetType(value: unknown): ClawchatMemoryTargetType {
  if (value !== "owner" && value !== "user" && value !== "group") {
    throw new Error("targetType must be owner, user, or group");
  }
  return value;
}

function optionalTargetTypes(value: unknown): ClawchatMemoryTargetType[] {
  if (value === undefined) return ["owner", "user", "group"];
  if (!Array.isArray(value) || value.length === 0) throw new Error("targetTypes must be a non-empty array");
  return value.map(targetType);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function optionalInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error("expected a non-negative integer");
  return Number(value);
}

function optionalValueInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Number.isInteger(value)) throw new Error("expected an integer");
  return Number(value);
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("expected a string array");
  return value as string[];
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isUnknownRecord(value) || Object.keys(value).length === 0) throw new Error(`${field} must be a non-empty object`);
  return value;
}

function requiredHttpUrl(value: unknown): string {
  const input = requiredString(value, "url");
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must use http or https");
  return input;
}

function pickStringFields(source: Record<string, unknown>, fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    if (typeof source[field] === "string") result[field] = source[field];
  }
  return result;
}

function unwrapDetail(value: unknown, key: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) return {};
  const nested = value[key];
  if (isUnknownRecord(nested)) return nested;
  const detail = value.detail;
  return isUnknownRecord(detail) ? detail : value;
}

function firstValue(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}


function inferMime(path: string): string {
  const extension = extname(path).toLowerCase();
  const byExtension: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip"
  };
  return byExtension[extension] ?? "application/octet-stream";
}
