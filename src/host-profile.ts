import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ActivationResult } from "./activation.js";
import {
  DEFAULT_MEDIA_URL,
  DEFAULT_REST_URL,
  DEFAULT_WEBSOCKET_URL,
  normalizeHttpOrigin,
  normalizeWebSocketUrl
} from "./config.js";
import { GatewayStore } from "./gateway-store.js";
import { isFileSystemError, optionalLstat } from "./filesystem.js";
import { isUnknownRecord } from "./type-guards.js";
import type { ClawchatOutputMode } from "./output-settings.js";

const PROFILE_SCHEMA_VERSION = 2 as const;
const LEGACY_PROFILE_SCHEMA_VERSION = 1 as const;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface HostProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  workspace: string;
  deviceId: string;
  restUrl: string;
  websocketUrl: string;
  mediaUrl: string;
  accessToken: string;
  refreshToken?: string;
  ownerChatId?: string;
  agent: {
    id: string;
    userId: string;
    ownerId: string;
  };
  output: {
    modeDefault: ClawchatOutputMode;
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
  legacyMediaUrl?: string;
}

export interface HostProfileOperationLease {
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
  private readonly pendingActivations = new Map<string, HostProfileDraft>();
  private readonly legacyMediaUrl: string | undefined;

  constructor(options: HostProfileRepositoryOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.createDeviceId = options.createDeviceId ?? (() => `clawchat-pi-${crypto.randomUUID()}`);
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.legacyMediaUrl = options.legacyMediaUrl;
  }

  profilePath(name: string): string {
    assertProfileName(name);
    return join(this.agentDir, "clawchat", "profiles", name, "profile.json");
  }

  profileDirectory(name: string): string {
    assertProfileName(name);
    return join(this.agentDir, "clawchat", "profiles", name);
  }

