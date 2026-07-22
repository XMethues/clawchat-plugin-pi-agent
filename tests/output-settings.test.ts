import { describe, expect, it } from "vitest";
import {
  defaultClawchatOutputSettings,
  parseToolOutputCommand,
  resolveToolOutput,
  withToolOutputOverride
} from "../src/output-settings.js";

describe("ClawChat output settings", () => {
  it("uses the profile default until a chat overrides it", () => {
    const defaults = defaultClawchatOutputSettings();
    expect(resolveToolOutput(defaults, "chat-1")).toBe("off");

    const enabled = withToolOutputOverride(defaults, "chat-1", "on");
    expect(resolveToolOutput(enabled, "chat-1")).toBe("on");
    expect(resolveToolOutput(enabled, "chat-2")).toBe("off");
  });

  it("removes a chat override when it inherits", () => {
    const enabled = withToolOutputOverride(defaultClawchatOutputSettings(), "chat-1", "on");
    const inherited = withToolOutputOverride(enabled, "chat-1", "inherit");

    expect(inherited.chatOverrides).toEqual({});
    expect(resolveToolOutput(inherited, "chat-1")).toBe("off");
  });

  it("accepts only the documented slash-command arguments", () => {
    expect(parseToolOutputCommand("tools on")).toBe("on");
    expect(parseToolOutputCommand("TOOLS inherit")).toBe("inherit");
    expect(parseToolOutputCommand("tools verbose")).toBeUndefined();
    expect(parseToolOutputCommand("on")).toBeUndefined();
  });
});
