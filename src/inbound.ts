import type { ClawchatFragment, ClawchatInboundMessage } from "./types.js";

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

export function renderInboundPromptHeader(message: ClawchatInboundMessage): string {
  const senderName = message.sender.nick_name?.trim() || message.sender.id;
  return `ClawChat ${message.chat_type} message from ${senderName}:`;
}

export function renderInboundPrompt(message: ClawchatInboundMessage): string {
  const text = extractInboundText(message);
  if (!text) return "";

  return [renderInboundPromptHeader(message), text].join("\n");
}
