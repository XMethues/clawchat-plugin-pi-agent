# PRD: Headless Pi Host with durable multi-chat sessions

Tracker: <https://github.com/XMethues/clawchat-plugin-pi-agent/issues/1>

## Summary

Ship `clawchat-pi`, a long-lived non-interactive executable that lets users communicate with Pi through ClawChat. One running Host Profile maintains one ClawChat Protocol v2 WebSocket, maps every `chat_id` to an isolated persistent Pi SDK runtime, and keeps loaded runtimes resident until the Host stops.

The package continues to ship a standard Pi Extension. The Headless Pi Host embeds Pi with the SDK and loads that Extension into each Chat Session runtime; the two entry points share activation, protocol, routing, settings, and output modules rather than implementing separate bridges.

## Goals

- Run Pi continuously without a TUI while ClawChat is the user interface.
- Bind one ClawChat agent identity and stable device to one local Workspace per Host Profile.
- Isolate direct and group chats by `chat_id`, including Pi context, turn ordering, and output settings.
- Process different Chat Sessions concurrently while preserving FIFO execution within each session.
- Survive WebSocket reconnects and Host restarts without losing admitted queued work or blindly repeating interrupted tool effects.
- Preserve Pi's native model, thinking, tools, extensions, project resources, session format, and execution authority.
- Allow sequential handoff of a persisted session to the Pi TUI.

## Non-goals

- A TUI, web UI, or daemon supervisor.
- Live attachment of a TUI to a Host-owned session.
- Selecting or changing a local `cwd` from a ClawChat message.
- Sharing one Pi session across multiple chats or projects.
- Token streaming or production of ClawChat streaming lifecycle events. The
  Gateway may consume a lifecycle and materialize it after `message.done`.
- ClawChat owner permission events, presence subscriptions, read cursors,
  E2EE, sender-specific tool restrictions, approval prompts, or a sandbox.
- Per-chat WebSockets, idle runtime eviction, TTLs, or an LRU limit.
- Backward compatibility with the current single-file `~/.pi/agent/clawchat.json` state shape. The implementation replaces it with Host Profiles.

## User-facing commands

```text
clawchat-pi activate <invite-code> --cwd <path> [--profile <name>]
clawchat-pi run [--profile <name>]
clawchat-pi status [--profile <name>]
```

- The default profile name is `default`.
- A profile name must match `[A-Za-z0-9._-]+`.
- `activate` resolves `--cwd` through the filesystem and persists its canonical absolute path. The path must exist and be a directory.
- Activating an existing profile explicitly rebinds its identity but may not
  change its Workspace or stable device. A different Workspace requires a
  different profile.
- CLI Activation, Management Extension Activation, and `run` use one exclusive
  Host Profile operation lease. Activation takes it before reading profile state
  and holds it through remote redemption, Profile Rebinding reset, profile
  commit, and output-setting restoration.
- `run` is a foreground process. The operating system or the user's process
  manager owns daemonization and restart policy.
- `run` fails when another Host or Activation holds the same profile lease.
- `status` reports activation state, canonical Workspace, stable device,
  separate REST/WebSocket/Media endpoints, structured agent identity,
  process-lock state, known Chat Sessions and queue counts, pending/failed
  Outbox counts, quarantined frames, and any durable replay-truncation boundary.
  It never prints tokens or message content.

The interactive Extension keeps `/clawchat-activate`. It reads and writes the same named Host Profile state as the executable, with `default` as its default profile.

## Local state

State lives below Pi's agent directory:

```text
<agent-dir>/clawchat/profiles/<profile>/profile.json
<agent-dir>/clawchat/profiles/<profile>/gateway.sqlite
<agent-dir>/clawchat/profiles/<profile>/run.lock
```

`profile.json` is written atomically with mode `0600` and contains:

- schema version and profile name;
- canonical Workspace path;
- stable `device_id`, generated once and reused across Activation and reconnects;
- independently normalized REST and Media HTTP(S) origins plus the validated
  WebSocket URL; none is derived from another;
- opaque access and refresh credentials, never decoded for claims;
- required structured ClawChat agent ID, agent-user ID, and owner ID from
  Activation;
- default Tool Output Visibility, initially `off`.

`gateway.sqlite` is mode `0600` and is the Gateway Store described in ADR 0011. It stores protocol and routing state, not model context or secrets duplicated from the profile file.

