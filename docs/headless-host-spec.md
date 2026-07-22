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
- Token streaming or ClawChat streaming lifecycle events.
- ClawChat-specific tool restrictions, sender permissions, approval prompts, or a sandbox.
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
- Activating an existing profile refreshes its credentials but may not change its Workspace. A different Workspace requires a different profile.
- `run` is a foreground process. The operating system or the user's process manager owns daemonization and restart policy.
- `run` fails when another process holds the same profile lock.
- `status` reports activation state, canonical Workspace, device ID, process-lock state, WebSocket state when available, known Chat Sessions, queue counts, and each Pi session file path. It never prints tokens.

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
- stable `device_id`, generated once and reused across activation and reconnects;
- ClawChat base and WebSocket URLs;
- access and refresh credentials;
- ClawChat agent, user, and owner IDs;
- default Tool Output Visibility, initially `off`.

`gateway.sqlite` is mode `0600` and is the Gateway Store described in ADR 0011. It stores protocol and routing state, not model context or secrets duplicated from the profile file.

Pi sessions remain in Pi's standard session directory for the profile Workspace. The Gateway Store maps each `chat_id` to one Pi session ID and allocated JSONL path. Pi materializes a new JSONL file only after its first assistant response; until then, restart recovery may allocate a new path for the same session ID and atomically update that path. A newly observed chat gets a new Pi session ID; an existing materialized mapping is reopened. A mapping is never silently reassigned to a different session ID.

## Runtime topology and module boundaries

| Module | Interface and responsibility |
| --- | --- |
| `HostProfileRepository` | Activates, loads, validates, and atomically saves one profile; owns credentials, stable identity, Workspace binding, and process lock. |
| `GatewayStore` | Transactionally admits inbound frames, records dedupe keys and replay high-water state, owns durable per-chat queues and outbound attempts, and maps chats to Pi sessions. SQLite is the production adapter; tests use a temporary SQLite file. |
| `ClawChatGateway` | Exposes start, stop, admitted-frame delivery, and materialized send operations. Internally owns challenge/connect handshake, capability negotiation, replay, ack batching, reconnect, self-echo filtering, and the outbound outbox. Callers do not manage protocol cursors. |
| `ChatSessionRegistry` | Resolves an admitted `chat_id` to one runtime, lazily creates or restores it, serializes its turns, and disposes all runtimes during Host shutdown. It does not own the WebSocket. |
| `ChatSessionRuntime` | Owns one Pi `AgentSessionRuntime`, `SessionManager`, `SettingsManager`, `ResourceLoader`/Extension runtime, Chat Turn Queue consumer, and effective output settings. It processes one turn at a time. |
| `OutputProjector` | Converts completed Pi assistant, thinking, and visible tool events to complete ClawChat `message.reply` frames and brackets a turn with `typing.update`. It does not own transport or persistence. |

These are module seams, not one-class-per-row requirements. Public interfaces stay small; handshake state, SQL tables, Pi event assembly, and retry mechanics remain hidden inside their owning modules. Tests target each interface's behavior.

## Activation and startup

1. `activate` sends the invite-code request with `platform: "pi"`, the persisted stable device ID, and the existing ClawChat agent type.
2. On success it atomically stores the returned credentials and identity without changing the profile's Workspace or device ID.
3. `run` loads and validates the profile, acquires the profile lock, opens and initializes the Gateway Store, creates the Chat Session Registry, then starts the Gateway.
4. The Host remains online and reconnecting until explicitly stopped. A network disconnect does not dispose Chat Session runtimes or end the process.
5. A profile with an invalid Workspace, unreadable state, unsupported schema, or unavailable lock fails before opening the WebSocket.

## WebSocket behavior

The Gateway follows `docs/client-integration.md` and uses exactly one connection per Host Profile.

### Handshake and capabilities