  async acquireOperationLease(name: string): Promise<HostProfileOperationLease> {
    const directory = this.profileDirectory(name);
    const path = join(directory, "run.lock");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error: unknown) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        const owner = await readLockOwner(path);
        if (attempt === 0 && owner && !this.isProcessAlive(owner.pid)) {
          try {
            await unlink(path);
          } catch (unlinkError: unknown) {
            if (!isFileSystemError(unlinkError, "ENOENT")) throw unlinkError;
          }
          continue;
        }
        throw new Error(`Host Profile '${name}' already has an active operation`);
      }
    }
    if (!handle) throw new Error(`Unable to lock Host Profile '${name}'`);
    await handle.writeFile(`${JSON.stringify({ pid: this.processId, token, startedAt: Date.now() })}\n`);

    let closed = false;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        if (!closed) {
          await handle.close();
          closed = true;
        }
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (current.token === token) await unlink(path);
          released = true;
        } catch (error: unknown) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
          released = true;
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
    const current = await this.readStoredRecord(name);
    if (current) {
      const draft = draftFromStored(current, name, this.profilePath(name));
      if (draft.workspace !== canonicalWorkspace) {
        throw new Error(
          `Host Profile '${name}' is bound to ${draft.workspace}; use another profile for ${canonicalWorkspace}`
        );
      }
      this.pendingActivations.set(name, draft);
      return draft;
    }

    const draft: HostProfileDraft = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      name,
      workspace: canonicalWorkspace,
      deviceId: this.createDeviceId()
    };
    this.pendingActivations.set(name, draft);
    await this.write(name, draft);
    return draft;
  }

  async completeActivation(
    name: string,
    activation: ActivationResult,
    options: { websocketUrl: string; mediaUrl: string; resetIdentityState?: boolean }
  ): Promise<HostProfile> {
    const stored = await this.readStoredRecord(name);
    const prepared = this.pendingActivations.get(name) ??
      (stored ? draftFromStored(stored, name, this.profilePath(name)) : undefined);
    if (!prepared) {
      throw new Error(`Host Profile '${name}' must be prepared before activation`);
    }
    const rebinding = options.resetIdentityState === true && stored !== null && hasAccessToken(stored);
    if (rebinding) await this.resetIdentityState(name);

    const profile: HostProfile = {
      ...toDraft(prepared),
      restUrl: normalizeHttpOrigin(activation.restUrl, "Host Profile REST origin"),
      websocketUrl: normalizeWebSocketUrl(options.websocketUrl, "Host Profile WebSocket URL"),
      mediaUrl: normalizeHttpOrigin(options.mediaUrl, "Host Profile Media origin"),
      accessToken: requireOpaqueProfileToken(activation.accessToken, "accessToken"),
      ...(activation.refreshToken
        ? { refreshToken: requireOpaqueProfileToken(activation.refreshToken, "refreshToken") }
        : {}),
      ...(activation.ownerChatId ? { ownerChatId: activation.ownerChatId } : {}),
      agent: {
        id: requireProfileString(activation.agent.id, "agent.id"),
        userId: requireProfileString(activation.agent.userId, "agent.userId"),
        ownerId: requireProfileString(activation.agent.ownerId, "agent.ownerId")
      },
      output: !rebinding && stored && hasOutput(stored)
        ? storedOutput(stored)
        : { modeDefault: "normal" }
    };
    await this.write(name, profile);
    this.pendingActivations.delete(name);
    return profile;
  }

  async updateTokens(name: string, accessToken: string, refreshToken?: string): Promise<HostProfile> {
    const profile = await this.load(name);
    if (!profile) throw new Error(`Host Profile '${name}' is not activated`);
    const updated: HostProfile = {
      ...profile,
      accessToken: requireOpaqueProfileToken(accessToken, "accessToken"),
      ...(refreshToken
        ? { refreshToken: requireOpaqueProfileToken(refreshToken, "refreshToken") }
        : {})
    };
    await this.write(name, updated);
    return updated;
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
    const stored = await this.readStoredRecord(name);
    if (!stored) return null;
    if (stored.schemaVersion === PROFILE_SCHEMA_VERSION) {
      const profile = parseCurrentProfile(stored, name, this.profilePath(name));
      if (
        isActiveProfile(profile) &&
        isUnknownRecord(stored.output) &&
        "toolCallsDefault" in stored.output
      ) {
        await this.write(name, profile);
      }
      return profile;
    }
    if (stored.schemaVersion === LEGACY_PROFILE_SCHEMA_VERSION) {
      const migrated = this.migrateLegacyProfile(stored, name);
      await this.write(name, migrated);
      return migrated;
    }
    throw new Error(
      `Unsupported Host Profile schema at ${this.profilePath(name)}; reactivate Host Profile '${name}'`
    );
  }

  private async readStoredRecord(name: string): Promise<Record<string, unknown> | null> {
    const path = this.profilePath(name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isUnknownRecord(parsed)) throw new Error(`Invalid Host Profile at ${path}`);
    return parsed;
  }

  private migrateLegacyProfile(stored: Record<string, unknown>, name: string): HostProfile | HostProfileDraft {
    const draft = draftFromStored(stored, name, this.profilePath(name));
    if (!hasAccessToken(stored)) return draft;
    const restUrl = normalizeLegacyHttpOrigin(stored.baseUrl, "REST", name);
    const websocketUrl = normalizeLegacyWebSocketUrl(stored.websocketUrl, name);
    const customEndpoints =
      restUrl !== DEFAULT_REST_URL || websocketUrl !== DEFAULT_WEBSOCKET_URL;
    if (!this.legacyMediaUrl && customEndpoints) {
      throw new Error(
        `Legacy Host Profile '${name}' has custom endpoints but no Media origin; set CLAWCHAT_MEDIA_URL and retry, or reactivate the profile`
      );
    }
    const mediaUrl = normalizeHttpOrigin(
      this.legacyMediaUrl ?? DEFAULT_MEDIA_URL,
      "CLAWCHAT_MEDIA_URL"
    );
    const agent = stored.agent;
    if (!isUnknownRecord(agent)) {
      throw legacyIdentityError(name, "agent");
    }
    const migrated: HostProfile = {
      ...draft,
      restUrl,
      websocketUrl,
      mediaUrl,
      accessToken: requireOpaqueProfileToken(stored.accessToken, "accessToken"),
      ...(typeof stored.refreshToken === "string" && stored.refreshToken.trim()
        ? { refreshToken: stored.refreshToken }
        : {}),
      ...(typeof stored.ownerChatId === "string" && stored.ownerChatId.trim()
        ? { ownerChatId: stored.ownerChatId.trim() }
        : {}),
      agent: {
        id: requireLegacyIdentity(agent.id, name, "agent.id"),
        userId: requireLegacyIdentity(agent.userId, name, "agent.userId"),
        ownerId: requireLegacyIdentity(agent.ownerId, name, "agent.ownerId")
      },
      output: storedOutput(stored)
    };
    return migrated;
  }

  private async resetIdentityState(name: string): Promise<void> {
    const directory = this.profileDirectory(name);
    const gatewayPath = join(directory, "gateway.sqlite");
    const sessionPaths: string[] = [];
    const gatewayStat = await optionalLstat(gatewayPath);
    if (gatewayStat) {
      if (gatewayStat.isSymbolicLink() || !gatewayStat.isFile()) {
        throw new Error(`Gateway Store for Host Profile '${name}' must be a regular file`);
      }
      const gateway = GatewayStore.open(gatewayPath);
      try {
        sessionPaths.push(...gateway.getStatus().sessions.map((session) => session.sessionPath));
      } finally {
        gateway.close();
      }
    }
    const sessionsRoot = resolve(this.agentDir, "sessions");
    for (const sessionPath of new Set(sessionPaths)) {
      const resolved = resolve(sessionPath);
      const relation = relative(sessionsRoot, resolved);
      if (
        !relation ||
        relation === ".." ||
        relation.startsWith(`..${sep}`) ||
        isAbsolute(relation)
      ) {
        continue;
      }
      await rm(resolved, { force: true });
    }
    await Promise.all([
      rm(gatewayPath, { force: true }),
      rm(`${gatewayPath}-shm`, { force: true }),
      rm(`${gatewayPath}-wal`, { force: true }),
      rm(join(directory, "memory"), { recursive: true, force: true }),
      rm(join(directory, "skills"), { recursive: true, force: true })
    ]);
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

function draftFromStored(
  stored: Record<string, unknown>,
  name: string,
  path: string
): HostProfileDraft {
  if (
    (stored.schemaVersion !== PROFILE_SCHEMA_VERSION &&
      stored.schemaVersion !== LEGACY_PROFILE_SCHEMA_VERSION) ||
    stored.name !== name ||
    typeof stored.workspace !== "string" ||
    stored.workspace.trim() === "" ||
    typeof stored.deviceId !== "string" ||
    stored.deviceId.trim() === ""
  ) {
    throw new Error(`Invalid Host Profile at ${path}`);
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name,
    workspace: stored.workspace,
    deviceId: stored.deviceId
  };
}

function parseCurrentProfile(
  stored: Record<string, unknown>,
  name: string,
  path: string
): HostProfile | HostProfileDraft {
  const draft = draftFromStored(stored, name, path);
  if (!hasAccessToken(stored)) return draft;
  const agent = stored.agent;
  if (!isUnknownRecord(agent)) throw new Error(`Invalid Host Profile at ${path}: agent is required`);
  const restUrl = normalizeHttpOrigin(
    requireProfileString(stored.restUrl, "restUrl"),
    "Host Profile REST origin"
  );
  const websocketUrl = normalizeWebSocketUrl(
    requireProfileString(stored.websocketUrl, "websocketUrl"),
    "Host Profile WebSocket URL"
  );
  const mediaUrl = normalizeHttpOrigin(
    requireProfileString(stored.mediaUrl, "mediaUrl"),
    "Host Profile Media origin"
  );
  if (
    restUrl !== stored.restUrl ||
    websocketUrl !== stored.websocketUrl ||
    mediaUrl !== stored.mediaUrl
  ) {
    throw new Error(`Invalid Host Profile at ${path}: endpoints are not normalized`);
  }
  return {
    ...draft,
    restUrl,
    websocketUrl,
    mediaUrl,
    accessToken: requireOpaqueProfileToken(stored.accessToken, "accessToken"),
    ...(typeof stored.refreshToken === "string" && stored.refreshToken.trim()
      ? { refreshToken: stored.refreshToken }
      : {}),
    ...(typeof stored.ownerChatId === "string" && stored.ownerChatId.trim()
      ? { ownerChatId: stored.ownerChatId.trim() }
      : {}),
    agent: {
      id: requireProfileString(agent.id, "agent.id"),
      userId: requireProfileString(agent.userId, "agent.userId"),
      ownerId: requireProfileString(agent.ownerId, "agent.ownerId")
    },
    output: storedOutput(stored)
  };
}

function isActiveProfile(profile: HostProfile | HostProfileDraft): profile is HostProfile {
  return "accessToken" in profile;
}

function hasAccessToken(stored: Record<string, unknown>): boolean {
  return typeof stored.accessToken === "string" && stored.accessToken.trim() !== "";
}

function hasOutput(stored: Record<string, unknown>): boolean {
  return isUnknownRecord(stored.output);
}

function storedOutput(stored: Record<string, unknown>): HostProfile["output"] {
  if (!isUnknownRecord(stored.output)) {
    throw new Error("Invalid Host Profile output.modeDefault");
  }
  if ("modeDefault" in stored.output) {
    assertOutputMode(stored.output.modeDefault);
    return { modeDefault: stored.output.modeDefault };
  }
  if (stored.output.toolCallsDefault === "on") return { modeDefault: "full" };
  if (stored.output.toolCallsDefault === "off") return { modeDefault: "normal" };
  throw new Error("Invalid Host Profile output.modeDefault");
}


function assertOutputMode(value: unknown): asserts value is ClawchatOutputMode {
  if (value !== "minimal" && value !== "normal" && value !== "full") {
    throw new Error("Invalid Host Profile output.modeDefault");
  }
}

function requireProfileString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid Host Profile: ${field} is required`);
  }
  return value.trim();
}

function requireOpaqueProfileToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid Host Profile: ${field} is required`);
  }
  return value;
}