Pi sessions remain in Pi's standard session directory for the profile Workspace. The Gateway Store maps each `chat_id` to one Pi session ID and allocated JSONL path. Pi materializes a new JSONL file only after its first assistant response; until then, restart recovery may allocate a new path for the same session ID and atomically update that path. A newly observed chat gets a new Pi session ID; an existing materialized mapping is reopened. A mapping is never silently reassigned to a different session ID.

## Runtime topology and module boundaries

| Module | Interface and responsibility |
| --- | --- |
| `HostProfileRepository` | Activates, loads, validates, and atomically saves one profile; owns opaque credentials, structured identity, separate endpoints, stable device identity, Workspace binding, and the exclusive operation lease shared by Activation and Host ownership. |
| `GatewayStore` | Transactionally admits inbound frames, records message dedupe and reliable ACK high-water state, stores poison quarantine and replay truncation, owns durable per-chat queues and materialized outbound attempts, and maps chats to Pi sessions. SQLite is the production adapter; tests use a temporary SQLite file. |
| `ClawChatGateway` | Exposes start, stop, admitted-frame delivery, and materialized send operations. Internally owns challenge/connect, capability negotiation, token/nonce recovery, replay, ACK scheduling, reconnect, self-echo filtering, stable outbound identity, and ACK-timeout reconciliation. Callers do not manage protocol cursors. |
| `ChatSessionRegistry` | Resolves an admitted `chat_id` to one runtime, lazily creates or restores it, serializes its turns, and disposes all runtimes during Host shutdown. It does not own the WebSocket. |
| `ChatSessionRuntime` | Owns one Pi `AgentSessionRuntime`, `SessionManager`, `SettingsManager`, `ResourceLoader`/Extension runtime, Chat Turn Queue consumer, and effective output settings. It processes one turn at a time. |
| `OutputProjector` | Converts completed Pi assistant, thinking, and visible tool events to unquoted ClawChat `message.send` frames in direct chats and quoted `message.reply` frames in group chats, and brackets a turn with `typing.update`. It does not own transport or persistence. |

These are module seams, not one-class-per-row requirements. Public interfaces stay small; handshake state, SQL tables, Pi event assembly, and retry mechanics remain hidden inside their owning modules. Tests target each interface's behavior.

## Activation and startup

1. `activate` acquires the profile operation lease before reading or preparing
   state, then sends the invite-code request with `platform: "pi"`, the
   persisted stable device ID, and the existing ClawChat agent type.
2. It requires structured agent, agent-user, and owner IDs; stores the returned
   access/refresh credentials as opaque strings; and retains independently
   configured REST, WebSocket, and Media endpoints.
3. A Profile Rebinding clears the previous identity's Gateway Store, ClawChat
   Tool State, profile-local Skills, mappings, queues, and mapped Pi history
   before atomically committing the new identity. Workspace and device remain.
4. The operation lease remains held through invite redemption, reset, commit,
   and output-setting restoration, and is released on every success or error
   path. A running Host blocks Activation before the remote request; an
   Activation in progress blocks Host startup.
5. `run` acquires the same lease before loading the profile, opens and
   initializes the Gateway Store, creates the Chat Session Registry, then starts
   the Gateway.
6. The Host remains online and reconnecting until explicitly stopped. A network
   disconnect does not dispose Chat Session runtimes or end the process.
7. A profile with an invalid Workspace, unreadable state, unsupported schema,
   missing structured identity, incomplete endpoint configuration, or
   unavailable lease fails before opening the WebSocket.

## WebSocket behavior

The Gateway follows `docs/client-integration.md` and uses exactly one connection per Host Profile.

### Handshake and capabilities

- Complete `connect.challenge` -> `connect` -> `hello-ok` before sending
  application frames.
- Advertise only implemented capabilities. The Headless Host advertises
  `multi_device`, `device_replay`, `delivery_receipt`, plaintext `history_sync`,
  `reliable_delivery`, and `reliable_delivery_v2`; when owner-awareness is
  configured it also advertises `chat_meta_events` and `notify_signals`.
- Do not advertise E2EE or `permission_events`. Do not subscribe to presence,
  produce read cursors, or emit production streaming lifecycle output.
- If `hello-ok.ack_mode` is `dseq`, use reliable-delivery v2. Otherwise fall
  back to v1 when storage `seq` is present, or legacy behavior when neither
  reliable mode is granted.
- On exact `authentication failed`, permit one single-flight reactive refresh
  since the last successful `hello-ok`. Only another successful `hello-ok`
  resets the latch, so an immediately rejected replacement cannot hot-loop.
  Remote-auth-service and unknown transient failures reconnect with the same
  opaque token rather than refreshing it.

### Reconnect and replay

