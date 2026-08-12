import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClawchatMemoryStore, clawchatMemoryTarget } from "../src/clawchat-memory.js";
import { createClawchatToolRuntime } from "../src/clawchat-runtime.js";
import { HostProfileRepository } from "../src/host-profile.js";

describe("ClawchatMemoryStore", () => {
  it("injects owner and current-group memory but never user memory automatically", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-pi-memory-"));
    const memory = new ClawchatMemoryStore(root);
    await memory.writeBody(clawchatMemoryTarget("owner", "owner"), "replace", "owner preference");
    await memory.writeBody(clawchatMemoryTarget("group", "group-1"), "replace", "group rule");
    await memory.writeBody(clawchatMemoryTarget("user", "user-1"), "replace", "private user note");

    const direct = await memory.renderTurnContext({ chatType: "direct", chatId: "chat-1" });
    expect(direct).toContain("owner preference");
    expect(direct).not.toContain("private user note");

    const group = await memory.renderTurnContext({ chatType: "group", chatId: "group-1" });
    expect(group).toContain("owner preference");
    expect(group).toContain("group rule");
    expect(group).not.toContain("private user note");
    await expect(memory.read(clawchatMemoryTarget("user", "user-1"))).resolves.toMatchObject({
      body: "private user note"
    });
  });

  it("materializes owner identity memory when an activated profile runtime opens", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-memory-runtime-"));
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
      ownerChatId: "owner-chat-1",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
    });
    const memoryRoot = join(profiles.profileDirectory("default"), "memory");
    const ownerTarget = clawchatMemoryTarget("owner", "owner");

    const runtime = await createClawchatToolRuntime({
      profiles,
      profileName: "default"
    });

    await expect(runtime.environment.memory.read(ownerTarget)).resolves.toMatchObject({
      exists: true,
      metadata: {
        agent_user_id: "user-1",
        agent_owner_id: "owner-1"
      },
      body: ""
    });

    await runtime.environment.memory.writeMetadata(ownerTarget, {
      agent_nickname: "Pi"
    });
    await runtime.environment.memory.writeBody(
      ownerTarget,
      "replace",
      "Keep this owner-authored note."
    );
    await createClawchatToolRuntime({ profiles, profileName: "default" });
    await expect(new ClawchatMemoryStore(memoryRoot).read(ownerTarget)).resolves.toMatchObject({
      metadata: {
        agent_user_id: "user-1",
        agent_owner_id: "owner-1",
        agent_nickname: "Pi"
      },
      body: "Keep this owner-authored note."
    });
  });

  it("rejects traversal-like explicit target ids", async () => {
    expect(() => clawchatMemoryTarget("user", "../owner")).toThrow("single safe file id");
  });
});
