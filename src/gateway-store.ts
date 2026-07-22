import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface ChatSessionRecord {
  chatId: string;
  sessionId: string;
  sessionPath: string;
}

export interface AdmitInboundInput {
  dedupeKey: string;
  messageId: string;
  chatId: string;
  frame: unknown;
  dispatch: boolean;
  queueTurn?: boolean;
}

export type InboundAdmission =
  | { status: "accepted"; turnId: string | null }
  | { status: "duplicate"; turnId: string | null };

export interface ChatTurn {
  id: string;
  chatId: string;
  messageId: string;
  frame: unknown;
  status: "queued" | "running" | "complete" | "interrupted";
}

export interface OutboundRecord {
  messageId: string;
  chatId: string;
  frame: unknown;
  attempts: number;
}

export interface GatewayStoreStatus {
  sessions: Array<
    ChatSessionRecord & {
      queuedTurns: number;
      runningTurns: number;
    }
  >;
  pendingOutbound: number;
  failedOutbound: number;
  quarantinedFrames: number;
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

      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        session_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chat_turns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
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
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
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
        tool_calls TEXT NOT NULL CHECK (tool_calls IN ('on', 'off')),
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
        event TEXT NOT NULL,
        reason TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (ack_epoch, dseq)
      ) STRICT;
    `);
    return new GatewayStore(database);
  }

  getChatSession(chatId: string): ChatSessionRecord | null {
    const row = this.database
      .prepare("SELECT chat_id, session_id, session_path FROM chat_sessions WHERE chat_id = ?")
      .get(chatId) as ChatSessionRow | undefined;
    return row ? mapChatSession(row) : null;
  }

  getOrCreateChatSession(
    chatId: string,
    create: () => { sessionId: string; sessionPath: string }
  ): ChatSessionRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getChatSession(chatId);
      if (existing) {
        this.database.exec("COMMIT");
        return existing;
      }

      const created = create();
      this.database
        .prepare(
          "INSERT INTO chat_sessions (chat_id, session_id, session_path, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(chatId, created.sessionId, created.sessionPath, Date.now());
      this.database.exec("COMMIT");
      return { chatId, ...created };
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
        .prepare("SELECT chat_id, turn_id FROM inbound_frames WHERE dedupe_key = ?")
        .get(input.dedupeKey) as { chat_id: string; turn_id: string | null } | undefined;
      if (existing) {
        if (existing.chat_id !== input.chatId) {
          throw new Error(`Inbound dedupe identity '${input.dedupeKey}' changed chats`);
        }
        const now = Date.now();
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
        this.database.exec("COMMIT");
        return { status: "duplicate", turnId: existing.turn_id };
      }

      const now = Date.now();
      const frameJson = JSON.stringify(input.frame);
      const queueTurn = input.dispatch && input.queueTurn !== false;
      const turnId = queueTurn ? crypto.randomUUID() : null;
      if (turnId) {
        this.database
          .prepare(
            `INSERT INTO chat_turns
              (id, chat_id, message_id, frame_json, status, admitted_at)
             VALUES (?, ?, ?, ?, 'queued', ?)`
          )
          .run(turnId, input.chatId, input.messageId, frameJson, now);
      }
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
          queueTurn ? "queued" : input.dispatch ? "delivered" : "skipped",
          turnId,
          now
        );
      this.database.exec("COMMIT");
      return { status: "accepted", turnId };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextTurn(chatId: string): ChatTurn | null {
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
          `SELECT id, chat_id, message_id, frame_json, status
           FROM chat_turns
           WHERE chat_id = ? AND status = 'queued'
           ORDER BY sequence
           LIMIT 1`
        )
        .get(chatId) as ChatTurnRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }

      this.database
        .prepare("UPDATE chat_turns SET status = 'running', started_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      this.database.exec("COMMIT");
      return mapChatTurn({ ...row, status: "running" });
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeTurn(turnId: string): void {
    const result = this.database
      .prepare(
        "UPDATE chat_turns SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(Date.now(), turnId);
    if (result.changes !== 1) {
      throw new Error(`Turn '${turnId}' is not running`);
    }
  }

  interruptTurn(turnId: string): void {
    const result = this.database
      .prepare(
        "UPDATE chat_turns SET status = 'interrupted', completed_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(Date.now(), turnId);
    if (result.changes !== 1) {
      throw new Error(`Turn '${turnId}' is not running`);
    }
  }

  recoverAfterRestart(): { interruptedTurnIds: string[] } {
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
      return { interruptedTurnIds: rows.map((row) => row.id) };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listQueuedChatIds(): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT chat_id FROM chat_turns WHERE status = 'queued' ORDER BY chat_id")
      .all() as unknown as Array<{ chat_id: string }>;
    return rows.map((row) => row.chat_id);
  }

  enqueueOutbound(input: { messageId: string; chatId: string; frame: unknown }): void {
    this.database
      .prepare(
        `INSERT INTO outbound_messages
          (message_id, chat_id, frame_json, status, attempts, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      )
      .run(input.messageId, input.chatId, JSON.stringify(input.frame), Date.now());
  }

  listPendingOutbound(): OutboundRecord[] {
    const rows = this.database
      .prepare(
        `SELECT message_id, chat_id, frame_json, attempts
         FROM outbound_messages
         WHERE status = 'pending'
         ORDER BY created_at, rowid`
      )
      .all() as unknown as OutboundRow[];
    return rows.map(mapOutbound);
  }

  recordOutboundAttempt(messageId: string): void {
    const result = this.database
      .prepare(
        `UPDATE outbound_messages
         SET attempts = attempts + 1
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(messageId);
    if (result.changes !== 1) {
      throw new Error(`Outbound message '${messageId}' is not pending`);
    }
  }

  acknowledgeOutbound(messageId: string): void {
    this.database
      .prepare(
        `UPDATE outbound_messages
         SET status = 'acknowledged', acknowledged_at = ?
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(Date.now(), messageId);
  }

  setToolOutputOverride(chatId: string, value: "on" | "off" | "inherit"): void {
    if (value === "inherit") {
      this.database.prepare("DELETE FROM chat_output_settings WHERE chat_id = ?").run(chatId);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO chat_output_settings (chat_id, tool_calls, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           tool_calls = excluded.tool_calls,
           updated_at = excluded.updated_at`
      )
      .run(chatId, value, Date.now());
  }

  getToolOutputOverrides(): Record<string, "on" | "off"> {
    const rows = this.database
      .prepare("SELECT chat_id, tool_calls FROM chat_output_settings ORDER BY chat_id")
      .all() as unknown as Array<{ chat_id: string; tool_calls: "on" | "off" }>;
    return Object.fromEntries(rows.map((row) => [row.chat_id, row.tool_calls]));
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
           COALESCE(SUM(CASE WHEN turns.status = 'queued' THEN 1 ELSE 0 END), 0) AS queued_turns,
           COALESCE(SUM(CASE WHEN turns.status = 'running' THEN 1 ELSE 0 END), 0) AS running_turns
         FROM chat_sessions AS sessions
         LEFT JOIN chat_turns AS turns ON turns.chat_id = sessions.chat_id
         GROUP BY sessions.chat_id, sessions.session_id, sessions.session_path
         ORDER BY sessions.chat_id`
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
        chatId: row.chat_id,
        sessionId: row.session_id,
        sessionPath: row.session_path,
        queuedTurns: row.queued_turns,
        runningTurns: row.running_turns
      })),
      pendingOutbound: pending.count,
      failedOutbound: failed.count,
      quarantinedFrames: quarantined.count
    };
  }

  quarantineInboundFrame(input: {
    ackEpoch?: string;
    dseq?: number;
    event: string;
    reason: string;
    frame: unknown;
  }): void {
    this.database
      .prepare(
        `INSERT INTO quarantined_frames
          (ack_epoch, dseq, event, reason, frame_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ack_epoch, dseq) DO UPDATE SET
           event = excluded.event,
           reason = excluded.reason,
           frame_json = excluded.frame_json`
      )
      .run(
        input.ackEpoch ?? null,
        input.dseq ?? null,
        input.event,
        input.reason,
        JSON.stringify(input.frame),
        Date.now()
      );
  }

  failOutbound(messageId: string, code: string, reason?: string): void {
    this.database
      .prepare(
        `UPDATE outbound_messages
         SET status = 'failed', failed_at = ?, error_code = ?, error_reason = ?
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(Date.now(), code, reason ?? null, messageId);
  }

  close(): void {
    this.database.close();
  }
}

interface ChatSessionRow {
  chat_id: string;
  session_id: string;
  session_path: string;
}

interface ChatTurnRow {
  id: string;
  chat_id: string;
  message_id: string;
  frame_json: string;
  status: ChatTurn["status"];
}

interface OutboundRow {
  message_id: string;
  chat_id: string;
  frame_json: string;
  attempts: number;
}

interface StatusSessionRow extends ChatSessionRow {
  queued_turns: number;
  running_turns: number;
}

function mapChatSession(row: ChatSessionRow): ChatSessionRecord {
  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    sessionPath: row.session_path
  };
}

function mapChatTurn(row: ChatTurnRow): ChatTurn {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    frame: JSON.parse(row.frame_json) as unknown,
    status: row.status
  };
}

function mapOutbound(row: OutboundRow): OutboundRecord {
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    frame: JSON.parse(row.frame_json) as unknown,
    attempts: row.attempts
  };
}