- Reconnect with full jitter exponential backoff: 1 second base, factor 2, and 30 second cap.
- Reset backoff only after `hello-ok` and successful passage of the replay boundary.
- Consume replay before normal live dispatch and treat `replay.done` as its explicit boundary.
- For v2, validate dense `dseq` at the socket read layer and bind `message.sync_ack` to the negotiated epoch.
- For v1, treat storage `seq` as sparse and opaque; never wait for missing values.
- Unknown event values are tolerated and logged without crashing the connection.
- Treat exact `nonce mismatch` as recoverable: use normal reconnect backoff,
  open a fresh socket, accept its new challenge, and reuse the same token.
  `invalid connect event` and `invalid connect payload` remain terminal.

### Durable admission and acknowledgement

For every inbound frame eligible for reliable delivery:

1. decode raw JSON and extract a trustworthy next dense `dseq` before strict
   version, event, payload, or business mapping;
2. validate its envelope and materialized message body;
3. suppress a self-echo when `sender.id` is the profile's own ClawChat user ID;
4. in one Gateway Store transaction, upsert its stable dedupe identity, record
   routing state, and either enqueue it or record its terminal skipped state;
5. only after commit, advance the contiguous v2 acknowledgement or v1 cursor
   acknowledgement;
6. dispatch an accepted queued turn to the Chat Session Registry independently
   of protocol acknowledgement.

Duplicate replay or live delivery never creates a second Pi turn. Dedupe uses
the protocol's stable message/event identity, not `trace_id` or arrival time.
For a same-ID reply, only `stream_merged: true` is provisional: it cannot
overwrite an author-final copy, while a later author-final copy atomically
replaces a provisional persisted frame and any still-queued turn.

If a trustworthy dseq-bearing frame fails later parsing, processing, or
persistence, the Store quarantines it idempotently by connection epoch and
`dseq`, advances the durable high-water, and schedules ACK. This includes
unknown future events. Invalid JSON or an envelope without a trustworthy
`dseq` is quarantined as raw non-ackable input and forces fail-safe reconnect;
the Gateway never invents a sequence.

Every durable ACK-high-water advancement schedules one coalesced frame-path
flush of the current high-water. The 200 ms fallback debounce, immediate
`replay.done` flush, graceful-disconnect flush, and unconditional 30-second
connected resend remain active. Per-connection callbacks and high-water state
cannot cross `hello-ok` epochs.

`history.truncated` is handled in v1 and v2. A valid positive `oldest_seq` and
observation time are stored monotonically and exposed by diagnostics and
`status` as an unavailable-earlier-history boundary; it is never injected into
chat. An invalid dseq-bearing boundary follows poison quarantine, while a
non-identifiable invalid boundary is diagnosed without changing stored state.

### Outbound delivery

- Materialized `message.send` and `message.reply` frames receive a canonical
  `msg-` Crockford-base32 ULID before their first Outbox insert.
- The same indexed `message_id` is serialized into the frame and survives first
  send, reconnect resend, process restart, and transactional legacy-row
  migration. It is the server-inbox dedupe identity.
- The client-generated `trace_id` is a separate local correlation key.
  `message.ack` settles the matching row; `message.error` is the only path that
  marks it failed.
- Attempt count and last-attempt time become durable only after writing the
  frame to an open socket. An ACK deadline starts then and is cancelled by
  positive or negative settlement.
- Expiry leaves the row pending, emits actionable status, coalesces an expired
  batch into one backoff-controlled reconnect, waits for the replay barrier,
  then resends the exact serialized frame and `message_id`. Disconnect clears
  only in-memory deadlines, so restart recovery uses durable attempt timestamps.
- `typing.update` is ephemeral, best effort, and never enters the Outbox.

## Routing and chat policy

Direct messages always enter their Chat Session after durable admission. Groups use a persisted Group Dispatch Mode and default to `mention`:

- `mention`: dispatch when `context.mentions` contains a canonical mention
  object for the profile's ClawChat user ID, a legacy bare string equal to that
  ID, or a canonical object naming the reserved `all` sentinel. Missing,
  non-array, null, malformed, and unknown opaque mention entries are ignored
  without blocking persistence or ACK;
- `all`: dispatch every accepted materialized text message;
- `muted`: durably consume, deduplicate, and acknowledge the message, then mark
  it skipped without invoking Pi.

Integration control commands are recognized before group dispatch policy, never enter Pi context, and remain usable while a group is muted or a Chat Session is busy:

```text
/clawchat-group mention|all|muted
/clawchat-output tools on|off|inherit
```

