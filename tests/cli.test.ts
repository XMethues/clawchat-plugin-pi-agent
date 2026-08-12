import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { HeadlessPiHost } from "../src/headless-host.js";
import { GatewayStore } from "../src/gateway-store.js";
import { HostProfileRepository } from "../src/host-profile.js";

describe("clawchat-pi CLI", () => {
  it("activates a named Workspace profile and reports it without exposing credentials", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    const activate = vi.fn(async () => ({
      restUrl: "https://api.example.test",
      accessToken: "secret-access-token",
      agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
    }));
    const output: string[] = [];

    await expect(
      runCli(["activate", "INVITE-1", "--cwd", workspace, "--profile", "work"], {
        profiles,
        activate,
        environment: {
          CLAWCHAT_BASE_URL: "https://api.example.test/",
          CLAWCHAT_WS_URL: "wss://gateway.example.test/ws",
          CLAWCHAT_MEDIA_URL: "https://media.example.test/"
        },
        write: (line) => output.push(line)
      })
    ).resolves.toBe(0);
    await expect(
      runCli(["status", "--profile", "work"], {
        profiles,
        activate,
        write: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    expect(activate).toHaveBeenCalledWith({
      code: "INVITE-1",
      restUrl: "https://api.example.test/",
      deviceId: "clawchat-pi-device-1"
    });
    expect(output.join("\n")).toContain(await realpath(workspace));
    expect(output.join("\n")).toContain("clawchat-pi-device-1");
    expect(output.join("\n")).not.toContain("secret-access-token");
    expect(output.join("\n")).toContain("REST origin: https://api.example.test");
    expect(output.join("\n")).toContain("WebSocket URL: wss://gateway.example.test/ws");
    expect(output.join("\n")).toContain("Media origin: https://media.example.test");
    const operationLease = await profiles.acquireOperationLease("work");
    await operationLease.release();
  });

  it("holds the operation lease through remote redemption and excludes Host startup", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({
      agentDir,
      createDeviceId: () => "clawchat-pi-device-1"
    });
    const redemptionStarted = Promise.withResolvers<void>();
    const redemption = Promise.withResolvers<{
      restUrl: string;
      accessToken: string;
      agent: { id: string; userId: string; ownerId: string };
    }>();
    const commitStarted = Promise.withResolvers<void>();
    const continueCommit = Promise.withResolvers<void>();
    const completeActivation = profiles.completeActivation.bind(profiles);
    vi.spyOn(profiles, "completeActivation").mockImplementation(async (name, result, options) => {
      commitStarted.resolve();
      await continueCommit.promise;
      return completeActivation(name, result, options);
    });
    const activation = runCli(["activate", "INVITE-1", "--cwd", workspace], {
      profiles,
      activate: vi.fn(() => {
        redemptionStarted.resolve();
        return redemption.promise;
      }),
      write: vi.fn()
    });

    await redemptionStarted.promise;
    const host = new HeadlessPiHost({ agentDir, profiles });
    await expect(host.start()).rejects.toThrow("active operation");

    redemption.resolve({
      restUrl: "https://app.clawling.com",
      accessToken: "access-1",
      agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
    });
    await commitStarted.promise;
    await expect(profiles.acquireOperationLease("default")).rejects.toThrow("active operation");
    continueCommit.resolve();
    await expect(activation).resolves.toBe(0);
  });

  it("releases the operation lease when remote redemption fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });

    await expect(
      runCli(["activate", "INVITE-1", "--cwd", workspace], {
        profiles,
        activate: vi.fn(async () => {
          throw new Error("redemption failed");
        })
      })
    ).rejects.toThrow("redemption failed");

    const operationLease = await profiles.acquireOperationLease("default");
    await operationLease.release();

  });

  it("reports known Chat Sessions and durable queue counts", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://app.clawling.com",
        accessToken: "token-1",
        agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: "wss://app.clawling.com/ws",
        mediaUrl: "https://app.clawling.com"
      }
    );
    const store = GatewayStore.open(join(profiles.profileDirectory("default"), "gateway.sqlite"));
    store.getOrCreateChatSession("chat-1", () => ({
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl"
    }));
    store.admitInbound({
      dedupeKey: "message:msg-1",
      messageId: "msg-1",
      chatId: "chat-1",
      frame: { event: "message.send" },
      dispatch: true
    });
    store.recordInboxHistoryBoundary(42, Date.UTC(2026, 7, 12, 9, 30));
    store.close();
    const output: string[] = [];

    await runCli(["status"], { profiles, write: (line) => output.push(line) });

    expect(output.join("\n")).toContain("chat-1 -> session-1");
    expect(output.join("\n")).toContain("queued=1 running=0");
    expect(output.join("\n")).toContain("/sessions/session-1.jsonl");
    expect(output.join("\n")).toContain(
      "Inbox history before sequence 42 is unavailable (observed 2026-08-12T09:30:00.000Z)"
    );
  });

  it("reports whether the Host Profile process lock is held", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation(
      "default",
      {
        restUrl: "https://app.clawling.com",
        accessToken: "token-1",
        agent: { id: "agent-1", userId: "agent-user-1", ownerId: "owner-1" }
      },
      {
        websocketUrl: "wss://app.clawling.com/ws",
        mediaUrl: "https://app.clawling.com"
      }
    );
    const lock = await profiles.acquireOperationLease("default");
    const output: string[] = [];

    await runCli(["status"], { profiles, write: (line) => output.push(line) });

    expect(output.join("\n")).toContain(`Process: running (pid ${process.pid})`);
    await lock.release();
  });

  it("runs the selected Host Profile until the runtime stops", async () => {
    const runHost = vi.fn(async () => undefined);

    await expect(runCli(["run", "--profile", "work"], { runHost })).resolves.toBe(0);

    expect(runHost).toHaveBeenCalledWith("work", expect.any(Function));
  });
});
