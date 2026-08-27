import { constants } from "node:fs";
import { access, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

const LIVEWARE_ORIGIN = "https://media.clawling.chat";
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 2 * 60_000;
const LOCK_RETRY_MS = 250;

export interface LivewareCliStatus {
  available: boolean;
  path?: string;
  source?: "path" | "managed";
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  downloadUrl?: string;
}

export interface LivewareCliInstallerOptions {
  installDirectory: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export class LivewareCliInstaller {
  private readonly installDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private ensureInFlight: Promise<string> | undefined;

  constructor(options: LivewareCliInstallerOptions) {
    this.installDirectory = resolve(options.installDirectory);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds) => {
      const { promise, resolve: resolveDelay } = Promise.withResolvers<void>();
      setTimeout(resolveDelay, milliseconds);
      return promise;
    });
    prependPath(this.installDirectory, this.environment);
  }

  async status(): Promise<LivewareCliStatus> {
    const managedPath = this.managedExecutablePath();
    if (await isExecutable(managedPath, this.platform)) {
      return {
        available: true,
        path: managedPath,
        source: "managed",
        platform: this.platform,
        arch: this.arch
      };
    }

    const pathExecutable = await findPathExecutable(this.platform, this.environment);
    if (pathExecutable) {
      return {
        available: true,
        path: pathExecutable,
        source: "path",
        platform: this.platform,
        arch: this.arch
      };
    }

    return {
      available: false,
      platform: this.platform,
      arch: this.arch,
      downloadUrl: livewareDownloadUrl(this.platform, this.arch)
    };
  }

  async ensure(): Promise<string> {
    const current = await this.status();
    if (current.available && current.path) return current.path;
    if (!this.ensureInFlight) {
      this.ensureInFlight = this.install().finally(() => {
        this.ensureInFlight = undefined;
      });
    }
    return this.ensureInFlight;
  }

  private async install(): Promise<string> {
    await mkdir(this.installDirectory, { recursive: true, mode: 0o755 });
    const managedPath = this.managedExecutablePath();
    const lockPath = join(this.installDirectory, ".liveware-install.lock");
    const lock = await this.acquireLock(lockPath, managedPath);
    if (!lock) return managedPath;

    const temporaryPath = join(this.installDirectory, `.liveware-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
      if (await isExecutable(managedPath, this.platform)) return managedPath;
      const url = livewareDownloadUrl(this.platform, this.arch);
      await this.download(url, temporaryPath);
      await validateExecutableFormat(temporaryPath, this.platform);
      if (this.platform !== "win32") await chmod(temporaryPath, 0o755);
      await rename(temporaryPath, managedPath);
      prependPath(this.installDirectory, this.environment);
      return managedPath;
    } finally {
      await rm(temporaryPath, { force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private async acquireLock(
    lockPath: string,
    managedPath: string
  ): Promise<FileHandle | undefined> {
    const deadline = this.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(`${process.pid}\n`);
        return lock;
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
        if (await isExecutable(managedPath, this.platform)) return undefined;
        try {
          const lockStat = await stat(lockPath);
          if (this.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch (statError: unknown) {
          if (!isNodeError(statError, "ENOENT")) throw statError;
          continue;
        }
        if (this.now() >= deadline) throw new Error("Timed out waiting for another Liveware CLI installation");
        await this.delay(LOCK_RETRY_MS);
      }
    }
  }

  private async download(initialUrl: string, destination: string): Promise<void> {
    let currentUrl = new URL(initialUrl);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await this.fetchFn(currentUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("Liveware download redirect did not include a location");
      const redirected = new URL(location, currentUrl);
      if (redirected.origin !== LIVEWARE_ORIGIN) {
        throw new Error(`Liveware download redirected outside ${LIVEWARE_ORIGIN}`);
      }
      currentUrl = redirected;
      response.body?.cancel().catch(() => undefined);
    }

    if (!response?.ok) throw new Error(`Liveware CLI download failed with HTTP ${response?.status ?? "unknown"}`);
    if (currentUrl.origin !== LIVEWARE_ORIGIN) throw new Error(`Liveware download must use ${LIVEWARE_ORIGIN}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Liveware CLI download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    if (!response.body) throw new Error("Liveware CLI download returned no body");

    const output = await open(destination, "wx", 0o600);
    const reader = response.body.getReader();
    let downloaded = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        downloaded += chunk.value.byteLength;
        if (downloaded > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new Error(`Liveware CLI download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
        }
        await output.write(chunk.value);
      }
    } finally {
      await output.close();
    }
    if (downloaded === 0) throw new Error("Liveware CLI download was empty");
  }

  private managedExecutablePath(): string {
    return join(this.installDirectory, this.platform === "win32" ? "liveware.exe" : "liveware");
  }
}

export function livewareDownloadUrl(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const downloadArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!downloadArch) throw new Error(`Unsupported Liveware architecture: ${arch}`);
  if (platform === "linux") return `${LIVEWARE_ORIGIN}/liveware/liveware-linux-${downloadArch}`;
  if (platform === "darwin") return `${LIVEWARE_ORIGIN}/liveware/liveware-darwin-${downloadArch}`;
  if (platform === "win32") return `${LIVEWARE_ORIGIN}/liveware/liveware-windows-${downloadArch}.exe`;
  throw new Error(`Unsupported Liveware platform: ${platform}`);
}

export function livewareInstallDirectory(profileDirectory: string): string {
  return resolve(profileDirectory, "..", "..", "bin");
}

async function findPathExecutable(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const name = platform === "win32" ? "liveware.exe" : "liveware";
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    if (await isExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) return false;
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateExecutableFormat(path: string, platform: NodeJS.Platform): Promise<void> {
  const file = await open(path, "r");
  const magic = Buffer.allocUnsafe(4);
  try {
    const { bytesRead } = await file.read(magic, 0, magic.length, 0);
    const minimumBytes = platform === "win32" ? 2 : 4;
    if (bytesRead < minimumBytes) throw new Error("Liveware CLI download is too short");
  } finally {
    await file.close();
  }

  const valid = platform === "linux"
    ? magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    : platform === "win32"
      ? magic[0] === 0x4d && magic[1] === 0x5a
      : isMachOMagic(magic);
  if (!valid) throw new Error(`Liveware CLI download is not a valid ${platform} executable`);
}

function isMachOMagic(magic: Buffer): boolean {
  const value = magic.readUInt32BE(0);
  return value === 0xfeedface || value === 0xcefaedfe || value === 0xfeedfacf || value === 0xcffaedfe
    || value === 0xcafebabe || value === 0xbebafeca;
}

function prependPath(directory: string, environment: NodeJS.ProcessEnv): void {
  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  if (entries.includes(directory)) return;
  environment.PATH = [directory, ...entries].join(delimiter);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
