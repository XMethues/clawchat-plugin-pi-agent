import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-extension-"));
    const workspace = join(agentDir, "workspace");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    const notify = vi.fn();
    vi.stubEnv("CLAWCHAT_BASE_URL", "https://api.example.test/");
    vi.stubEnv("CLAWCHAT_WS_URL", "wss://gateway.example.test/ws");
    vi.stubEnv("CLAWCHAT_MEDIA_URL", "https://media.example.test/");
    const activate = vi.fn(async () => ({
      accessToken: "opaque-token",
      restUrl: "https://api.example.test",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
    }));

    createClawchatPiExtension({ activate, profiles })(pi.api as never);
    const commandContext = {
      cwd: workspace,
      ui: { notify }
    } as unknown as ExtensionCommandContext;
    await pi.commands.get("clawchat-activate")!.handler("CODE1", commandContext);

    expect(activate).toHaveBeenCalledWith({
      code: "CODE1",
      restUrl: "https://api.example.test/",
      deviceId: "clawchat-pi-device-1"
    });
    await expect(profiles.load("default")).resolves.toMatchObject({
      restUrl: "https://api.example.test",
      websocketUrl: "wss://gateway.example.test/ws",
      mediaUrl: "https://media.example.test",
      accessToken: "opaque-token",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
    });
    expect(notify).toHaveBeenCalledWith("ClawChat activated and saved.", "info");
    const operationLease = await profiles.acquireOperationLease("default");
    await operationLease.release();
  });

  it("rejects Activation before redemption while another profile operation is active", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-extension-"));
    const profiles = new HostProfileRepository({ agentDir });
    const activeOperation = await profiles.acquireOperationLease("default");
    const pi = fakePi();
    const notify = vi.fn();
    const activate = vi.fn();
    createClawchatPiExtension({ profiles, activate })(pi.api as never);
    const commandContext = {
      cwd: "/workspace",
      ui: { notify }
    } as unknown as ExtensionCommandContext;

    await pi.commands.get("clawchat-activate")!.handler("CODE1", commandContext);

    expect(activate).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Host Profile 'default' already has an active operation",
      "error"
    );
    await activeOperation.release();
  });

  it("holds the operation lease until a failed redemption settles, then releases it", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-extension-"));
    const profiles = new HostProfileRepository({ agentDir });
    const pi = fakePi();
    const notify = vi.fn();
    const redemptionStarted = Promise.withResolvers<void>();
    const redemption = Promise.withResolvers<never>();
    createClawchatPiExtension({
      profiles,
      prepareState: vi.fn(async () => ({
        deviceId: "clawchat-pi-device-1",
        workspace: "/workspace"
      })),
      activate: vi.fn(() => {
        redemptionStarted.resolve();
        return redemption.promise;
      })
    })(pi.api as never);
    const commandContext = {
      cwd: "/workspace",
      ui: { notify }
    } as unknown as ExtensionCommandContext;

    const command = pi.commands.get("clawchat-activate")!.handler("CODE1", commandContext);
    await redemptionStarted.promise;
    await expect(profiles.acquireOperationLease("default")).rejects.toThrow("active operation");
    redemption.reject(new Error("redemption failed"));
    await command;

    expect(notify).toHaveBeenCalledWith("redemption failed", "error");
    const operationLease = await profiles.acquireOperationLease("default");
    await operationLease.release();

  });

  it("holds the operation lease through post-Activation state restoration", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-extension-"));
    const profiles = new HostProfileRepository({ agentDir });
    const pi = fakePi();
    const restoreStarted = Promise.withResolvers<void>();
    const restored = Promise.withResolvers<null>();
    let loadCount = 0;
    createClawchatPiExtension({
      profiles,
      prepareState: vi.fn(async () => ({
        deviceId: "clawchat-pi-device-1",
        workspace: "/workspace"
      })),
      activate: vi.fn(async () => ({
        accessToken: "token-1",
        restUrl: "https://app.clawling.com",
        agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
      })),
      saveState: vi.fn(async () => "/tmp/profile.json"),
      loadState: vi.fn(async () => {
        loadCount += 1;
        if (loadCount === 1) return null;
        restoreStarted.resolve();
        return restored.promise;
      })
    })(pi.api as never);
    await pi.handlers.get("session_start")!({}, sessionContext());
    const commandContext = {
      cwd: "/workspace",
      ui: { notify: vi.fn() }
    } as unknown as ExtensionCommandContext;

    const command = pi.commands.get("clawchat-activate")!.handler("CODE1", commandContext);
    await restoreStarted.promise;
    await expect(profiles.acquireOperationLease("default")).rejects.toThrow("active operation");
    restored.resolve(null);
    await command;

    const operationLease = await profiles.acquireOperationLease("default");
    await operationLease.release();
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
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://app.clawling.com",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        agent: { id: "agent-1", userId: "agent-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: "wss://app.clawling.com/ws",
        mediaUrl: "https://media.example.test"
      }
    );
    const pi = fakePi();
    const setStatus = vi.fn();
    createClawchatPiExtension({ profiles })(pi.api as never);

    await pi.handlers.get("session_start")!({}, sessionContext(setStatus));

    expect(pi.tools.size).toBe(32);
    expect(pi.tools.has("clawchat_get_account_profile")).toBe(true);
    expect(pi.tools.has("clawchat_memory_read")).toBe(true);
    expect(pi.tools.has("clawchat_send_message")).toBe(false);
    expect(pi.tools.has("clawchat_react_message")).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("clawchat", "profile ready");

    const prompt = await pi.handlers.get("before_agent_start")!({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("registered `clawchat_*` tools");
    await pi.handlers.get("session_shutdown")!({});
    expect(setStatus).toHaveBeenLastCalledWith("clawchat", undefined);
  });
});
