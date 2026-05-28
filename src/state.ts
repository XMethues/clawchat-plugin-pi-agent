import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ActivationResult } from "./activation.js";
import { DEFAULT_WEBSOCKET_URL } from "./config.js";

export interface ClawchatState {
  baseUrl: string;
  websocketUrl: string;
  accessToken: string;
  refreshToken?: string;
  agent: {
    id?: string;
    userId: string;
    ownerId: string;
  };
}

export interface StatePathOptions {
  path?: string;
}

export function getClawchatStatePath(options: StatePathOptions = {}): string {
  return options.path ?? process.env.CLAWCHAT_PI_STATE_PATH ?? join(getAgentDir(), "clawchat.json");
}

export async function loadClawchatState(options: StatePathOptions = {}): Promise<ClawchatState | null> {
  const path = getClawchatStatePath(options);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  const parsed = JSON.parse(text) as Partial<ClawchatState>;
  if (!parsed.accessToken || !parsed.agent?.userId || !parsed.agent.ownerId) {
    throw new Error(`Invalid ClawChat Pi state at ${path}`);
  }

  return {
    baseUrl: parsed.baseUrl || "https://app.clawling.com",
    websocketUrl: parsed.websocketUrl || DEFAULT_WEBSOCKET_URL,
    accessToken: parsed.accessToken,
    ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
    agent: {
      ...(parsed.agent.id ? { id: parsed.agent.id } : {}),
      userId: parsed.agent.userId,
      ownerId: parsed.agent.ownerId
    }
  };
}

export async function saveClawchatState(
  state: ClawchatState | ActivationResult,
  options: StatePathOptions & { websocketUrl?: string } = {}
): Promise<string> {
  const path = getClawchatStatePath(options);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const normalized: ClawchatState = {
    baseUrl: state.baseUrl,
    websocketUrl: "websocketUrl" in state ? state.websocketUrl : options.websocketUrl ?? DEFAULT_WEBSOCKET_URL,
    accessToken: state.accessToken,
    ...(state.refreshToken ? { refreshToken: state.refreshToken } : {}),
    agent: state.agent
  };

  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
  return path;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
