import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ClawChatGateway } from "./gateway.js";
import { GatewayStore } from "./gateway-store.js";
import { HostProfileRepository, type HostProfileLock } from "./host-profile.js";
import { ClawchatInboundRouter } from "./inbound-router.js";
import { ClawchatOutputProjector } from "./output-projector.js";
import { PiChatSessionFactory } from "./pi-session-factory.js";
import { ChatSessionRegistry } from "./session-registry.js";
import type { ClawchatTransport } from "./types.js";
import { createClawchatToolRuntime } from "./clawchat-runtime.js";

export interface HeadlessPiHostOptions {
  profileName?: string;
  agentDir?: string;
  profiles?: HostProfileRepository;
  onStatus?: (status: string) => void;
}

export class HeadlessPiHost {
  private readonly profileName: string;
  private readonly agentDir: string;
  private readonly profiles: HostProfileRepository;
  private readonly onStatus: ((status: string) => void) | undefined;
  private lock: HostProfileLock | undefined;
  private store: GatewayStore | undefined;
  private gateway: ClawChatGateway | undefined;
  private registry: ChatSessionRegistry | undefined;
  private started = false;

  constructor(options: HeadlessPiHostOptions = {}) {
    this.profileName = options.profileName ?? "default";
    this.agentDir = options.agentDir ?? getAgentDir();
    this.profiles = options.profiles ?? new HostProfileRepository({ agentDir: this.agentDir });
    this.onStatus = options.onStatus;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Headless Pi Host is already started");
    const profile = await this.profiles.load(this.profileName);
    if (!profile) throw new Error(`Host Profile '${this.profileName}' is not activated`);
    const toolRuntime = await createClawchatToolRuntime({
      profiles: this.profiles,
      profileName: this.profileName
    });
    this.lock = await this.profiles.acquireLock(this.profileName);

    try {
      const store = GatewayStore.open(join(this.profiles.profileDirectory(this.profileName), "gateway.sqlite"));
      this.store = store;
      let gateway: ClawChatGateway | undefined;
      const transport: ClawchatTransport = {
        send: async (message) => {
          if (!gateway) throw new Error("ClawChat Gateway is not started");
          await gateway.send(message);
        }
      };
      const replyProjector = new ClawchatOutputProjector({ transport });
      const router = new ClawchatInboundRouter({
        store,
        agentUserId: profile.agent.userId,
        toolCallsDefault: profile.output.toolCallsDefault,
        reply: async (message, text) => {
          await replyProjector.replyTo(message, text);
        }
      });
      const factory = new PiChatSessionFactory({
        workspace: profile.workspace,
        agentDir: this.agentDir,
        store,
        transport,
        toolCallsDefault: profile.output.toolCallsDefault,
        tools: {
          ...toolRuntime.environment,
          sendFrame: async (frame) => {
            if (!gateway) throw new Error("ClawChat Gateway is not started");
            await gateway.send(frame);
          },
          recordToolCall: (record) => store.recordToolCall(record)
        }
      });
      const registry = new ChatSessionRegistry({
        store,
        factory,
        onError: (error, turn) => {
          this.onStatus?.(
            `turn ${turn.id} interrupted: ${error instanceof Error ? error.message : String(error)}`
          );
        },
        onWorkerError: (error, chatId) => {
          this.onStatus?.(
            `chat ${chatId} worker failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
      this.registry = registry;

      gateway = new ClawChatGateway({
        websocketUrl: profile.websocketUrl,
        accessToken: toolRuntime.profile().accessToken,
        refreshAccessToken: toolRuntime.refreshAccessToken,
        deviceId: profile.deviceId,
        userId: profile.agent.userId,
        store,
        classifyInbound: (message) => router.classify(message),
        onAcceptedControl: async (message, decision) => {
          await router.applyAcceptedControl(message, decision);
        },
        onInboundMessage: async (message) => {
          void registry.wake(message.chat_id).catch((error: unknown) => {
            this.onStatus?.(
              `chat ${message.chat_id} worker failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        },
        ...(this.onStatus ? { onStatus: this.onStatus } : {})
      });
      this.gateway = gateway;
      await registry.start();
      await gateway.start();
      this.started = true;
    } catch (error: unknown) {
      await this.stopComponents();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stopComponents();
  }

  private async stopComponents(): Promise<void> {
    this.started = false;
    const registry = this.registry;
    this.registry = undefined;
    await registry?.shutdown();

    const gateway = this.gateway;
    this.gateway = undefined;
    await gateway?.stop();

    const store = this.store;
    this.store = undefined;
    store?.close();

    const lock = this.lock;
    this.lock = undefined;
    await lock?.release();
  }
}
