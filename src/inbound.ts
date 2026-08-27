import type { ClawchatFragment, ClawchatInboundMessage } from "./types.js";

export type ClawchatGroupMention = "direct" | "everyone" | "none";

export function extractInboundText(message: ClawchatInboundMessage): string {
  return message.payload.message.body.fragments
    .filter((fragment) => fragment.kind === "text")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
}

export function hasMediaFragments(fragments: readonly ClawchatFragment[]): boolean {
  return fragments.some(
    (fragment) =>
      fragment.kind === "image" ||
      fragment.kind === "file" ||
      fragment.kind === "audio" ||
      fragment.kind === "video"
  );
}

export function classifyGroupMention(
  message: ClawchatInboundMessage,
  agentUserId: string
): ClawchatGroupMention {
  if (message.chat_type !== "group") return "none";
  const mentions = message.payload.message.context?.mentions;
  if (!Array.isArray(mentions)) return "none";
  let everyone = false;
  for (const mention of mentions) {
    const userId = typeof mention === "string"
      ? mention
      : mention && typeof mention === "object" && "user_id" in mention
        ? mention.user_id
        : undefined;
    if (userId === agentUserId) return "direct";
    if (userId === "all") everyone = true;
  }
  return everyone ? "everyone" : "none";
}

export function renderInboundPromptHeader(message: ClawchatInboundMessage): string {
  const senderName = message.sender.nick_name?.trim() || message.sender.id;
  return `ClawChat ${message.chat_type} message from ${senderName}:`;
}

export function renderInboundPrompt(message: ClawchatInboundMessage): string {
  const text = extractInboundText(message);
  if (!text) return "";

  return [renderInboundPromptHeader(message), text].join("\n");
}
