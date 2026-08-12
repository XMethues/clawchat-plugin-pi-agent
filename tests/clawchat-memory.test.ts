import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawchatMemoryStore, clawchatMemoryTarget } from "../src/clawchat-memory.js";
import { createClawchatToolRuntime } from "../src/clawchat-runtime.js";
import { HostProfileRepository } from "../src/host-profile.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://app.clawling.com",
        accessToken: "access-1",
        ownerChatId: "owner-chat-1",
        agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: "wss://app.clawling.com/ws",
        mediaUrl: "https://app.clawling.com"
      }
    );
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

  it("routes Tool Runtime media to the stored Media origin and refreshes only opaque tokens", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-runtime-routing-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://api.example.test",
        accessToken: "opaque access",
        refreshToken: "opaque refresh",
        agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: "wss://gateway.example.test/ws",
        mediaUrl: "https://media.example.test"
      }
    );
    const requests: Array<{ url: string; authorization: string | null; body?: string }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {})
      });
      return url.endsWith("/v1/auth/refresh")
        ? new Response(
            JSON.stringify({
              code: 0,
              data: {
                access_token: " rotated opaque access ",
                refresh_token: " rotated opaque refresh "
              }
            }),
            { headers: { "content-type": "application/json" } }
          )
        : new Response(JSON.stringify({ code: 0, data: { url: "https://cdn.example/file" } }), {
            headers: { "content-type": "application/json" }
          });
    });
    vi.stubGlobal("fetch", fetchFn);
    const runtime = await createClawchatToolRuntime({ profiles, profileName: "default" });

    await runtime.environment.api.upload("/media/upload", {
      bytes: new Uint8Array([65]),
      filename: "a.txt",
      mime: "text/plain"
    });
    await runtime.refreshAccessToken();

    expect(requests[0]).toMatchObject({
      url: "https://media.example.test/media/upload",
      authorization: "Bearer opaque access"
    });
    expect(requests[1]).toMatchObject({
      url: "https://api.example.test/v1/auth/refresh",
      body: JSON.stringify({ refresh_token: "opaque refresh" })
    });
    expect(runtime.profile()).toMatchObject({
      accessToken: " rotated opaque access ",
      refreshToken: " rotated opaque refresh ",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
    });
  });

  it("content-compares authoritative metadata without touching agent-authored memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-pi-memory-convergence-"));
    const memory = new ClawchatMemoryStore(root);
    const group = clawchatMemoryTarget("group", "group-1");
    await memory.writeBody(group, "replace", "Keep this group note.");

    await expect(
      memory.writeMetadataIfChanged(group, {
        group_title: "Maintainers",
        group_member_add_policy: "admin",
        group_announcements: '[{"id":"announcement-1","text":"Release today"}]',
        updated_at: "7"
      })
    ).resolves.toBe(true);
    await expect(
      memory.writeMetadataIfChanged(group, {
        group_title: "Maintainers",
        group_member_add_policy: "admin",
        group_announcements: '[{"id":"announcement-1","text":"Release today"}]',
        updated_at: "7"
      })
    ).resolves.toBe(false);
    await expect(
      memory.writeMetadataIfChanged(group, {
        group_title: "Maintainers",
        group_member_add_policy: "admin",
        group_announcements: '[{"id":"announcement-2","text":"Release moved"}]',
        updated_at: "7"
      })
    ).resolves.toBe(true);
    await expect(memory.read(group)).resolves.toMatchObject({
      metadata: {
        group_id: "group-1",
        group_title: "Maintainers",
        group_member_add_policy: "admin",
        group_announcements: '[{"id":"announcement-2","text":"Release moved"}]',
        updated_at: "7"
      },
      body: "Keep this group note."
    });
    await expect(
      memory.writeRecoverySnapshotIfChanged({
        conversations: [{ id: "group-1", title: "Maintainers" }],
        agent: { behavior: "concise", id: "agent-1" }
      })
    ).resolves.toBe(true);
    await expect(
      memory.writeRecoverySnapshotIfChanged({
        agent: { id: "agent-1", behavior: "concise" },
        conversations: [{ title: "Maintainers", id: "group-1" }]
      })
    ).resolves.toBe(false);
    await expect(
      memory.writeRecoverySnapshotIfChanged({
        agent: { id: "agent-1", behavior: "detailed" },
        conversations: [{ title: "Maintainers", id: "group-1" }]
      })
    ).resolves.toBe(true);
  });

  it("rejects traversal-like explicit target ids", async () => {
    expect(() => clawchatMemoryTarget("user", "../owner")).toThrow("single safe file id");
  });
});
