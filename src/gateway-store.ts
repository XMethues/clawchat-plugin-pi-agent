import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ClawchatOutputMode, ClawchatOutputModeOverride } from "./output-settings.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface ChatSessionMapping {
  chatId: string;
  sessionId: string;
  sessionPath: string;
}

export interface ChatSessionRecord extends ChatSessionMapping {
  createdAt: number;
  lastUsedAt: number | null;
  active: boolean;
}

export type SessionCommand =
  | { type: "new" }
  | { type: "session" }
  | { type: "resume-list"; page: number }
  | { type: "resume"; sessionId: string };

export interface AdmitInboundInput {
  dedupeKey: string;
  messageId: string;
  chatId: string;
  frame: unknown;
  dispatch: boolean;
  queueTurn?: boolean;
  sessionCommand?: SessionCommand;
  stop?: boolean;
}

export type InboundAdmission =
  | { status: "accepted"; workId: string | null; cancelledWork: number }
  | { status: "duplicate"; workId: string | null; cancelledWork: 0 };

export interface ChatTurn {
  id: string;
  chatId: string;
  messageId: string;
  frame: unknown;
  status: "queued" | "running" | "complete" | "interrupted";
}

export type ConversationWork =
  | (ChatTurn & { command: null })
  | (ChatTurn & { command: SessionCommand });

export interface ClawchatAwarenessSource {
  sourceId: string;
  signalType: string;
  entityId: string;
  authoritativeState: unknown;
}

export interface AwarenessAdmission {
  status: "queued" | "coalesced";
  chatId: string;
  turnId: string;
}

export interface HistoryTransferState {
  deviceId: string;
  direction: "import" | "export";
  status: "active" | "complete" | "cancelled";
  chatId?: string;
  messagesTransferred: number;
  conversationsTransferred: number;
  reason?: string;
}
export interface HistorySourceRejection {
  sourceId: string;
  status: "rejected";
  reason: string;
}

export interface OutboundRecord {
  traceId: string;
  messageId: string;
  chatId: string;
  frame: unknown;
  serializedFrame: string;
  attempts: number;
  lastAttemptAt: number | null;
}

export interface GatewayStoreStatus {
  sessions: Array<
    ChatSessionRecord & {
      queuedWork: number;
      runningWork: number;
    }
  >;
  pendingOutbound: number;
  failedOutbound: number;
  quarantinedFrames: number;
  inboxHistoryUnavailableBefore: InboxHistoryBoundary | null;
}

export interface InboxHistoryBoundary {
  oldestSeq: number;
  observedAt: number;
}

export interface QuarantinedFrameRecord {
  ackEpoch: string | null;
  dseq: number | null;
  ackable: boolean;
  event: string;
  reason: string;
  frame: unknown;
  createdAt: number;
}

export class GatewayStore {
  private constructor(private readonly database: DatabaseSyncType) {}

