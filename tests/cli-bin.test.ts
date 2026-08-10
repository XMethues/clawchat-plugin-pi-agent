import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("installed clawchat-pi executable", () => {
  beforeAll(async () => {
    await execFile("npm", ["run", "build"], { cwd: repositoryRoot });
  });

  it("runs through the symbolic link created by npm", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8")
    ) as { bin: { "clawchat-pi": string } };
    const executable = resolve(repositoryRoot, packageJson.bin["clawchat-pi"]);
    const installation = await mkdtemp(join(tmpdir(), "clawchat-pi-bin-"));
    const installedCommand = join(installation, "clawchat-pi");
    await symlink(executable, installedCommand);

    const { stdout } = await execFile(process.execPath, [installedCommand, "--help"]);

    expect(stdout).toContain("Usage:");
  });
});