- Complete `connect.challenge` -> `connect` -> `hello-ok` before sending application frames.
- Advertise only implemented capabilities. The initial Headless Host advertises `multi_device`, `device_replay`, `reliable_delivery`, and `reliable_delivery_v2`.
- Do not advertise chat metadata, delivery receipts, notifications, permissions, history sync, streaming, or encryption until their full contracts exist.
- If `hello-ok.ack_mode` is `dseq`, use reliable-delivery v2. Otherwise fall back to v1 when storage `seq` is present, or legacy behavior when neither reliable mode is granted.
- Treat authentication `hello-fail` as requiring fresh credentials before retry. Treat a remote authentication-service failure or a close without `hello-fail` as reconnectable with backoff.

### Reconnect and replay

- Reconnect with full jitter exponential backoff: 1 second base, factor 2, and 30 second cap.
- Reset backoff only after `hello-ok` and successful passage of the replay boundary.
- Consume replay before normal live dispatch and treat `replay.done` as its explicit boundary.
- For v2, validate dense `dseq` at the socket read layer and bind `message.sync_ack` to the negotiated epoch.
- For v1, treat storage `seq` as sparse and opaque; never wait for missing values.
- Unknown event values are tolerated and logged without crashing the connection.

### Durable admission and acknowledgement

For every inbound frame eligible for reliable delivery:

1. validate its envelope and materialized message body;
2. suppress a self-echo when `sender.id` is the profile's own ClawChat user ID;
3. in one Gateway Store transaction, upsert its stable dedupe identity, record routing state, and either enqueue it or record its terminal skipped state;
4. only after commit, advance the contiguous v2 acknowledgement or v1 cursor acknowledgement;
5. dispatch an accepted queued turn to the Chat Session Registry independently of protocol acknowledgement.

Duplicate replay or live delivery never creates a second Pi turn. Dedupe uses the protocol's stable message/event identity, not `trace_id` or arrival time.

### Outbound delivery

- `message.reply` is inserted into an outbox before the Gateway writes it to the socket.
- Every materialized reply gets one conforming client-generated `message_id`; retries reuse that ID.
- `message.ack` marks the outbox item accepted by the server. Reconnect resends unacknowledged items after replay completes.
- `message.error` applies the terminal or retry behavior defined by the protocol error code.
- `typing.update` is ephemeral, best effort, and never enters the outbox.
- A retry may be delivered more than once by a legacy server, so stable message IDs remain mandatory even without reliable downlink negotiation.

## Routing and chat policy

Direct messages always enter their Chat Session after durable admission. Groups use a persisted Group Dispatch Mode and default to `mention`:

- `mention`: dispatch only when `context.mentions` structurally includes the profile's ClawChat user ID;
- `all`: dispatch every accepted materialized text message;
- `muted`: durably consume, deduplicate, and acknowledge the message, then mark it skipped without invoking Pi.

Integration control commands are recognized before group dispatch policy, never enter Pi context, and remain usable while a group is muted or a Chat Session is busy:

```text
/clawchat-group mention|all|muted
/clawchat-output tools on|off|inherit
```

`/clawchat-group` is valid only in a group. `/clawchat-output` persists a per-Chat-Session Tool Output Visibility override. Consistent with Execution Authority, the integration does not add an owner-only command gate; any participant whose message reaches the ClawChat agent can issue these integration commands.

Unsupported ClawChat content is durably acknowledged and marked skipped. It is not rendered into synthetic prompt text.

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
- Mention mode uses structured mention metadata, not display-name or text matching.
- WebSocket replay duplicates do not create duplicate Pi turns.
- Reliable v2 acknowledgement never advances past an uncommitted or missing dense `dseq`; v1 never assumes dense `seq` values.
- An unacknowledged outbound reply is retried with the same `message_id` after reconnect.
- Thinking output follows the Pi thinking level; tool output follows profile default plus the per-chat override.
- No streaming lifecycle frame or synthetic busy/failure reply is emitted.
- A stopped Host session opens through `pi --session <path>` and is subsequently reusable by the Host.
- A second Host process for the same profile fails fast, while another profile with another Workspace can run concurrently.

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
