import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createClawchatPiExtension } from "../src/extension.js";
import { HostProfileRepository } from "../src/host-profile.js";

function fakePi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, unknown>();
  return {
    handlers,
    commands,
    tools,
    api: {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      registerCommand: vi.fn((
        name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
      ) => commands.set(name, command)),
      registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool))
    }
  };
}

function sessionContext(setStatus: (key: string, message?: string) => void = vi.fn()) {
  return {
    isIdle: () => true,
    ui: { notify: vi.fn(), setStatus }
  };
}

describe("ClawChat Pi Management Extension", () => {
  it("registers management lifecycle only and never owns remote-turn handlers", () => {
    const pi = fakePi();

    createClawchatPiExtension()(pi.api as never);

    expect(pi.commands.has("clawchat-activate")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(false);
    expect(pi.handlers.has("agent_settled")).toBe(false);
  });

  it("saves explicit Profile Rebinding without exposing the activation token", async () => {
    const pi = fakePi();
    const notify = vi.fn();
    const activate = vi.fn(async () => ({
      accessToken: "token-1",
      baseUrl: "https://app.clawling.com",
      agent: { userId: "user-1", ownerId: "owner-1" }
    }));
    const saveState = vi.fn(async () => "/tmp/profile.json");
    const prepareState = vi.fn(async () => ({
      deviceId: "clawchat-pi-device-1",
      workspace: "/workspace"
    }));

    createClawchatPiExtension({ activate, prepareState, saveState })(pi.api as never);
    const commandContext = {
      cwd: "/workspace",
      ui: { notify }
    } as unknown as ExtensionCommandContext;
    await pi.commands.get("clawchat-activate")!.handler("CODE1", commandContext);

    expect(activate).toHaveBeenCalledWith({
      code: "CODE1",
      baseUrl: "https://app.clawling.com",
      deviceId: "clawchat-pi-device-1"
    });
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "token-1" }),
      expect.objectContaining({ workspace: "/workspace", resetIdentityState: true })
    );
    expect(notify).toHaveBeenCalledWith("ClawChat activated and saved.", "info");
  });

  it("automatically registers REST and local tools from an activated Host Profile", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-extension-"));
    const workspace = join(agentDir, "workspace");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation("default", {
      baseUrl: "https://app.clawling.com",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      agent: { userId: "agent-1", ownerId: "owner-1" }
    });
    const pi = fakePi();
    const setStatus = vi.fn();
    createClawchatPiExtension({ profiles })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext(setStatus));

    expect(pi.tools.size).toBe(32);
    expect(pi.tools.has("clawchat_get_account_profile")).toBe(true);
    expect(pi.tools.has("clawchat_memory_read")).toBe(true);
    expect(pi.tools.has("clawchat_mention_message")).toBe(false);
    expect(pi.tools.has("clawchat_react_message")).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("clawchat", "profile ready");

    const prompt = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("registered `clawchat_*` tools");
    await pi.handlers.get("session_shutdown")!({});
    expect(setStatus).toHaveBeenLastCalledWith("clawchat", undefined);
  });
});
