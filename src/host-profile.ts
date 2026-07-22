import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ActivationResult } from "./activation.js";
import { DEFAULT_WEBSOCKET_URL } from "./config.js";

const PROFILE_SCHEMA_VERSION = 1 as const;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface HostProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  workspace: string;
  deviceId: string;
  baseUrl: string;
  websocketUrl: string;
  accessToken: string;
  refreshToken?: string;
  agent: {
    id?: string;
    userId: string;
    ownerId: string;
  };
  output: {
    toolCallsDefault: "on" | "off";
  };
}

interface HostProfileDraft {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  workspace: string;
  deviceId: string;
}

export interface HostProfileRepositoryOptions {
  agentDir?: string;
  createDeviceId?: () => string;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface HostProfileLock {
  release(): Promise<void>;
}

export interface HostProfileLockStatus {
  running: boolean;
  pid?: number;
}

export class HostProfileRepository {
  private readonly agentDir: string;
  private readonly createDeviceId: () => string;
  private readonly processId: number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: HostProfileRepositoryOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.createDeviceId = options.createDeviceId ?? (() => `clawchat-pi-${crypto.randomUUID()}`);
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
  }

  profilePath(name: string): string {
    assertProfileName(name);
    return join(this.agentDir, "clawchat", "profiles", name, "profile.json");
  }

  profileDirectory(name: string): string {
    assertProfileName(name);
    return join(this.agentDir, "clawchat", "profiles", name);
  }

  async acquireLock(name: string): Promise<HostProfileLock> {
    const directory = this.profileDirectory(name);
    const path = join(directory, "run.lock");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error: unknown) {
        if (!isFileExistsError(error)) throw error;
        const owner = await readLockOwner(path);
        if (attempt === 0 && owner && !this.isProcessAlive(owner.pid)) {
          try {
            await unlink(path);
          } catch (unlinkError: unknown) {
            if (!isMissingFileError(unlinkError)) throw unlinkError;
          }
          continue;
        }
        throw new Error(`Host Profile '${name}' is already running`);
      }
    }
    if (!handle) throw new Error(`Unable to lock Host Profile '${name}'`);
    await handle.writeFile(`${JSON.stringify({ pid: this.processId, token, startedAt: Date.now() })}\n`);

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (current.token === token) await unlink(path);
        } catch (error: unknown) {
          if (!isMissingFileError(error)) throw error;
        }
      }
    };
  }

  async getLockStatus(name: string): Promise<HostProfileLockStatus> {
    const owner = await readLockOwner(join(this.profileDirectory(name), "run.lock"));
    if (!owner) return { running: false };
    return this.isProcessAlive(owner.pid) ? { running: true, pid: owner.pid } : { running: false };
  }

  async prepareActivation(name: string, workspace: string): Promise<HostProfileDraft> {
    const canonicalWorkspace = await canonicalizeWorkspace(workspace);
    const current = await this.loadStored(name);
    if (current) {
      if (current.workspace !== canonicalWorkspace) {
        throw new Error(
          `Host Profile '${name}' is bound to ${current.workspace}; use another profile for ${canonicalWorkspace}`
        );
      }
      return toDraft(current);
    }

    const draft: HostProfileDraft = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      name,
      workspace: canonicalWorkspace,
      deviceId: this.createDeviceId()
    };
    await this.write(name, draft);
    return draft;
  }

  async completeActivation(
    name: string,
    activation: ActivationResult,
    options: { websocketUrl?: string } = {}
  ): Promise<HostProfile> {
    const prepared = await this.loadStored(name);
    if (!prepared) {
      throw new Error(`Host Profile '${name}' must be prepared before activation`);
    }

    const profile: HostProfile = {
      ...toDraft(prepared),
      baseUrl: activation.baseUrl,
      websocketUrl: options.websocketUrl ?? (isActiveProfile(prepared) ? prepared.websocketUrl : DEFAULT_WEBSOCKET_URL),
      accessToken: activation.accessToken,
      ...(activation.refreshToken ? { refreshToken: activation.refreshToken } : {}),
      agent: activation.agent,
      output: isActiveProfile(prepared) ? prepared.output : { toolCallsDefault: "off" }
    };
    await this.write(name, profile);
    return profile;
  }

  async load(name: string): Promise<HostProfile | null> {
    const stored = await this.loadStored(name);
    if (!stored) return null;
    if (!isActiveProfile(stored)) {
      throw new Error(`Host Profile '${name}' has not completed activation`);
    }
    return stored;
  }

  private async loadStored(name: string): Promise<HostProfile | HostProfileDraft | null> {
    const path = this.profilePath(name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) return null;
      throw error;
    }

    const parsed = JSON.parse(text) as Partial<HostProfile>;
    if (
      parsed.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      parsed.name !== name ||
      typeof parsed.workspace !== "string" ||
      typeof parsed.deviceId !== "string"
    ) {
      throw new Error(`Invalid Host Profile at ${path}`);
    }
    return parsed as HostProfile | HostProfileDraft;
  }

  private async write(name: string, profile: HostProfile | HostProfileDraft): Promise<void> {
    const path = this.profilePath(name);
    const directory = this.profileDirectory(name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  }
}

function toDraft(profile: HostProfile | HostProfileDraft): HostProfileDraft {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: profile.name,
    workspace: profile.workspace,
    deviceId: profile.deviceId
  };
}

function isActiveProfile(profile: HostProfile | HostProfileDraft): profile is HostProfile {
  return (
    "accessToken" in profile &&
    typeof profile.accessToken === "string" &&
    profile.accessToken.length > 0 &&
    "agent" in profile &&
    typeof profile.agent?.userId === "string" &&
    typeof profile.agent.ownerId === "string" &&
    "output" in profile &&
    (profile.output?.toolCallsDefault === "on" || profile.output?.toolCallsDefault === "off")
  );
}

async function canonicalizeWorkspace(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${canonical}`);
  }
  return canonical;
}

function assertProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Host Profile name '${name}'`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

async function readLockOwner(path: string): Promise<{ pid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid }
      : null;
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}
