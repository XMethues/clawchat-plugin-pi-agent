import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ClawchatAwarenessCoordinator } from "./clawchat-awareness.js";
import { ClawchatPlaintextHistorySync } from "./clawchat-history-sync.js";
import {
  ClawChatGateway,
  isClawchatGatewayEvent,
  type ClawchatGatewayEvent
} from "./gateway.js";
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
  onAwarenessSignal?: (event: ClawchatGatewayEvent) => Promise<void>;
  onHistoryTransit?: (event: ClawchatGatewayEvent) => Promise<void>;
  onDeliveryReceipt?: (event: ClawchatGatewayEvent) => Promise<void> | void;
}

export class HeadlessPiHost {
  private readonly profileName: string;
  private readonly agentDir: string;
  private readonly profiles: HostProfileRepository;
  private readonly onStatus: ((status: string) => void) | undefined;
  private readonly onAwarenessSignal: ((event: ClawchatGatewayEvent) => Promise<void>) | undefined;
  private readonly onHistoryTransit: ((event: ClawchatGatewayEvent) => Promise<void>) | undefined;
  private readonly onDeliveryReceipt: ((event: ClawchatGatewayEvent) => Promise<void> | void) | undefined;
  private lock: HostProfileLock | undefined;
  private store: GatewayStore | undefined;
  private gateway: ClawChatGateway | undefined;
  private registry: ChatSessionRegistry | undefined;
  private readonly awarenessRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly historyRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopping = false;
  private started = false;

  constructor(options: HeadlessPiHostOptions = {}) {
    this.profileName = options.profileName ?? "default";
    this.agentDir = options.agentDir ?? getAgentDir();
    this.profiles = options.profiles ?? new HostProfileRepository({ agentDir: this.agentDir });
    this.onStatus = options.onStatus;
    this.onAwarenessSignal = options.onAwarenessSignal;
    this.onHistoryTransit = options.onHistoryTransit;
    this.onDeliveryReceipt = options.onDeliveryReceipt;
  }

  async start(): Promise<void> {
    this.stopping = false;
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
      const awarenessOwnerChatId = profile.ownerChatId;
      const awarenessAgentId = profile.agent.id;
      const awareness = awarenessOwnerChatId && awarenessAgentId
        ? new ClawchatAwarenessCoordinator({
            api: toolRuntime.environment.api,
            store,
            ownerChatId: awarenessOwnerChatId,
            agentId: awarenessAgentId,
            wake: (chatId) => {
              void registry.wake(chatId).catch((error: unknown) => {
                this.onStatus?.(
                  `awareness turn for ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`
                );
              });
            }
          })
        : undefined;
      const historySync = new ClawchatPlaintextHistorySync({
        api: toolRuntime.environment.api,
        store,
        deviceId: profile.deviceId,
        userId: profile.agent.userId,
        send: async (frame) => {
          if (!gateway) throw new Error("ClawChat Gateway is not started");
          await gateway.send(frame);
        }
      });

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
        ...(awareness
          ? {
              onAwarenessSignal: async (event: ClawchatGatewayEvent) => {
                void (async () => {
                  await this.processAwareness(awareness, event);
                  await this.onAwarenessSignal?.(event);
                })().catch((error: unknown) => {
                  this.onStatus?.(
                    `awareness observer failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                });
              }
            }
          : {}),
        onHistoryTransit: async (event: ClawchatGatewayEvent) => {
          void (async () => {
            await this.processHistory(historySync, event);
            await this.onHistoryTransit?.(event);
          })().catch((error: unknown) => {
            this.onStatus?.(
              `history observer failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        },
        onDeliveryReceipt: async (event) => {
          this.onStatus?.(`message ${String(event.payload?.message_id ?? "unknown")} delivered`);
          await this.onDeliveryReceipt?.(event);
        },
        ...(this.onStatus ? { onStatus: this.onStatus } : {})
      });
      this.gateway = gateway;
      await registry.start();
      await gateway.start();
      if (awareness) {
        for (const frame of store.listReliableFrames("notify.signal")) {
          if (isClawchatGatewayEvent(frame)) await this.processAwareness(awareness, frame);
        }
      }
      for (const frame of store.listReliableFrames("history.transit")) {
        if (isClawchatGatewayEvent(frame)) await this.processHistory(historySync, frame);
      }
      this.started = true;
    } catch (error: unknown) {
      await this.stopComponents();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stopComponents();
  }

  private async processAwareness(
    awareness: ClawchatAwarenessCoordinator,
    event: ClawchatGatewayEvent,
    attempt = 0
  ): Promise<void> {
    try {
      await awareness.handle(event);
    } catch (error: unknown) {
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      this.onStatus?.(
        `awareness refresh failed; retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const timer = setTimeout(() => {
        this.awarenessRetryTimers.delete(timer);
        void this.processAwareness(awareness, event, attempt + 1);
      }, delay);
      this.awarenessRetryTimers.add(timer);
    }
  }

  private async processHistory(
    historySync: ClawchatPlaintextHistorySync,
    event: ClawchatGatewayEvent,
    attempt = 0
  ): Promise<void> {
    try {
      await historySync.handle(event);
    } catch (error: unknown) {
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      this.onStatus?.(
        `history sync failed; retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const timer = setTimeout(() => {
        this.historyRetryTimers.delete(timer);
        void this.processHistory(historySync, event, attempt + 1);
      }, delay);
      this.historyRetryTimers.add(timer);
    }
  }

  private async stopComponents(): Promise<void> {
    this.started = false;
    this.stopping = true;
    for (const timer of this.awarenessRetryTimers) clearTimeout(timer);
    this.awarenessRetryTimers.clear();
    for (const timer of this.historyRetryTimers) clearTimeout(timer);
    this.historyRetryTimers.clear();

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
