import { mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getClawchatStatePath,
  loadClawchatState,
  prepareClawchatState,
  saveClawchatState
} from "../src/state.js";

describe("ClawChat Extension profile state", () => {
  it("shares the activated Host Profile and stable device with the CLI", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-state-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const options = { agentDir, profile: "work", workspace };

    const prepared = await prepareClawchatState(options);
    await saveClawchatState(
      {
        restUrl: "https://app.clawling.com",
        accessToken: "token-1",
        refreshToken: "refresh-1",
        agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" }
      },
      {
        ...options,
        websocketUrl: "wss://app.clawling.com/ws",
        mediaUrl: "https://media.example.test"
      }
    );

    await expect(loadClawchatState(options)).resolves.toEqual({
      restUrl: "https://app.clawling.com",
      websocketUrl: "wss://app.clawling.com/ws",
      mediaUrl: "https://media.example.test",
      accessToken: "token-1",
      refreshToken: "refresh-1",
      agent: { id: "agent-1", userId: "user-1", ownerId: "owner-1" },
      deviceId: prepared.deviceId,
      workspace: await realpath(workspace),
      output: { modeDefault: "normal", chatOverrides: {} }
    });
    expect((await stat(getClawchatStatePath(options))).mode & 0o777).toBe(0o600);
  });
});