  static open(path: string): GatewayStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS conversation_session_sets (
        chat_id TEXT PRIMARY KEY,
        active_session_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        session_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (chat_id) REFERENCES conversation_session_sets(chat_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS chat_sessions_by_conversation
        ON chat_sessions (chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_turns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        work_type TEXT NOT NULL DEFAULT 'turn'
          CHECK (work_type IN ('turn', 'session.new', 'session.info', 'session.resume-list', 'session.resume')),
        command_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'interrupted')),
        admitted_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS chat_turns_ready
        ON chat_turns (chat_id, status, sequence);

      CREATE TABLE IF NOT EXISTS inbound_frames (
        dedupe_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('queued', 'delivered', 'skipped')),
        turn_id TEXT UNIQUE REFERENCES chat_turns(id),
        admitted_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outbound_messages (
        trace_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        failed_at INTEGER,
        error_code TEXT,
        error_reason TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS outbound_messages_pending
        ON outbound_messages (status, created_at);

      CREATE TABLE IF NOT EXISTS chat_output_settings (
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('minimal', 'normal', 'full')),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS group_dispatch_settings (
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('mention', 'all', 'muted')),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS quarantined_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ack_epoch TEXT,
        dseq INTEGER,
        ackable INTEGER NOT NULL DEFAULT 0 CHECK (ackable IN (0, 1)),
        event TEXT NOT NULL,
        reason TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (ack_epoch, dseq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reliable_ingress_state (
        ack_epoch TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS inbox_history_boundary (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        oldest_seq INTEGER NOT NULL CHECK (oldest_seq > 0),
        observed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reliable_frames (
        dedupe_key TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS history_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        imported_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS history_messages_by_chat
        ON history_messages (chat_id, imported_at);

      CREATE TABLE IF NOT EXISTS history_sources (
        source_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS history_source_rejections (
        source_id TEXT PRIMARY KEY REFERENCES history_sources(source_id),
        reason TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS history_transfers (
        device_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('import', 'export')),
        status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'cancelled')),
        chat_id TEXT,
        messages_transferred INTEGER NOT NULL,
        conversations_transferred INTEGER NOT NULL,
        reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, direction)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS awareness_turns (
        coalesce_key TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL UNIQUE REFERENCES chat_turns(id),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS awareness_sources (
        source_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES chat_turns(id),
        processed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tool_calls (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        chat_id TEXT,
        message_id TEXT,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS tool_calls_by_chat
        ON tool_calls (chat_id, sequence);
    `);
    migrateGatewaySchema(database);
    return new GatewayStore(database);
  }

  getActiveChatSession(chatId: string): ChatSessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT sessions.chat_id, sessions.session_id, sessions.session_path,
                sessions.created_at, sessions.last_used_at, 1 AS active
         FROM conversation_session_sets AS sets
         JOIN chat_sessions AS sessions
           ON sessions.chat_id = sets.chat_id
          AND sessions.session_id = sets.active_session_id
         WHERE sets.chat_id = ?`
      )
      .get(chatId) as ChatSessionRow | undefined;
    return row ? mapChatSession(row) : null;
  }

  getChatSession(chatId: string, sessionId: string): ChatSessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT sessions.chat_id, sessions.session_id, sessions.session_path,
                sessions.created_at, sessions.last_used_at,
                CASE WHEN sets.active_session_id = sessions.session_id THEN 1 ELSE 0 END AS active
         FROM chat_sessions AS sessions
         JOIN conversation_session_sets AS sets ON sets.chat_id = sessions.chat_id
         WHERE sessions.chat_id = ? AND sessions.session_id = ?`
      )
      .get(chatId, sessionId) as ChatSessionRow | undefined;
    return row ? mapChatSession(row) : null;
  }

  listChatSessions(chatId: string): ChatSessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT sessions.chat_id, sessions.session_id, sessions.session_path,
                sessions.created_at, sessions.last_used_at,
                CASE WHEN sets.active_session_id = sessions.session_id THEN 1 ELSE 0 END AS active
         FROM chat_sessions AS sessions
         JOIN conversation_session_sets AS sets ON sets.chat_id = sessions.chat_id
         WHERE sessions.chat_id = ?
         ORDER BY COALESCE(sessions.last_used_at, sessions.created_at) DESC,
                  sessions.created_at DESC,
                  sessions.rowid DESC`
      )
      .all(chatId) as unknown as ChatSessionRow[];
    return rows.map(mapChatSession);
  }

  listConversationIds(): string[] {
    const rows = this.database
      .prepare("SELECT chat_id FROM conversation_session_sets ORDER BY chat_id")
      .all() as unknown as Array<{ chat_id: string }>;
    return rows.map((row) => row.chat_id);
  }

  ensureConversationSessionSet(
    chatId: string,
    create: () => { sessionId: string; sessionPath: string }
  ): ChatSessionRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getActiveChatSession(chatId);
      if (existing) {
        this.database.exec("COMMIT");
        return existing;
      }
      const created = create();
      const now = Date.now();
      this.database
        .prepare(
          `INSERT INTO conversation_session_sets
            (chat_id, active_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(chatId, created.sessionId, now, now);
      this.database
        .prepare(
          `INSERT INTO chat_sessions
            (session_id, chat_id, session_path, created_at, last_used_at)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(created.sessionId, chatId, created.sessionPath, now);
      this.database.exec("COMMIT");
      return {
        chatId,
        ...created,
        createdAt: now,
        lastUsedAt: null,
        active: true
      };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createAndActivateChatSession(
    chatId: string,
    create: () => { sessionId: string; sessionPath: string }
  ): { session: ChatSessionRecord; replacedEmpty: ChatSessionRecord | null } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.getActiveChatSession(chatId);
      if (!previous) throw new Error(`Conversation Session Set '${chatId}' does not exist`);
      const created = create();
      const now = Date.now();
      this.database
        .prepare(
          `INSERT INTO chat_sessions
            (session_id, chat_id, session_path, created_at, last_used_at)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(created.sessionId, chatId, created.sessionPath, now);
      const replacedEmpty = this.replaceActiveSession(chatId, previous, created.sessionId, now);
      this.database.exec("COMMIT");
      return {
        session: {
          chatId,
          ...created,
          createdAt: now,
          lastUsedAt: null,
          active: true
        },
        replacedEmpty
      };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  activateChatSession(
    chatId: string,
    sessionId: string
  ): { session: ChatSessionRecord; replacedEmpty: ChatSessionRecord | null } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const target = this.getChatSession(chatId, sessionId);
      if (!target) throw new Error(`Session '${sessionId}' is not owned by chat '${chatId}'`);
      const previous = this.getActiveChatSession(chatId);
      if (!previous) throw new Error(`Conversation Session Set '${chatId}' does not exist`);
      if (target.active) {
        this.database.exec("COMMIT");
        return { session: target, replacedEmpty: null };
      }
      const replacedEmpty = this.replaceActiveSession(chatId, previous, sessionId, Date.now());
      this.database.exec("COMMIT");
      return { session: { ...target, active: true }, replacedEmpty };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceActiveSession(
    chatId: string,
    previous: ChatSessionRecord,
    replacementSessionId: string,
    now: number
  ): ChatSessionRecord | null {
    this.database
      .prepare(
        `UPDATE conversation_session_sets
         SET active_session_id = ?, updated_at = ?
         WHERE chat_id = ?`
      )
      .run(replacementSessionId, now, chatId);
    const replacedEmpty = previous.lastUsedAt === null ? previous : null;
    if (replacedEmpty) {
      this.database
        .prepare("DELETE FROM chat_sessions WHERE chat_id = ? AND session_id = ?")
        .run(chatId, previous.sessionId);
    }
    return replacedEmpty;
  }

  markChatSessionUsed(chatId: string, sessionId: string): void {
    const result = this.database
      .prepare(
        `UPDATE chat_sessions
         SET last_used_at = ?
         WHERE chat_id = ? AND session_id = ?`
      )
      .run(Date.now(), chatId, sessionId);
    if (result.changes !== 1) {
      throw new Error(`Chat Session '${sessionId}' is not owned by chat '${chatId}'`);
    }
  }

  deleteConversationSessionSet(chatId: string): ChatSessionRecord[] {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sessions = this.listChatSessions(chatId);
      this.database
        .prepare(
          `DELETE FROM awareness_sources
           WHERE turn_id IN (SELECT id FROM chat_turns WHERE chat_id = ?)`
        )
        .run(chatId);
      this.database
        .prepare(
          `DELETE FROM awareness_turns
           WHERE turn_id IN (SELECT id FROM chat_turns WHERE chat_id = ?)`
        )
        .run(chatId);
      this.database
        .prepare("UPDATE inbound_frames SET turn_id = NULL WHERE chat_id = ?")
        .run(chatId);
      this.database.prepare("DELETE FROM chat_turns WHERE chat_id = ?").run(chatId);
      this.database.prepare("DELETE FROM conversation_session_sets WHERE chat_id = ?").run(chatId);
      this.database.exec("COMMIT");
      return sessions;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateChatSessionPath(chatId: string, sessionId: string, sessionPath: string): void {
    const result = this.database
      .prepare("UPDATE chat_sessions SET session_path = ? WHERE chat_id = ? AND session_id = ?")
      .run(sessionPath, chatId, sessionId);
    if (result.changes !== 1) {
      throw new Error(`Chat Session mapping changed for '${chatId}'`);
    }
  }

  admitInbound(input: AdmitInboundInput): InboundAdmission {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT message_id, chat_id, frame_json, turn_id
           FROM inbound_frames
           WHERE dedupe_key = ?`
        )
        .get(input.dedupeKey) as
        | {
            message_id: string;
            chat_id: string;
            frame_json: string;
            turn_id: string | null;
          }
        | undefined;
      if (existing) {
        if (existing.chat_id !== input.chatId) {
          throw new Error(`Inbound dedupe identity '${input.dedupeKey}' changed chats`);
        }
        const now = Date.now();
        const suppressRewrite =
          existing.message_id === input.messageId &&
          classifyReply(JSON.parse(existing.frame_json) as unknown) === "author-final" &&
          classifyReply(input.frame) === "provisional";
        if (suppressRewrite) {
          this.database
            .prepare("UPDATE inbound_frames SET admitted_at = ? WHERE dedupe_key = ?")
            .run(now, input.dedupeKey);
        } else {
          const frameJson = JSON.stringify(input.frame);
          this.database
            .prepare(
              `UPDATE inbound_frames
               SET message_id = ?, frame_json = ?, admitted_at = ?
               WHERE dedupe_key = ?`
            )
            .run(input.messageId, frameJson, now, input.dedupeKey);
          if (existing.turn_id) {
            this.database
              .prepare(
                `UPDATE chat_turns
                 SET message_id = ?, frame_json = ?
                 WHERE id = ? AND status = 'queued'`
              )
              .run(input.messageId, frameJson, existing.turn_id);
          }
        }
        this.database.exec("COMMIT");
        return { status: "duplicate", workId: existing.turn_id, cancelledWork: 0 };
      }

      const now = Date.now();
      const frameJson = JSON.stringify(input.frame);
      const queueWork =
        input.queueTurn !== false && (input.dispatch || input.sessionCommand !== undefined);
      const workId = queueWork ? crypto.randomUUID() : null;
      const command = input.sessionCommand;
      if (workId) {
        this.database
          .prepare(
            `INSERT INTO chat_turns
              (id, chat_id, message_id, frame_json, work_type, command_json, status, admitted_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
          )
          .run(
            workId,
            input.chatId,
            input.messageId,
            frameJson,
            command ? sessionCommandWorkType(command) : "turn",
            command ? JSON.stringify(command) : null,
            now
          );
      }
      const cancelledWork = input.stop
        ? this.cancelQueuedWorkRows(input.chatId, now)
        : 0;
      this.database
        .prepare(
          `INSERT INTO inbound_frames
            (dedupe_key, message_id, chat_id, frame_json, disposition, turn_id, admitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.dedupeKey,
          input.messageId,
          input.chatId,
          frameJson,
          queueWork ? "queued" : input.dispatch || input.stop ? "delivered" : "skipped",
          workId,
          now
        );
      this.database.exec("COMMIT");
      return { status: "accepted", workId, cancelledWork };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextWork(chatId: string): ConversationWork | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const running = this.database
        .prepare("SELECT 1 AS present FROM chat_turns WHERE chat_id = ? AND status = 'running' LIMIT 1")
        .get(chatId);
      if (running) {
        this.database.exec("COMMIT");
        return null;
      }

      const row = this.database
        .prepare(
          `SELECT id, chat_id, message_id, frame_json, work_type, command_json, status
           FROM chat_turns
           WHERE chat_id = ? AND status = 'queued'
           ORDER BY sequence
           LIMIT 1`
        )
        .get(chatId) as ConversationWorkRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }

      this.database
        .prepare("UPDATE chat_turns SET status = 'running', started_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      this.database.exec("COMMIT");
      return mapConversationWork({ ...row, status: "running" });
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeWork(workId: string): void {
    const result = this.database
      .prepare(
        "UPDATE chat_turns SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(Date.now(), workId);
    if (result.changes !== 1) {
      throw new Error(`Conversation Work '${workId}' is not running`);
    }
  }

  interruptWork(workId: string): void {
    const result = this.database
      .prepare(
        "UPDATE chat_turns SET status = 'interrupted', completed_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(Date.now(), workId);
    if (result.changes !== 1) {
      throw new Error(`Conversation Work '${workId}' is not running`);
    }
  }

  cancelQueuedWork(chatId: string): number {
    return this.cancelQueuedWorkRows(chatId, Date.now());
  }

  private cancelQueuedWorkRows(chatId: string, now: number): number {
    return Number(
      this.database
        .prepare(
          `UPDATE chat_turns
           SET status = 'interrupted', completed_at = ?
           WHERE chat_id = ? AND status = 'queued'`
        )
        .run(now, chatId).changes
    );
  }

  recoverAfterRestart(): { interruptedWorkIds: string[] } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database
        .prepare("SELECT id FROM chat_turns WHERE status = 'running' ORDER BY sequence")
        .all() as Array<{ id: string }>;
      this.database
        .prepare(
          "UPDATE chat_turns SET status = 'interrupted', completed_at = ? WHERE status = 'running'"
        )
        .run(Date.now());
      this.database.exec("COMMIT");
      return { interruptedWorkIds: rows.map((row) => row.id) };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listQueuedConversationIds(): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT chat_id FROM chat_turns WHERE status = 'queued' ORDER BY chat_id")
      .all() as unknown as Array<{ chat_id: string }>;
    return rows.map((row) => row.chat_id);
  }

  getAwarenessSourceTurn(sourceId: string): string | null {
    const row = this.database
      .prepare("SELECT turn_id FROM awareness_sources WHERE source_id = ?")
      .get(sourceId) as { turn_id: string } | undefined;
    return row?.turn_id ?? null;
  }

  enqueueAwareness(input: {
    chatId: string;
    coalesceKey: string;
    source: ClawchatAwarenessSource;
  }): AwarenessAdmission {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT awareness_turns.turn_id, chat_turns.status, chat_turns.frame_json
           FROM awareness_turns
           JOIN chat_turns ON chat_turns.id = awareness_turns.turn_id
           WHERE awareness_turns.coalesce_key = ?`
        )
        .get(input.coalesceKey) as
        | { turn_id: string; status: ChatTurn["status"]; frame_json: string }
        | undefined;
      const now = Date.now();
      if (existing?.status === "queued") {
        const frame = JSON.parse(existing.frame_json) as {
          kind: "clawchat.awareness";
          coalesceKey: string;
          sources: ClawchatAwarenessSource[];
        };
        if (!frame.sources.some((source) => source.sourceId === input.source.sourceId)) {
          frame.sources.push(input.source);
          this.database
            .prepare(
              `UPDATE chat_turns
               SET message_id = ?, frame_json = ?
               WHERE id = ? AND status = 'queued'`
            )
            .run(input.source.sourceId, JSON.stringify(frame), existing.turn_id);
        }
        this.database
          .prepare("UPDATE awareness_turns SET updated_at = ? WHERE coalesce_key = ?")
          .run(now, input.coalesceKey);
        this.database
          .prepare(
            `INSERT OR IGNORE INTO awareness_sources (source_id, turn_id, processed_at)
             VALUES (?, ?, ?)`
          )
          .run(input.source.sourceId, existing.turn_id, now);
        this.database.exec("COMMIT");
        return { status: "coalesced", chatId: input.chatId, turnId: existing.turn_id };
      }

      const turnId = crypto.randomUUID();
      const frame = {
        kind: "clawchat.awareness" as const,
        coalesceKey: input.coalesceKey,
        sources: [input.source]
      };
      this.database
        .prepare(
          `INSERT INTO chat_turns
            (id, chat_id, message_id, frame_json, status, admitted_at)
           VALUES (?, ?, ?, ?, 'queued', ?)`
        )
        .run(turnId, input.chatId, input.source.sourceId, JSON.stringify(frame), now);
      this.database
        .prepare(
          `INSERT INTO awareness_turns (coalesce_key, turn_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (coalesce_key)
           DO UPDATE SET turn_id = excluded.turn_id, updated_at = excluded.updated_at`
        )
        .run(input.coalesceKey, turnId, now);
      this.database
        .prepare(
          `INSERT INTO awareness_sources (source_id, turn_id, processed_at)
           VALUES (?, ?, ?)`
        )
        .run(input.source.sourceId, turnId, now);
      this.database.exec("COMMIT");
      return { status: "queued", chatId: input.chatId, turnId };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueOutbound(input: { traceId: string; chatId: string; frame: unknown }): OutboundRecord {
    const messageId = getOutboundMessageId(input.frame);
    if (!messageId) throw new Error("Outbound materialized message is missing payload.message_id");
    const serializedFrame = JSON.stringify(input.frame);
    this.database
      .prepare(
        `INSERT INTO outbound_messages
          (trace_id, message_id, chat_id, frame_json, status, attempts, last_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)`
      )
      .run(input.traceId, messageId, input.chatId, serializedFrame, Date.now());
    return {
      traceId: input.traceId,
      messageId,
      chatId: input.chatId,
      frame: input.frame,
      serializedFrame,
      attempts: 0,
      lastAttemptAt: null
    };
  }

  listPendingOutbound(): OutboundRecord[] {
    const rows = this.database
      .prepare(
        `SELECT trace_id, message_id, chat_id, frame_json, attempts, last_attempt_at
         FROM outbound_messages
         WHERE status = 'pending'
         ORDER BY created_at, rowid`
      )
      .all() as unknown as OutboundRow[];
    return rows.map(mapOutbound);
  }

  recordOutboundAttempt(traceId: string, attemptedAt = Date.now()): void {
    const result = this.database
      .prepare(
        `UPDATE outbound_messages
         SET attempts = attempts + 1, last_attempt_at = ?
         WHERE trace_id = ? AND status = 'pending'`
      )
      .run(attemptedAt, traceId);
    if (result.changes !== 1) {
      throw new Error(`Outbound trace '${traceId}' is not pending`);
    }
  }

  acknowledgeOutbound(traceId: string): void {
    this.database
      .prepare(
        `UPDATE outbound_messages
         SET status = 'acknowledged', acknowledged_at = ?
         WHERE status = 'pending'
           AND (trace_id = ? OR json_extract(frame_json, '$.trace_id') = ?)`
      )
      .run(Date.now(), traceId, traceId);
  }

  setOutputModeOverride(chatId: string, value: ClawchatOutputModeOverride): void {
    if (value === "inherit") {
      this.database.prepare("DELETE FROM chat_output_settings WHERE chat_id = ?").run(chatId);
      return;
    }
    assertOutputMode(value);
    this.database
      .prepare(
        `INSERT INTO chat_output_settings (chat_id, mode, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           mode = excluded.mode,
           updated_at = excluded.updated_at`
      )
      .run(chatId, value, Date.now());
  }

  getOutputModeOverrides(): Record<string, ClawchatOutputMode> {
    const rows = this.database
      .prepare("SELECT chat_id, mode FROM chat_output_settings ORDER BY chat_id")
      .all() as unknown as Array<{ chat_id: string; mode: string }>;
    return Object.fromEntries(
      rows.map((row) => {
        assertOutputMode(row.mode);
        return [row.chat_id, row.mode];
      })
    );
  }

  setGroupDispatchMode(chatId: string, mode: "mention" | "all" | "muted"): void {
    this.database
      .prepare(
        `INSERT INTO group_dispatch_settings (chat_id, mode, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`
      )
      .run(chatId, mode, Date.now());
  }

  getGroupDispatchMode(chatId: string): "mention" | "all" | "muted" {
    const row = this.database
      .prepare("SELECT mode FROM group_dispatch_settings WHERE chat_id = ?")
      .get(chatId) as { mode: "mention" | "all" | "muted" } | undefined;
    return row?.mode ?? "mention";
  }

  getStatus(): GatewayStoreStatus {
    const rows = this.database
      .prepare(
        `SELECT
           sessions.chat_id,
           sessions.session_id,
           sessions.session_path,
           sessions.created_at,
           sessions.last_used_at,
           CASE WHEN sets.active_session_id = sessions.session_id THEN 1 ELSE 0 END AS active,
           (SELECT COUNT(*) FROM chat_turns AS queued
             WHERE queued.chat_id = sessions.chat_id AND queued.status = 'queued') AS queued_work,
           (SELECT COUNT(*) FROM chat_turns AS running
             WHERE running.chat_id = sessions.chat_id AND running.status = 'running') AS running_work
         FROM chat_sessions AS sessions
         JOIN conversation_session_sets AS sets ON sets.chat_id = sessions.chat_id
         ORDER BY sessions.chat_id, active DESC, sessions.created_at DESC, sessions.rowid DESC`
      )
      .all() as unknown as StatusSessionRow[];
    const pending = this.database
      .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE status = 'pending'")
      .get() as { count: number };
    const quarantined = this.database
      .prepare("SELECT COUNT(*) AS count FROM quarantined_frames")
      .get() as { count: number };
    const failed = this.database
      .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE status = 'failed'")
      .get() as { count: number };
    return {
      sessions: rows.map((row) => ({
        ...mapChatSession(row),
        queuedWork: row.queued_work,
        runningWork: row.running_work
      })),
      pendingOutbound: pending.count,
      failedOutbound: failed.count,
      quarantinedFrames: quarantined.count,
      inboxHistoryUnavailableBefore: this.getInboxHistoryBoundary()
    };
  }

  recordInboxHistoryBoundary(oldestSeq: number, observedAt = Date.now()): boolean {
    if (!Number.isSafeInteger(oldestSeq) || oldestSeq < 1) {
      throw new Error("Inbox history boundary requires a positive integer oldest_seq");
    }
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error("Inbox history boundary requires a valid observation time");
    }
    const result = this.database
      .prepare(
        `INSERT INTO inbox_history_boundary (singleton, oldest_seq, observed_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           oldest_seq = excluded.oldest_seq,
           observed_at = excluded.observed_at
         WHERE excluded.oldest_seq > inbox_history_boundary.oldest_seq`
      )
      .run(oldestSeq, observedAt);
    return result.changes === 1;
  }

  getInboxHistoryBoundary(): InboxHistoryBoundary | null {
    const row = this.database
      .prepare("SELECT oldest_seq, observed_at FROM inbox_history_boundary WHERE singleton = 1")
      .get() as { oldest_seq: number; observed_at: number } | undefined;
    return row ? { oldestSeq: row.oldest_seq, observedAt: row.observed_at } : null;
  }

  getReliableHighWater(ackEpoch: string): number {
    const row = this.database
      .prepare("SELECT high_water FROM reliable_ingress_state WHERE ack_epoch = ?")
      .get(ackEpoch) as { high_water: number } | undefined;
    return row?.high_water ?? 0;
  }

  advanceReliableHighWater(ackEpoch: string, dseq: number): void {
    if (ackEpoch.length === 0 || !Number.isSafeInteger(dseq) || dseq < 1) {
      throw new Error("Reliable high-water requires a non-empty epoch and positive integer dseq");
    }
    this.database
      .prepare(
        `INSERT INTO reliable_ingress_state (ack_epoch, high_water, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ack_epoch) DO UPDATE SET
           high_water = MAX(high_water, excluded.high_water),
           updated_at = excluded.updated_at`
      )
      .run(ackEpoch, dseq, Date.now());
  }

  quarantineReliableInbound(input: {
    ackEpoch: string;
    dseq: number;
    event: string;
    reason: string;
    frame: unknown;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO quarantined_frames
            (ack_epoch, dseq, ackable, event, reason, frame_json, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT(ack_epoch, dseq) DO NOTHING`
        )
        .run(
          input.ackEpoch,
          input.dseq,
          input.event,
          input.reason,
          JSON.stringify(input.frame),
          Date.now()
        );
      this.advanceReliableHighWater(input.ackEpoch, input.dseq);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  quarantineRawInbound(input: { event: string; reason: string; frame: unknown }): void {
    this.database
      .prepare(
        `INSERT INTO quarantined_frames
          (ack_epoch, dseq, ackable, event, reason, frame_json, created_at)
         VALUES (NULL, NULL, 0, ?, ?, ?, ?)`
      )
      .run(input.event, input.reason, JSON.stringify(input.frame), Date.now());
  }

  listQuarantinedFrames(): QuarantinedFrameRecord[] {
    const rows = this.database
      .prepare(
        `SELECT ack_epoch, dseq, ackable, event, reason, frame_json, created_at
         FROM quarantined_frames
         ORDER BY id`
      )
      .all() as unknown as Array<{
      ack_epoch: string | null;
      dseq: number | null;
      ackable: number;
      event: string;
      reason: string;
      frame_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      ackEpoch: row.ack_epoch,
      dseq: row.dseq,
      ackable: row.ackable === 1,
      event: row.event,
      reason: row.reason,
      frame: JSON.parse(row.frame_json) as unknown,
      createdAt: row.created_at
    }));
  }

  failOutbound(traceId: string, code: string, reason?: string): void {
    this.database
      .prepare(
        `UPDATE outbound_messages
         SET status = 'failed', failed_at = ?, error_code = ?, error_reason = ?
         WHERE status = 'pending'
           AND (trace_id = ? OR json_extract(frame_json, '$.trace_id') = ?)`
      )
      .run(Date.now(), code, reason ?? null, traceId, traceId);
  }

  persistReliableFrame(dedupeKey: string, event: string, frame: unknown): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO reliable_frames
          (dedupe_key, event, frame_json, received_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(dedupeKey, event, JSON.stringify(frame), Date.now());
    return result.changes === 1;
  }

  listReliableFrames(event: string): unknown[] {
    const rows = this.database
      .prepare(
        `SELECT frame_json
         FROM reliable_frames
         WHERE event = ?
         ORDER BY received_at, dedupe_key`
      )
      .all(event) as unknown as Array<{ frame_json: string }>;
    return rows.map((row) => JSON.parse(row.frame_json) as unknown);
  }

  admitHistoryPage(input: {
    sourceId: string;
    chatId: string;
    sourceDeviceId: string;
    messages: Array<{ id: string } & Record<string, unknown>>;
  }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.isHistorySourceProcessed(input.sourceId)) {
        this.database.exec("COMMIT");
        return false;
      }
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO history_messages
          (message_id, chat_id, message_json, source_device_id, imported_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const now = Date.now();
      let imported = 0;
      for (const message of input.messages) {
        const result = insert.run(
          message.id,
          input.chatId,
          JSON.stringify(message),
          input.sourceDeviceId,
          now
        );
        imported += Number(result.changes);
      }
      const previous = this.getHistoryTransfer(input.sourceDeviceId, "import");
      this.updateHistoryTransfer({
        deviceId: input.sourceDeviceId,
        direction: "import",
        status: "active",
        chatId: input.chatId,
        messagesTransferred: (previous?.messagesTransferred ?? 0) + imported,
        conversationsTransferred: previous?.conversationsTransferred ?? 0
      });
      this.markHistorySourceProcessed(input.sourceId);
      this.database.exec("COMMIT");
      return true;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listHistoryMessages(chatId: string): unknown[] {
    const rows = this.database
      .prepare(
        `SELECT message_json
         FROM history_messages
         WHERE chat_id = ?
         ORDER BY imported_at, rowid`
      )
      .all(chatId) as unknown as Array<{ message_json: string }>;
    return rows.map((row) => JSON.parse(row.message_json) as unknown);
  }

  isHistorySourceProcessed(sourceId: string): boolean {
    return Boolean(
      this.database.prepare("SELECT 1 FROM history_sources WHERE source_id = ?").get(sourceId)
    );
  }

  markHistorySourceProcessed(sourceId: string): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO history_sources (source_id, processed_at)
         VALUES (?, ?)`
      )
      .run(sourceId, Date.now());
  }

  rejectHistorySource(sourceId: string, reason: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO history_sources (source_id, processed_at)
           VALUES (?, ?)`
        )
        .run(sourceId, Date.now());
      this.database
        .prepare(
          `INSERT OR IGNORE INTO history_source_rejections (source_id, reason)
           VALUES (?, ?)`
        )
        .run(sourceId, reason);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getHistorySourceRejection(sourceId: string): HistorySourceRejection | null {
    const row = this.database
      .prepare(
        `SELECT source_id, reason
         FROM history_source_rejections
         WHERE source_id = ?`
      )
      .get(sourceId) as { source_id: string; reason: string } | undefined;
    return row
      ? { sourceId: row.source_id, status: "rejected", reason: row.reason }
      : null;
  }

  updateHistoryTransfer(state: HistoryTransferState): void {
    this.database
      .prepare(
        `INSERT INTO history_transfers
          (device_id, direction, status, chat_id, messages_transferred,
           conversations_transferred, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, direction) DO UPDATE SET
           status = excluded.status,
           chat_id = excluded.chat_id,
           messages_transferred = excluded.messages_transferred,
           conversations_transferred = excluded.conversations_transferred,
           reason = excluded.reason,
           updated_at = excluded.updated_at`
      )
      .run(
        state.deviceId,
        state.direction,
        state.status,
        state.chatId ?? null,
        state.messagesTransferred,
        state.conversationsTransferred,
        state.reason ?? null,
        Date.now()
      );
  }

  getHistoryTransfer(
    deviceId: string,
    direction: HistoryTransferState["direction"]
  ): HistoryTransferState | null {
    const row = this.database
      .prepare(
        `SELECT device_id, direction, status, chat_id, messages_transferred,
                conversations_transferred, reason
         FROM history_transfers
         WHERE device_id = ? AND direction = ?`
      )
      .get(deviceId, direction) as HistoryTransferRow | undefined;
    if (!row) return null;
    return {
      deviceId: row.device_id,
      direction: row.direction,
      status: row.status,
      ...(row.chat_id ? { chatId: row.chat_id } : {}),
      messagesTransferred: row.messages_transferred,
      conversationsTransferred: row.conversations_transferred,
      ...(row.reason ? { reason: row.reason } : {})
    };
  }

  recordToolCall(input: {
    chatId?: string;
    messageId?: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    error?: string;
    startedAt: number;
    endedAt: number;
  }): void {
    this.database
      .prepare(
        `INSERT INTO tool_calls
          (id, chat_id, message_id, tool_name, arguments_json, result_json, error, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.chatId ?? null,
        input.messageId ?? null,
        input.toolName,
        JSON.stringify(input.args),
        JSON.stringify(input.result),
        input.error ?? null,
        input.startedAt,
        input.endedAt
      );
  }

  close(): void {
    this.database.close();
  }
}

interface ChatSessionRow {
  chat_id: string;
  session_id: string;
  session_path: string;
  created_at: number;
  last_used_at: number | null;
  active: number;
}

interface ConversationWorkRow {
  id: string;
  chat_id: string;
  message_id: string;
  frame_json: string;
  work_type: "turn" | "session.new" | "session.info" | "session.resume-list" | "session.resume";
  command_json: string | null;
  status: ConversationWork["status"];
}

interface OutboundRow {
  trace_id: string;
  message_id: string;
  chat_id: string;
  frame_json: string;
  attempts: number;
  last_attempt_at: number | null;
}

interface HistoryTransferRow {
  device_id: string;
  direction: HistoryTransferState["direction"];
  status: HistoryTransferState["status"];
  chat_id: string | null;
  messages_transferred: number;
  conversations_transferred: number;
  reason: string | null;
}

interface StatusSessionRow extends ChatSessionRow {
  queued_work: number;
  running_work: number;
}

function mapChatSession(row: ChatSessionRow): ChatSessionRecord {
  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    sessionPath: row.session_path,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    active: row.active === 1
  };
}

function mapConversationWork(row: ConversationWorkRow): ConversationWork {
  const command = row.command_json === null
    ? null
    : parseStoredSessionCommand(JSON.parse(row.command_json) as unknown);
  if ((row.work_type === "turn") !== (command === null)) {
    throw new Error(`Conversation Work '${row.id}' has inconsistent stored type`);
  }
  if (command && sessionCommandWorkType(command) !== row.work_type) {
    throw new Error(`Conversation Work '${row.id}' has mismatched Session Command`);
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    frame: JSON.parse(row.frame_json) as unknown,
    command,
    status: row.status
  } as ConversationWork;
}

function sessionCommandWorkType(
  command: SessionCommand
): ConversationWorkRow["work_type"] {
  if (command.type === "new") return "session.new";
  if (command.type === "session") return "session.info";
  if (command.type === "resume-list") return "session.resume-list";
  return "session.resume";
}

function parseStoredSessionCommand(value: unknown): SessionCommand {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid stored Session Command");
  }
  if (value.type === "new" || value.type === "session") return { type: value.type };
  if (
    value.type === "resume-list" &&
    "page" in value &&
    typeof value.page === "number" &&
    Number.isSafeInteger(value.page) &&
    value.page > 0
  ) {
    return { type: "resume-list", page: value.page };
  }
  if (
    value.type === "resume" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim()
  ) {
    return { type: "resume", sessionId: value.sessionId };
  }
  throw new Error("Invalid stored Session Command");
}

function classifyReply(frame: unknown): "provisional" | "author-final" | null {
  if (!frame || typeof frame !== "object" || !("event" in frame) || frame.event !== "message.reply") {
    return null;
  }
  const payload = "payload" in frame ? frame.payload : undefined;
  return payload &&
    typeof payload === "object" &&
    "stream_merged" in payload &&
    payload.stream_merged === true
    ? "provisional"
    : "author-final";
}

function mapOutbound(row: OutboundRow): OutboundRecord {
  return {
    traceId: row.trace_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    frame: JSON.parse(row.frame_json) as unknown,
    serializedFrame: row.frame_json,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at
  };
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createProtocolMessageId(timestamp = Date.now()): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error("ULID timestamp must be an integer between 0 and 2^48 - 1");
  }
  const random = crypto.getRandomValues(new Uint8Array(10));
  let randomValue = 0n;
  for (const byte of random) randomValue = (randomValue << 8n) | BigInt(byte);
  return `msg-${encodeCrockford(BigInt(timestamp), 10)}${encodeCrockford(randomValue, 16)}`;
}

function encodeCrockford(value: bigint, length: number): string {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

function getOutboundMessageId(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object" || !("payload" in frame)) return undefined;
  const payload = frame.payload;
  if (!payload || typeof payload !== "object" || !("message_id" in payload)) return undefined;
  return typeof payload.message_id === "string" && payload.message_id.length > 0
    ? payload.message_id
    : undefined;
}

function persistOutboundMessageId(frame: unknown, messageId: string): void {
  if (!frame || typeof frame !== "object") {
    throw new Error("Legacy outbound frame is not an object");
  }
  let payload: object;
  if ("payload" in frame && frame.payload && typeof frame.payload === "object") {
    payload = frame.payload;
  } else {
    payload = {};
    Reflect.set(frame, "payload", payload);
  }
  Reflect.set(payload, "message_id", messageId);
}


function assertOutputMode(value: string): asserts value is ClawchatOutputMode {
  if (value !== "minimal" && value !== "normal" && value !== "full") {
    throw new Error(`Invalid ClawChat output mode '${value}'`);
  }
}
function migrateGatewaySchema(database: DatabaseSyncType): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateConversationSessions(database);
    migrateConversationWork(database);
    migrateChatOutputSettings(database);
    let columns = database.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{
      name: string;
    }>;
    const hasTraceId = columns.some((column) => column.name === "trace_id");
    const hasMessageId = columns.some((column) => column.name === "message_id");
    if (!hasTraceId && hasMessageId) {
      database.exec("ALTER TABLE outbound_messages RENAME COLUMN message_id TO trace_id");
      columns = database.prepare("PRAGMA table_info(outbound_messages)").all() as Array<{
        name: string;
      }>;
    }
    if (!columns.some((column) => column.name === "message_id")) {
      database.exec("ALTER TABLE outbound_messages ADD COLUMN message_id TEXT");
    }
    if (!columns.some((column) => column.name === "last_attempt_at")) {
      database.exec("ALTER TABLE outbound_messages ADD COLUMN last_attempt_at INTEGER");
    }

    const rows = database
      .prepare("SELECT trace_id, message_id, frame_json FROM outbound_messages ORDER BY rowid")
      .all() as Array<{ trace_id: string; message_id: string | null; frame_json: string }>;
    const update = database.prepare(
      "UPDATE outbound_messages SET message_id = ?, frame_json = ? WHERE trace_id = ?"
    );
    const generatedIds = new Set<string>();
    for (const row of rows) {
      const frame = JSON.parse(row.frame_json) as unknown;
      let messageId = row.message_id ?? getOutboundMessageId(frame);
      if (!messageId) {
        do {
          messageId = createProtocolMessageId();
        } while (generatedIds.has(messageId));
        generatedIds.add(messageId);
      }
      if (row.message_id !== messageId || getOutboundMessageId(frame) !== messageId) {
        persistOutboundMessageId(frame, messageId);
        update.run(messageId, JSON.stringify(frame), row.trace_id);
      }
    }
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_message_id ON outbound_messages (message_id)"
    );
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const quarantineColumns = database
      .prepare("PRAGMA table_info(quarantined_frames)")
      .all() as Array<{ name: string }>;
    if (!quarantineColumns.some((column) => column.name === "ackable")) {
      database.exec(
        "ALTER TABLE quarantined_frames ADD COLUMN ackable INTEGER NOT NULL DEFAULT 0 CHECK (ackable IN (0, 1))"
      );
    }
    database.exec(
      `UPDATE quarantined_frames
       SET ackable = 1
       WHERE ack_epoch IS NOT NULL AND dseq IS NOT NULL`
    );
    database
      .prepare(
        `INSERT INTO reliable_ingress_state (ack_epoch, high_water, updated_at)
         SELECT ack_epoch, MAX(dseq), ?
         FROM quarantined_frames
         WHERE ack_epoch IS NOT NULL AND dseq IS NOT NULL
         GROUP BY ack_epoch
         ON CONFLICT(ack_epoch) DO UPDATE SET
           high_water = MAX(high_water, excluded.high_water),
           updated_at = excluded.updated_at`
      )
      .run(Date.now());
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateConversationSessions(database: DatabaseSyncType): void {
  const columns = database.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const current =
    columns.some((column) => column.name === "session_id" && column.pk === 1) &&
    columns.some((column) => column.name === "last_used_at");
  if (current) return;

  const legacyRows = database
    .prepare(
      "SELECT chat_id, session_id, session_path, created_at FROM chat_sessions ORDER BY chat_id"
    )
    .all() as Array<{
      chat_id: string;
      session_id: string;
      session_path: string;
      created_at: number;
    }>;
  database.exec(`
    DROP INDEX IF EXISTS chat_sessions_by_conversation;
    ALTER TABLE chat_sessions RENAME TO chat_sessions_legacy;

    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      session_path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY (chat_id) REFERENCES conversation_session_sets(chat_id) ON DELETE CASCADE
    ) STRICT
  `);
  const insertSet = database.prepare(
    `INSERT INTO conversation_session_sets
      (chat_id, active_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  const insertSession = database.prepare(
    `INSERT INTO chat_sessions
      (session_id, chat_id, session_path, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of legacyRows) {
    insertSet.run(row.chat_id, row.session_id, row.created_at, row.created_at);
    insertSession.run(
      row.session_id,
      row.chat_id,
      row.session_path,
      row.created_at,
      row.created_at
    );
  }
  database.exec(`
    DROP TABLE chat_sessions_legacy;
    CREATE INDEX chat_sessions_by_conversation
      ON chat_sessions (chat_id, created_at DESC)
  `);
}

function migrateConversationWork(database: DatabaseSyncType): void {
  const columns = database.prepare("PRAGMA table_info(chat_turns)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "work_type")) {
    database.exec(
      `ALTER TABLE chat_turns ADD COLUMN work_type TEXT NOT NULL DEFAULT 'turn'
       CHECK (work_type IN ('turn', 'session.new', 'session.info', 'session.resume-list', 'session.resume'))`
    );
  }
  if (!columns.some((column) => column.name === "command_json")) {
    database.exec("ALTER TABLE chat_turns ADD COLUMN command_json TEXT");
  }
}

function migrateChatOutputSettings(database: DatabaseSyncType): void {
  const columns = database.prepare("PRAGMA table_info(chat_output_settings)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "mode")) {
    const rows = database
      .prepare("SELECT mode FROM chat_output_settings")
      .all() as Array<{ mode: string }>;
    for (const row of rows) assertOutputMode(row.mode);
    return;
  }
  if (!columns.some((column) => column.name === "tool_calls")) {
    throw new Error("Invalid Gateway Store chat_output_settings schema");
  }

  const legacyRows = database
    .prepare("SELECT chat_id, tool_calls, updated_at FROM chat_output_settings ORDER BY chat_id")
    .all() as Array<{ chat_id: string; tool_calls: string; updated_at: number }>;
  database.exec(`
    CREATE TABLE chat_output_settings_migrated (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('minimal', 'normal', 'full')),
      updated_at INTEGER NOT NULL
    ) STRICT
  `);
  const insert = database.prepare(
    "INSERT INTO chat_output_settings_migrated (chat_id, mode, updated_at) VALUES (?, ?, ?)"
  );
  for (const row of legacyRows) {
    const mode = row.tool_calls === "on"
      ? "full"
      : row.tool_calls === "off"
        ? "normal"
        : undefined;
    if (!mode) {
      throw new Error(`Invalid legacy ClawChat tool-output value '${row.tool_calls}'`);
    }
    insert.run(row.chat_id, mode, row.updated_at);
  }
  database.exec(`
    DROP TABLE chat_output_settings;
    ALTER TABLE chat_output_settings_migrated RENAME TO chat_output_settings
  `);
}
