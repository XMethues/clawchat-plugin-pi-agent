import type { ClawchatInboundMessage } from "./types.js";

export function extractInboundText(message: ClawchatInboundMessage): string {
  return message.payload.message.body.fragments
    .filter((fragment) => fragment.kind === "text")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
}

export function renderInboundPrompt(message: ClawchatInboundMessage): string {
  const text = extractInboundText(message);
  if (!text) return "";

  const senderName = message.sender.nick_name?.trim() || message.sender.id;
  return [`ClawChat ${message.chat_type} message from ${senderName}:`, text].join("\n");
}
