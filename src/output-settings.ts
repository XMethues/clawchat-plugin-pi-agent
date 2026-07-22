export type ToolOutputValue = "on" | "off";
export type ToolOutputOverride = ToolOutputValue | "inherit";

export interface ClawchatOutputSettings {
  toolCallsDefault: ToolOutputValue;
  chatOverrides: Record<string, ToolOutputValue>;
}

export function defaultClawchatOutputSettings(): ClawchatOutputSettings {
  return {
    toolCallsDefault: "off",
    chatOverrides: {}
  };
}

export function normalizeClawchatOutputSettings(value: unknown): ClawchatOutputSettings {
  if (!value || typeof value !== "object") return defaultClawchatOutputSettings();

  const candidate = value as Partial<ClawchatOutputSettings>;
  const toolCallsDefault = candidate.toolCallsDefault === "on" ? "on" : "off";
  const chatOverrides: Record<string, ToolOutputValue> = {};
  if (candidate.chatOverrides && typeof candidate.chatOverrides === "object") {
    for (const [chatId, override] of Object.entries(candidate.chatOverrides)) {
      if (override === "on" || override === "off") chatOverrides[chatId] = override;
    }
  }

  return { toolCallsDefault, chatOverrides };
}

export function resolveToolOutput(settings: ClawchatOutputSettings, chatId: string): ToolOutputValue {
  return settings.chatOverrides[chatId] ?? settings.toolCallsDefault;
}

export function withToolOutputOverride(
  settings: ClawchatOutputSettings,
  chatId: string,
  override: ToolOutputOverride
): ClawchatOutputSettings {
  const chatOverrides = { ...settings.chatOverrides };
  if (override === "inherit") {
    delete chatOverrides[chatId];
  } else {
    chatOverrides[chatId] = override;
  }
  return { ...settings, chatOverrides };
}

export function parseToolOutputCommand(args: string): ToolOutputOverride | undefined {
  const [subject, value, ...rest] = args.trim().toLowerCase().split(/\s+/);
  if (subject !== "tools" || rest.length > 0) return undefined;
  return value === "on" || value === "off" || value === "inherit" ? value : undefined;
}