`/clawchat-group` is valid only in a group. `/clawchat-output` persists a per-Chat-Session Tool Output Visibility override. Consistent with Execution Authority, the integration does not add an owner-only command gate; any participant whose message reaches the ClawChat agent can issue these integration commands.

Unsupported ClawChat content is durably acknowledged and marked skipped. It is not rendered into synthetic prompt text.

## Awareness, History Sync, and reconnect convergence

A ClawChat Awareness Turn targets only the owner's direct Chat Session through
an explicit Hosted Session Binding; it does not fabricate an inbound user
message or require an inbound `message_id`. The binding supplies Owner Turn
Memory, optional audit source, output visibility, and Active ClawChat Turn tool
context. Binding state is cleared on success, failure, and abort. Visible
awareness output is an unquoted direct `message.send`; ordinary user turns keep
their inbound quote context and Group Dispatch behavior.

Every successful `hello-ok` starts one non-blocking, single-flight
authoritative recovery. It refreshes the conversation list, detail and
announcement state for known mapped or loaded conversations, and the connected
agent's structured behavior/profile state. Identical snapshots are no-ops;
changed snapshots coalesce into at most one owner Awareness Turn per cycle.
Failures retry with bounded exponential backoff, while live metadata
invalidations remain the low-latency path.

Sibling History Sync is plaintext-only. Every emitted opaque transit payload
includes non-empty `source_device_id` in addition to envelope origin. Receivers
prefer the payload source, fall back to a non-empty envelope origin, preserve
target-device and self-export filtering, and durably reject and mark processed
a transfer with no usable source so it can be acknowledged instead of replayed
forever.

## Chat Session lifecycle

- A Chat Session runtime is created lazily on the first dispatchable message.
- Each runtime has its own Pi `SessionManager`, `SettingsManager`, `ResourceLoader`, Extension runtime, and Pi event subscriptions. Mutable Pi loaders or Extension runtimes are never shared between chats.
- Process-wide immutable model/provider services may be shared when the Pi SDK permits it.
- Every runtime uses the Host Profile Workspace as `cwd` and reopens the JSONL recorded in the Gateway Store.
- Loaded runtimes remain resident until Host shutdown. There is no per-session disconnect, idle expiry, or maximum loaded-session limit.
- The Registry may run different Chat Sessions concurrently. One Chat Session consumes only the head of its durable FIFO queue and starts the next item after `agent_settled` closes the current turn.
- A newly admitted message never steers, interrupts, or becomes a Pi follow-up to the current turn. It waits in the durable queue.

### Restart recovery

- A queued turn that was never started remains queued and resumes in FIFO order.
- Before invoking Pi, the Registry atomically changes that turn from `queued` to `running`.
- After `agent_settled` and durable creation of all materialized replies, it marks the turn complete.
- At startup, a turn left in `running` is marked `interrupted` and is not automatically replayed, per ADR 0012. This avoids repeating non-idempotent tool effects.
- An interrupted turn does not generate adapter-authored failure prose. Its persisted Pi session remains available for later messages and TUI inspection.

## Pi input and output

The inbound prompt contains the accepted materialized text and the minimum sender/chat metadata needed by Pi. Adapter control commands and unsupported content never enter model context.

Output follows these rules:

- emit `typing.update(active=true)` when a Pi turn starts and best-effort `typing.update(active=false)` when it settles or aborts;
- send final assistant text exactly as complete Pi output, without adapter-authored rewriting;
- when the Pi session's native thinking level is not `off`, send completed thinking as a separate materialized reply with `message_mode: "thinking"`;
- send completed tool calls only when the effective Tool Output Visibility is `on`, with `message_mode: "tool"`;
- default Tool Output Visibility is `off`; per-chat `on`, `off`, and `inherit` overrides persist in the Gateway Store;
- emit no `message.created`, `message.add`, `message.done`, or `message.failed` frames;
- emit no synthetic assistant failure or busy message.

The Gateway sends what Pi produces subject only to the explicit thinking and tool-visibility policies above. It does not summarize, redact, or reinterpret assistant output.

## Execution authority

All dispatched messages run with the Pi process's configured tools, project resources, model settings, operating-system permissions, and native Pi safeguards. Direct chats, groups, owners, and non-owners receive no integration-specific differences in tool authority. Operators who require isolation must run the Host under an appropriately restricted operating-system account or container and configure Pi itself accordingly.

## Session handoff to Pi TUI

The MVP supports whole-Host sequential handoff:

1. stop `clawchat-pi run` and wait for it to release the profile lock;
2. obtain the target JSONL path from `clawchat-pi status`;
3. run `pi --session <path>` from the profile Workspace;
4. exit Pi before restarting the Host.

