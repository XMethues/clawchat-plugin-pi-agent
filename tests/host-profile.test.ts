import { access, mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import { HostProfileRepository } from "../src/host-profile.js";

describe("HostProfileRepository", () => {
  it("persists one stable device and activated Workspace profile", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-profile-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });

    const prepared = await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation("default", {
      baseUrl: "https://app.clawling.com",
      accessToken: "access-1",
      ownerChatId: "owner-chat-1",
      refreshToken: "refresh-1",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
    });

    await expect(profiles.load("default")).resolves.toEqual({
      schemaVersion: 1,
      name: "default",
      workspace: canonicalWorkspace,
      deviceId: "clawchat-pi-device-1",
      baseUrl: "https://app.clawling.com",
      websocketUrl: "wss://app.clawling.com/ws",
      accessToken: "access-1",
      ownerChatId: "owner-chat-1",
      refreshToken: "refresh-1",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" },
      output: { toolCallsDefault: "off" }
    });
    expect(prepared.deviceId).toBe("clawchat-pi-device-1");
    expect((await stat(profiles.profilePath("default"))).mode & 0o777).toBe(0o600);
  });

  it("explicitly rebinds an activated profile while preserving only its device and Workspace", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-profile-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation("default", {
      baseUrl: "https://app.clawling.com",
      accessToken: "access-1",
      agent: { userId: "user-1", ownerId: "owner-1" }
    });

    const profileDirectory = profiles.profileDirectory("default");
    const sessionDirectory = join(agentDir, "sessions", "workspace");
    const sessionPath = join(sessionDirectory, "session-1.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    await mkdir(join(profileDirectory, "memory"), { recursive: true });
    await writeFile(join(profileDirectory, "memory", "owner.md"), "old identity\n");
    await mkdir(join(profileDirectory, "skills"), { recursive: true });
    await writeFile(join(profileDirectory, "skills", "old.md"), "old skill\n");
    const gatewayPath = join(profileDirectory, "gateway.sqlite");
    const gateway = GatewayStore.open(gatewayPath);
    gateway.getOrCreateChatSession("chat-1", () => ({ sessionId: "session-1", sessionPath }));
    gateway.enqueueOutbound({ traceId: "out-1", chatId: "chat-1", frame: { event: "message.send" } });
    gateway.close();

    const rebound = await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        baseUrl: "https://app.clawling.com",
        accessToken: "access-2",
        agent: { userId: "user-2", ownerId: "owner-2" }
      },
      { resetIdentityState: true }
    );

    expect(rebound.deviceId).toBe("clawchat-pi-device-1");
    await expect(access(sessionPath)).rejects.toThrow();
    await expect(access(join(profileDirectory, "memory", "owner.md"))).rejects.toThrow();
    await expect(access(join(profileDirectory, "skills", "old.md"))).rejects.toThrow();
    const resetGateway = GatewayStore.open(gatewayPath);
    expect(resetGateway.getStatus()).toMatchObject({ sessions: [], pendingOutbound: 0 });
    resetGateway.close();
    await expect(profiles.load("default")).resolves.toMatchObject({
      workspace: await realpath(workspace),
      deviceId: "clawchat-pi-device-1",
      accessToken: "access-2",
      agent: { userId: "user-2", ownerId: "owner-2" },
      output: { toolCallsDefault: "off" }
    });
  });

  it("allows only one running process to own a Host Profile", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-profile-"));
    const profiles = new HostProfileRepository({ agentDir });

    const first = await profiles.acquireLock("default");
    await expect(profiles.acquireLock("default")).rejects.toThrow("already running");

    await first.release();
    const next = await profiles.acquireLock("default");
    await next.release();
  });

  it("reclaims a lock left by a process that is no longer alive", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-profile-"));
    const crashedProcess = new HostProfileRepository({ agentDir, processId: 999_991 });
    const staleLock = await crashedProcess.acquireLock("default");
    const restartedProcess = new HostProfileRepository({
      agentDir,
      processId: 999_992,
      isProcessAlive: (pid) => pid === 999_992
    });

    const reclaimed = await restartedProcess.acquireLock("default");
    await staleLock.release();
    await expect(restartedProcess.acquireLock("default")).rejects.toThrow("already running");
    await reclaimed.release();
  });
});