function requireLegacyIdentity(value: unknown, name: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw legacyIdentityError(name, field);
  }
  return value.trim();
}

function legacyIdentityError(name: string, field: string): Error {
  return new Error(
    `Legacy Host Profile '${name}' is missing ${field}; reactivate the profile to obtain structured agent identity`
  );
}

function normalizeLegacyHttpOrigin(value: unknown, endpoint: string, name: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `Legacy Host Profile '${name}' is missing its ${endpoint} origin; configure endpoints and reactivate the profile`
    );
  }
  try {
    return normalizeHttpOrigin(value, `Legacy Host Profile ${endpoint} origin`);
  } catch {
    throw new Error(
      `Legacy Host Profile '${name}' has an invalid ${endpoint} origin; configure endpoints and reactivate the profile`
    );
  }
}

function normalizeLegacyWebSocketUrl(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `Legacy Host Profile '${name}' is missing its WebSocket URL; configure endpoints and reactivate the profile`
    );
  }
  try {
    return normalizeWebSocketUrl(value, "Legacy Host Profile WebSocket URL");
  } catch {
    throw new Error(
      `Legacy Host Profile '${name}' has an invalid WebSocket URL; configure endpoints and reactivate the profile`
    );
  }
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


async function readLockOwner(path: string): Promise<{ pid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid }
      : null;
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return null;
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
