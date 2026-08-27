import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LivewareCliInstaller, livewareDownloadUrl } from "../src/liveware-installer.js";

describe("LivewareCliInstaller", () => {
  it.each([
    ["linux", "x64", "https://media.clawling.chat/liveware/liveware-linux-amd64"],
    ["linux", "arm64", "https://media.clawling.chat/liveware/liveware-linux-arm64"],
    ["darwin", "x64", "https://media.clawling.chat/liveware/liveware-darwin-amd64"],
    ["darwin", "arm64", "https://media.clawling.chat/liveware/liveware-darwin-arm64"],
    ["win32", "x64", "https://media.clawling.chat/liveware/liveware-windows-amd64.exe"],
    ["win32", "arm64", "https://media.clawling.chat/liveware/liveware-windows-arm64.exe"]
  ] as const)("maps %s/%s to its published asset", (platform, arch, expected) => {
    expect(livewareDownloadUrl(platform, arch)).toBe(expected);
  });

  it("rejects unsupported targets before downloading", () => {
    expect(() => livewareDownloadUrl("freebsd", "x64")).toThrow("Unsupported Liveware platform");
    expect(() => livewareDownloadUrl("linux", "ia32")).toThrow("Unsupported Liveware architecture");
  });

  it("reuses an existing Liveware executable from PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-path-"));
    const pathDirectory = join(directory, "path-bin");
    const installDirectory = join(directory, "managed-bin");
    await mkdir(pathDirectory);
    const executable = join(pathDirectory, "liveware");
    await writeFile(executable, "existing");
    await chmod(executable, 0o755);
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error("unexpected fetch");
    });
    const installer = new LivewareCliInstaller({
      installDirectory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: pathDirectory },
      fetch: fetchFn
    });

    await expect(installer.status()).resolves.toEqual({
      available: true,
      path: executable,
      source: "path",
      platform: "linux",
      arch: "x64"
    });
    await expect(installer.ensure()).resolves.toBe(executable);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("downloads one validated executable atomically and reuses it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-install-"));
    const executableBytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(executableBytes, {
      status: 200,
      headers: { "content-length": String(executableBytes.byteLength) }
    }));
    const environment = { PATH: "" };
    const installer = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "arm64",
      environment,
      fetch: fetchFn
    });

    const [first, second] = await Promise.all([installer.ensure(), installer.ensure()]);

    expect(first).toBe(join(directory, "liveware"));
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(await readFile(first)).toEqual(Buffer.from(executableBytes));
    expect((await stat(first)).mode & 0o111).toBe(0o111);
    await expect(access(join(directory, ".liveware-install.lock"))).rejects.toThrow();
    expect(environment.PATH?.split(":")).toContain(directory);
    await expect(installer.status()).resolves.toMatchObject({
      available: true,
      path: first,
      source: "managed"
    });
  });

  it("serializes concurrent installers through the filesystem lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-lock-"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const executableBytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]);
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      started.resolve();
      await release.promise;
      return new Response(executableBytes, { status: 200 });
    });
    const firstInstaller = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      fetch: fetchFn
    });
    const secondInstaller = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      fetch: fetchFn
    });

    const first = firstInstaller.ensure();
    await started.promise;
    const second = secondInstaller.ensure();
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      join(directory, "liveware"),
      join(directory, "liveware")
    ]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects a declared download larger than the installation limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-size-"));
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), {
        status: 200,
        headers: { "content-length": String(33 * 1024 * 1024) }
      }));
    const installer = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      fetch: fetchFn
    });

    await expect(installer.ensure()).rejects.toThrow("exceeds 33554432 bytes");
  });

  it("configures a two-minute total download deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-timeout-"));
    const timeoutSignal = vi.fn((_milliseconds: number) => new AbortController().signal);
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), { status: 200 }));
    const installer = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      fetch: fetchFn,
      timeoutSignal
    });

    await expect(installer.ensure()).resolves.toBe(join(directory, "liveware"));
    expect(timeoutSignal).toHaveBeenCalledWith(120_000);
  });

  it("rejects redirects outside the Liveware distribution origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-redirect-"));
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: "https://example.test/liveware" }
    }));
    const installer = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "linux",
      arch: "x64",
      environment: { PATH: "" },
      fetch: fetchFn
    });

    await expect(installer.ensure()).rejects.toThrow("redirected outside");
    await expect(access(join(directory, "liveware"))).rejects.toThrow();
  });

  it("rejects a response that is not an executable for the target platform", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveware-format-"));
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("not a binary", { status: 200 }));
    const installer = new LivewareCliInstaller({
      installDirectory: directory,
      platform: "darwin",
      arch: "arm64",
      environment: { PATH: "" },
      fetch: fetchFn
    });

    await expect(installer.ensure()).rejects.toThrow("not a valid darwin executable");
    await expect(access(join(directory, "liveware"))).rejects.toThrow();
  });
});
