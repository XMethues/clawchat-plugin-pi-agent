import { mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
      refreshToken: "refresh-1",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" },
      output: { toolCallsDefault: "off" }
    });
    expect(prepared.deviceId).toBe("clawchat-pi-device-1");
    expect((await stat(profiles.profilePath("default"))).mode & 0o777).toBe(0o600);
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