The Host validates the Pi session header and reopens the same file on the next message for that `chat_id`. Running the Host and TUI against the same JSONL concurrently is unsupported. Per-session release while the rest of the Host remains online is deferred.

## Shutdown

On `SIGINT` or `SIGTERM`, the Host:

1. stops dispatching new queued turns while continuing to durably admit frames until the Gateway closes;
2. requests active Pi turns to settle within a 30-second grace period;
3. marks turns still running after the deadline interrupted and emits best-effort `typing.update(active=false)`;
4. flushes reliable-delivery acknowledgements and persisted outbox writes;
5. closes the WebSocket, disposes every Chat Session runtime, closes the Gateway Store, and releases the profile lock.

Queued turns remain durable for the next start. No implicit shutdown occurs because the WebSocket disconnects or all sessions are idle.

## Observability

Structured logs include profile name, connection generation, `chat_id`, turn ID, Pi session ID, protocol event, queue transition, retry count, and terminal outcome. Tokens, message bodies, thinking text, tool arguments/results, and credentials are excluded from default logs. A verbose diagnostic mode may include protocol envelopes only after explicit operator opt-in and credential redaction.

## Acceptance criteria

- Two direct chats create two Pi JSONL sessions and cannot observe each other's context.
- A direct and a group with different `chat_id` values are isolated identically.
- Two chats can run Pi turns concurrently; two messages in one busy chat execute strictly FIFO.
- Restart resumes never-started queued messages but does not repeat a turn that was already running.
- Muted groups receive, persist, deduplicate, and acknowledge frames without invoking Pi; `/clawchat-group mention` can unmute them.
- Mention mode accepts canonical agent mentions, legacy bare IDs, and the
  canonical everyone sentinel while malformed mention data remains ackable.
- WebSocket replay duplicates do not create duplicate Pi turns, and
  author-final replies win over provisional stream-merged copies in either
  arrival order.
- Reliable v2 acknowledgement never advances past an uncommitted or missing
  dense `dseq`; poison with trustworthy dseq is quarantined and acknowledged,
  while non-identifiable input is never falsely acknowledged.
- Frame-path, debounce, replay-boundary, disconnect, and heartbeat ACK paths
  remain live, and a monotonic replay-truncation boundary is visible in status.
- An unacknowledged outbound reply retains one durable canonical `message_id`
  through ACK-timeout/backoff/replay reconciliation and process restart;
  `trace_id` remains only its ACK/error correlation key.
- Thinking output follows the Pi thinking level; tool output follows profile default plus the per-chat override.
- No streaming lifecycle frame or synthetic busy/failure reply is emitted.
- A stopped Host session opens through `pi --session <path>` and is subsequently reusable by the Host.
- A second Host process for the same profile fails fast, while another profile with another Workspace can run concurrently.
- Reactive token refresh is reusable after each healthy connection without a
  rejected-token hot loop, and nonce mismatch retries with a fresh challenge.
- Activation and Host startup exclude each other for the complete profile
  transaction, including remote redemption and Profile Rebinding reset.
- Awareness runs through the owner's Hosted Session Binding with Owner Turn
  Memory and tool context; reconnect metadata recovery is idempotent and
  coalesced.
- Plaintext History Sync resolves payload source identity, falls back to
  envelope origin, and terminates malformed source-less transfers durably.
- REST, WebSocket, and Media endpoints remain independent, tokens remain
  opaque, and identity authority comes only from structured Activation fields.

## Implementation sequence

1. Replace single-file state with Host Profile repository, CLI commands, stable identity, locking, and SQLite Gateway Store.
2. Deepen the WebSocket client into `ClawChatGateway` with protocol-complete handshake, durable admission, reliable v2/v1 acknowledgement, replay, reconnect, and outbound outbox.
3. Add `ChatSessionRegistry` and one Pi SDK runtime per `chat_id`, using native Pi session files and per-chat FIFO recovery.
4. Add group modes, integration control commands, and persisted per-chat output projection to the Headless Host.
5. Add shutdown, status/session handoff, structured diagnostics, concurrency/restart tests, and end-to-end protocol fixtures.

## Source of truth

- Domain terms: `CONTEXT.md`
- Decisions: `docs/adr/0001-*.md` through `docs/adr/0012-*.md`
- ClawChat protocol contract: `docs/client-integration.md`
- Pi extension contract: <https://pi.dev/docs/latest/extensions>
- Pi SDK contract: <https://pi.dev/docs/latest/sdk>
