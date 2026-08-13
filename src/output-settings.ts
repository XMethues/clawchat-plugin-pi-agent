export type ClawchatOutputMode = "minimal" | "normal" | "full";
export type ClawchatOutputModeOverride = ClawchatOutputMode | "inherit";

export interface ClawchatOutputSettings {
  modeDefault: ClawchatOutputMode;
  chatOverrides: Record<string, ClawchatOutputMode>;
}

export function defaultClawchatOutputSettings(): ClawchatOutputSettings {
  return {
    modeDefault: "normal",
    chatOverrides: {}
  };
}

export function normalizeClawchatOutputSettings(value: unknown): ClawchatOutputSettings {
  if (!value || typeof value !== "object") return defaultClawchatOutputSettings();

  const candidate = value as Record<string, unknown>;
  const modeDefault = normalizeMode(candidate.modeDefault) ??
    normalizeLegacyToolVisibility(candidate.toolCallsDefault) ??
    "normal";
  const chatOverrides: Record<string, ClawchatOutputMode> = {};
  if (candidate.chatOverrides && typeof candidate.chatOverrides === "object") {
    for (const [chatId, override] of Object.entries(candidate.chatOverrides)) {
      const mode = normalizeMode(override) ?? normalizeLegacyToolVisibility(override);
      if (mode) chatOverrides[chatId] = mode;
    }
  }

  return { modeDefault, chatOverrides };
}

export function resolveOutputMode(settings: ClawchatOutputSettings, chatId: string): ClawchatOutputMode {
  return settings.chatOverrides[chatId] ?? settings.modeDefault;
}

export function withOutputModeOverride(
  settings: ClawchatOutputSettings,
  chatId: string,
  override: ClawchatOutputModeOverride
): ClawchatOutputSettings {
  const chatOverrides = { ...settings.chatOverrides };
  if (override === "inherit") {
    delete chatOverrides[chatId];
  } else {
    chatOverrides[chatId] = override;
  }
  return { ...settings, chatOverrides };
}

export function parseOutputModeCommand(args: string): ClawchatOutputModeOverride | undefined {
  const value = args.trim().toLowerCase();
  return isOutputMode(value) || value === "inherit" ? value : undefined;
}

function normalizeMode(value: unknown): ClawchatOutputMode | undefined {
  return typeof value === "string" && isOutputMode(value) ? value : undefined;
}

function normalizeLegacyToolVisibility(value: unknown): ClawchatOutputMode | undefined {
  if (value === "on") return "full";
  if (value === "off") return "normal";
  return undefined;
}

function isOutputMode(value: string): value is ClawchatOutputMode {
  return value === "minimal" || value === "normal" || value === "full";
}
