import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/bin.js";
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
      baseUrl: "https://app.clawling.com",
      accessToken: "secret-access-token",
      agent: { userId: "agent-user-1", ownerId: "owner-1" }
    }));
    const output: string[] = [];

    await expect(
      runCli(["activate", "INVITE-1", "--cwd", workspace, "--profile", "work"], {
        profiles,
        activate,
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
      baseUrl: "https://app.clawling.com",
      deviceId: "clawchat-pi-device-1"
    });
    expect(output.join("\n")).toContain(await realpath(workspace));
    expect(output.join("\n")).toContain("clawchat-pi-device-1");
    expect(output.join("\n")).not.toContain("secret-access-token");
  });

  it("reports known Chat Sessions and durable queue counts", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation("default", {
      baseUrl: "https://app.clawling.com",
      accessToken: "token-1",
      agent: { userId: "agent-user-1", ownerId: "owner-1" }
    });
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
    store.close();
    const output: string[] = [];

    await runCli(["status"], { profiles, write: (line) => output.push(line) });

    expect(output.join("\n")).toContain("chat-1 -> session-1");
    expect(output.join("\n")).toContain("queued=1 running=0");
    expect(output.join("\n")).toContain("/sessions/session-1.jsonl");
  });

  it("reports whether the Host Profile process lock is held", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-cli-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const profiles = new HostProfileRepository({ agentDir });
    await profiles.prepareActivation("default", workspace);
    await profiles.completeActivation("default", {
      baseUrl: "https://app.clawling.com",
      accessToken: "token-1",
      agent: { userId: "agent-user-1", ownerId: "owner-1" }
    });
    const lock = await profiles.acquireLock("default");
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
