import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { activateClawchat, type ActivateClawchatOptions, type ActivationResult } from "./activation.js";
import { DEFAULT_MEDIA_URL, DEFAULT_REST_URL, DEFAULT_WEBSOCKET_URL } from "./config.js";
import { GatewayStore } from "./gateway-store.js";
import { HostProfileRepository } from "./host-profile.js";
import { createClawchatToolRuntime, type ClawchatToolRuntime } from "./clawchat-runtime.js";
import {
  appendClawchatSystemPrompt,
  registerClawchatTools
} from "./clawchat-tools.js";
import {
  loadClawchatState,
  prepareClawchatState,
  saveClawchatState,
  type ClawchatState,
  type PreparedClawchatState,
  type StatePathOptions
} from "./state.js";

export interface ClawchatPiExtensionOptions {
  activate?: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  prepareState?: (options: StatePathOptions) => Promise<PreparedClawchatState>;
  loadState?: () => Promise<ClawchatState | null>;
  saveState?: (
    state: ClawchatState | ActivationResult,
    options?: StatePathOptions & { websocketUrl?: string; mediaUrl?: string }
  ) => Promise<string>;
  profileName?: string;
  profiles?: HostProfileRepository;
}

export function createClawchatPiExtension(options: ClawchatPiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const bridge = new ClawchatPiManagementExtension(pi, options);
    pi.registerCommand("clawchat-activate", {
      description: "Activate or explicitly rebind the current ClawChat Host Profile",
      handler: async (args, ctx) => {
        try {
          await bridge.activate(args, ctx);
        } catch (error: unknown) {
          ctx.ui.notify(errorMessage(error), "error");
        }
      }
    });
    pi.on("session_start", async (_event, ctx) => {
      try {
        await bridge.start(ctx);
      } catch (error: unknown) {
        setStatus(ctx, `error: ${errorMessage(error)}`);
      }
    });
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: appendClawchatSystemPrompt(event.systemPrompt)
    }));
    pi.on("session_shutdown", async () => {
      bridge.shutdown();
    });
  };
}

class ClawchatPiManagementExtension {
  private readonly pi: ExtensionAPI;
  private readonly activateFn: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  private readonly prepareStateFn: (options: StatePathOptions) => Promise<PreparedClawchatState>;
  private readonly loadStateFn: () => Promise<ClawchatState | null>;
  private readonly saveStateFn: (
    state: ClawchatState | ActivationResult,
    options?: StatePathOptions & { websocketUrl?: string; mediaUrl?: string }
  ) => Promise<string>;
  private readonly profileName: string;
  private readonly profiles: HostProfileRepository;
  private ctx: ExtensionContext | undefined;
  private toolsRegistered = false;
  private auditStore: GatewayStore | undefined;
  private toolRuntime: ClawchatToolRuntime | undefined;

  constructor(pi: ExtensionAPI, options: ClawchatPiExtensionOptions) {
    this.pi = pi;
    this.profileName = options.profileName ?? process.env.CLAWCHAT_PI_PROFILE ?? "default";
    this.profiles = options.profiles ??
      new HostProfileRepository({
        ...(process.env.CLAWCHAT_MEDIA_URL
          ? { legacyMediaUrl: process.env.CLAWCHAT_MEDIA_URL }
          : {})
      });
    this.activateFn = options.activate ?? activateClawchat;
    this.prepareStateFn =
      options.prepareState ??
      ((stateOptions) => prepareClawchatState({
        ...stateOptions,
        profile: this.profileName,
        profileRepository: this.profiles
      }));
    this.loadStateFn =
      options.loadState ??
      (() => loadClawchatState({
        profile: this.profileName,
        profileRepository: this.profiles
      }));
    this.saveStateFn =
      options.saveState ??
      ((state, stateOptions = {}) =>
        saveClawchatState(state, {
          ...stateOptions,
          profile: this.profileName,
          profileRepository: this.profiles
        }));
  }

  async activate(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const code = args.trim();
    if (!code) {
      ctx.ui.notify("Usage: /clawchat-activate <code>", "warning");
      return;
    }
    const operationLease = await this.profiles.acquireOperationLease(this.profileName);
    try {
      const prepared = await this.prepareStateFn({ workspace: ctx.cwd });
      const result = await this.activateFn({
        code,
        restUrl: process.env.CLAWCHAT_BASE_URL ?? DEFAULT_REST_URL,
        deviceId: prepared.deviceId
      });
      this.resetToolRuntime();
      await this.saveStateFn(result, {
        websocketUrl: process.env.CLAWCHAT_WS_URL ?? DEFAULT_WEBSOCKET_URL,
        mediaUrl: process.env.CLAWCHAT_MEDIA_URL ?? DEFAULT_MEDIA_URL,
        workspace: prepared.workspace,
        resetIdentityState: true
      });
      ctx.ui.notify("ClawChat activated and saved.", "info");
      if (this.ctx) await this.start(this.ctx);
    } finally {
      await operationLease.release();
    }
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    const state = await this.loadStateFn();
    if (!state?.accessToken) {
      setStatus(ctx, "not activated");
      return;
    }
    await this.ensureTools();
    setStatus(ctx, "profile ready");
  }

  shutdown(): void {
    this.resetToolRuntime();
    if (this.ctx) setStatus(this.ctx, undefined);
    this.ctx = undefined;
  }

  private async ensureTools(): Promise<void> {
    const profile = await this.profiles.load(this.profileName);
    if (!profile) return;
    this.toolRuntime = await createClawchatToolRuntime({
      profiles: this.profiles,
      profileName: this.profileName
    });
    if (!this.auditStore) {
      this.auditStore = GatewayStore.open(
        join(this.profiles.profileDirectory(this.profileName), "gateway.sqlite")
      );
    }
    if (this.toolsRegistered) return;
    const bridge = this;
    registerClawchatTools(this.pi, {
      profile: () => bridge.requireToolRuntime().profile(),
      get api() {
        return bridge.requireToolRuntime().environment.api;
      },
      get memory() {
        return bridge.requireToolRuntime().environment.memory;
      },
      recordToolCall: (record) => this.auditStore?.recordToolCall(record)
    });
    this.toolsRegistered = true;
  }

  private requireToolRuntime(): ClawchatToolRuntime {
    if (!this.toolRuntime) throw new Error("ClawChat tools are not initialized");
    return this.toolRuntime;
  }

  private resetToolRuntime(): void {
    this.auditStore?.close();
    this.auditStore = undefined;
    this.toolRuntime = undefined;
  }
}

export default createClawchatPiExtension();

function setStatus(ctx: ExtensionContext, message: string | undefined): void {
  try {
    ctx.ui.setStatus?.("clawchat", message);
  } catch {
    // Pi can mark the session UI context stale while shutdown callbacks unwind.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
