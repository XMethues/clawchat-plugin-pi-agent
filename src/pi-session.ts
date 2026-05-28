import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type { PiAgentSession } from "./types.js";

export interface CreatePiSdkSessionOptions {
  cwd?: string;
  authFile?: string;
  modelsFile?: string;
  tools?: string[];
}

export async function createPiSdkSession(options: CreatePiSdkSessionOptions = {}): Promise<PiAgentSession> {
  const cwd = options.cwd ?? process.cwd();
  const authStorage = options.authFile ? AuthStorage.create(options.authFile) : AuthStorage.create();
  const modelRegistry = options.modelsFile
    ? ModelRegistry.create(authStorage, options.modelsFile)
    : ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(cwd),
    ...(options.tools ? { tools: options.tools } : {})
  });

  return session as unknown as PiAgentSession;
}
