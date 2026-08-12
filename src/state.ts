import { join } from "node:path";
import type { ActivationResult } from "./activation.js";
import { DEFAULT_MEDIA_URL, DEFAULT_WEBSOCKET_URL } from "./config.js";
import { GatewayStore } from "./gateway-store.js";
import { HostProfileRepository } from "./host-profile.js";
import type { ClawchatOutputSettings } from "./output-settings.js";

export interface ClawchatState {
  restUrl: string;
  websocketUrl: string;
  mediaUrl: string;
  accessToken: string;
  refreshToken?: string;
  agent: {
    id: string;
    userId: string;
    ownerId: string;
  };
  deviceId: string;
  workspace: string;
  output: ClawchatOutputSettings;
}

export interface StatePathOptions {
  agentDir?: string;
  profile?: string;
  workspace?: string;
  resetIdentityState?: boolean;
  profileRepository?: HostProfileRepository;
}

export interface PreparedClawchatState {
  deviceId: string;
  workspace: string;
}

export function getClawchatStatePath(options: StatePathOptions = {}): string {
  return repository(options).profilePath(profileName(options));
}

export function getClawchatGatewayStorePath(options: StatePathOptions = {}): string {
  const name = profileName(options);
  return gatewayPath(options, name);
}

export async function prepareClawchatState(options: StatePathOptions = {}): Promise<PreparedClawchatState> {
  const workspace = options.workspace;
  if (!workspace) throw new Error("A Workspace is required to prepare ClawChat activation");
  const prepared = await repository(options).prepareActivation(profileName(options), workspace);
  return { deviceId: prepared.deviceId, workspace: prepared.workspace };
}

export async function loadClawchatState(options: StatePathOptions = {}): Promise<ClawchatState | null> {
  const name = profileName(options);
  const profile = await repository(options).load(name);
  if (!profile) return null;
  const gateway = GatewayStore.open(gatewayPath(options, name));
  try {
    return {
      restUrl: profile.restUrl,
      websocketUrl: profile.websocketUrl,
      mediaUrl: profile.mediaUrl,
      accessToken: profile.accessToken,
      ...(profile.refreshToken ? { refreshToken: profile.refreshToken } : {}),
      agent: profile.agent,
      deviceId: profile.deviceId,
      workspace: profile.workspace,
      output: {
        toolCallsDefault: profile.output.toolCallsDefault,
        chatOverrides: gateway.getToolOutputOverrides()
      }
    };
  } finally {
    gateway.close();
  }
}

export async function saveClawchatState(
  state: ClawchatState | ActivationResult,
  options: StatePathOptions & { websocketUrl?: string; mediaUrl?: string } = {}
): Promise<string> {
  const name = profileName(options);
  const profiles = repository(options);
  let extensionState: ClawchatState;

  if (isClawchatState(state)) {
    await profiles.prepareActivation(name, state.workspace);
    const profile = await profiles.completeActivation(
      name,
      {
        restUrl: state.restUrl,
        accessToken: state.accessToken,
        ...(state.refreshToken ? { refreshToken: state.refreshToken } : {}),
        agent: state.agent
      },
      {
        websocketUrl: state.websocketUrl,
        mediaUrl: state.mediaUrl,
        ...(options.resetIdentityState !== undefined
          ? { resetIdentityState: options.resetIdentityState }
          : {})
      }
    );
    extensionState = { ...state, deviceId: profile.deviceId, workspace: profile.workspace };
  } else {
    const workspace = options.workspace;
    if (!workspace) throw new Error("A Workspace is required to save ClawChat activation");
    await profiles.prepareActivation(name, workspace);
    const profile = await profiles.completeActivation(name, state, {
      websocketUrl: options.websocketUrl ?? DEFAULT_WEBSOCKET_URL,
      mediaUrl: options.mediaUrl ?? DEFAULT_MEDIA_URL,
      ...(options.resetIdentityState !== undefined
        ? { resetIdentityState: options.resetIdentityState }
        : {})
    });
    extensionState = {
      restUrl: profile.restUrl,
      websocketUrl: profile.websocketUrl,
      mediaUrl: profile.mediaUrl,
      accessToken: profile.accessToken,
      ...(profile.refreshToken ? { refreshToken: profile.refreshToken } : {}),
      agent: profile.agent,
      deviceId: profile.deviceId,
      workspace: profile.workspace,
      output: { toolCallsDefault: profile.output.toolCallsDefault, chatOverrides: {} }
    };
  }

  const gateway = GatewayStore.open(gatewayPath(options, name));
  try {
    const previous = gateway.getToolOutputOverrides();
    for (const chatId of Object.keys(previous)) {
      if (!(chatId in extensionState.output.chatOverrides)) {
        gateway.setToolOutputOverride(chatId, "inherit");
      }
    }
    for (const [chatId, value] of Object.entries(extensionState.output.chatOverrides)) {
      gateway.setToolOutputOverride(chatId, value);
    }
  } finally {
    gateway.close();
  }
  return profiles.profilePath(name);
}

function repository(options: StatePathOptions): HostProfileRepository {
  return options.profileRepository ??
    new HostProfileRepository({
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(process.env.CLAWCHAT_MEDIA_URL
        ? { legacyMediaUrl: process.env.CLAWCHAT_MEDIA_URL }
        : {})
    });
}

function profileName(options: StatePathOptions): string {
  return options.profile ?? process.env.CLAWCHAT_PI_PROFILE ?? "default";
}

function gatewayPath(options: StatePathOptions, name: string): string {
  return join(repository(options).profileDirectory(name), "gateway.sqlite");
}

function isClawchatState(state: ClawchatState | ActivationResult): state is ClawchatState {
  return "deviceId" in state && "workspace" in state && "output" in state;
}
