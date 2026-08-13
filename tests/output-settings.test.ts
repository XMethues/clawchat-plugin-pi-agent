import { describe, expect, it } from "vitest";
import {
  defaultClawchatOutputSettings,
  normalizeClawchatOutputSettings,
  parseOutputModeCommand,
  resolveOutputMode,
  withOutputModeOverride
} from "../src/output-settings.js";

describe("ClawChat output settings", () => {
  it("uses normal until a chat selects another output mode", () => {
    const defaults = defaultClawchatOutputSettings();
    expect(resolveOutputMode(defaults, "chat-1")).toBe("normal");

    const full = withOutputModeOverride(defaults, "chat-1", "full");
    expect(resolveOutputMode(full, "chat-1")).toBe("full");
    expect(resolveOutputMode(full, "chat-2")).toBe("normal");
  });

  it("removes a chat override when it inherits", () => {
    const full = withOutputModeOverride(defaultClawchatOutputSettings(), "chat-1", "full");
    const inherited = withOutputModeOverride(full, "chat-1", "inherit");

    expect(inherited.chatOverrides).toEqual({});
    expect(resolveOutputMode(inherited, "chat-1")).toBe("normal");
  });

  it("accepts only minimal, normal, full, and inherit command arguments", () => {
    expect(parseOutputModeCommand("minimal")).toBe("minimal");
    expect(parseOutputModeCommand("FULL")).toBe("full");
    expect(parseOutputModeCommand("inherit")).toBe("inherit");
    expect(parseOutputModeCommand("tools on")).toBeUndefined();
    expect(parseOutputModeCommand("verbose")).toBeUndefined();
  });

  it("normalizes current modes and migrates legacy tool visibility settings", () => {
    expect(
      normalizeClawchatOutputSettings({
        modeDefault: "minimal",
        chatOverrides: { a: "full", b: "invalid" }
      })
    ).toEqual({ modeDefault: "minimal", chatOverrides: { a: "full" } });
    expect(
      normalizeClawchatOutputSettings({
        toolCallsDefault: "on",
        chatOverrides: { a: "off", b: "on" }
      })
    ).toEqual({ modeDefault: "full", chatOverrides: { a: "normal", b: "full" } });
  });
});
