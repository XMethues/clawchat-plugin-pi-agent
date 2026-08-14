# ClawChat Pi Architecture

`clawchat-pi` is a Pi package with two entry points: a management-only standard
Pi Extension and a long-lived, non-interactive Pi SDK Host. The Host exclusively
owns the ClawChat Protocol v2 Gateway; both entry points share profile state,
REST/local tools, memory, packaged skills, and the output projection code used
by Hosted Session Bindings. The complete runtime contract is specified in
`docs/headless-host-spec.md`; delivery is tracked in
<https://github.com/XMethues/clawchat-pi-agent/issues/1>.

## Components

- `activation.ts` exchanges invite codes with `/v1/agents/connect` using
  `platform: "pi"`.
- `cli.ts` owns command parsing and the `activate`, `run`, and `status`
  workflows without executing as an import side effect.
- `bin.ts` is the thin installed executable entry point that invokes the CLI;
  it contains no reusable command logic or main-module path detection.
- `host-profile.ts` owns canonical Workspace binding, stable device identity,
  opaque credentials, structured agent/agent-user/owner identity, independent
  REST/WebSocket/Media endpoints, atomic profile writes, and the exclusive
  per-profile operation lease shared by Activation and Host ownership.
- `gateway-store.ts` owns SQLite-backed durable admission, per-conversation
  work queues, stable message deduplication, reliable quarantine and
  replay-truncation state, output/group settings, Conversation Session Sets,
  and the outbound Outbox.
- `gateway.ts` owns challenge/connect, capability negotiation, replay gating,
  reliable-delivery v1/v2 acknowledgements, repeatable token and nonce recovery,
  reconnect, self-echo filtering, and materialized outbound delivery with
  bounded ACK deadlines.
- `session-registry.ts` owns each conversation's active runtime, cross-chat
  concurrency, same-conversation FIFO, Session Transitions, restart recovery,
  conversation deletion, and graceful shutdown.
- `pi-session-factory.ts` creates, inspects, deletes, and restores isolated
  native Pi SDK sessions in the Host Profile Workspace using standard JSONL.
- `headless-host.ts` composes the profile, Store, Gateway, router, Registry,
  Pi session factory, and shutdown lifecycle for `clawchat-pi run`.
- `inbound.ts` extracts materialized ClawChat text and renders the Pi prompt.
- `inbound-router.ts` applies direct/group dispatch and integration commands
  before a message reaches Pi.
- `output-settings.ts` resolves the Host Profile Output Mode default and
  per-conversation `minimal`, `normal`, `full`, or `inherit` override.
- `output-projector.ts` maps completed Pi assistant, thinking, tool, and
  `MEDIA:` attachment output to complete, unquoted `message.send` messages and
  brackets work with `typing.update`. Explicit reply and structured-mention
  delivery belongs to the Active Turn-scoped `clawchat_send_message` tool.
- `clawchat-api.ts` owns authenticated REST and Media envelopes plus repeatable,
  single-flight reactive token refresh while treating tokens as opaque values.
- `clawchat-memory.ts` owns profile-local Markdown memory, metadata/body
  separation, safe atomic writes, search, and bounded turn context.
- `clawchat-tools.ts` registers the pinned ClawChat default tool set, validates
  Active ClawChat Turn mutations, maps permission gates, and records audits.
- `clawchat-runtime.ts` binds a Host Profile to its API and memory runtime.
- `headless-extension.ts` projects one SDK runtime's Pi lifecycle and tools,
  including explicit user and Awareness Hosted Session Bindings, without opening
  a per-session WebSocket.
- `extension.ts` registers Activation, REST/local tools, and packaged prompt
  guidance without opening a WebSocket or accepting remote turns.

There is no legacy output Adapter. The Output Projector is the single seam for
ClawChat output, and the package does not emit `message.created`, `message.add`,
`message.done`, or `message.failed`.

## Agent Conformance Profile

The Headless Pi Host advertises only `multi_device`, `device_replay`,
`reliable_delivery`, `reliable_delivery_v2`, `delivery_receipt`, and plaintext
`history_sync`, plus `chat_meta_events` and `notify_signals` when the profile has
owner-awareness support. E2EE and `permission_events` remain unadvertised. The
Host does not subscribe to presence, produce `message.read` cursors, or emit
production `message.created` / `message.add` / `message.done` /
`message.failed` output. Inbound streaming lifecycles may be consumed and
materialized once complete; that is separate from production capability.

### Reliable ingress

Socket ingress first separates raw JSON decoding, outer-envelope extraction,
and trustworthy dense `dseq` handling from strict business-event mapping. A
dseq-bearing frame that cannot be parsed, processed, or persisted after its
sequence is identified is quarantined idempotently by connection epoch and
`dseq`; the durable high-water advances and an ACK is scheduled. Invalid JSON
or an envelope without trustworthy `dseq` is quarantined as raw, non-ackable
input and forces a fail-safe reconnect. Unknown dseq-bearing events follow the
same forward-compatible quarantine-and-ACK path instead of wedging replay.

Reliable acknowledgements become eligible only after the associated state is
durable. Dense v2 ACKs are flushed from the frame-processing path, with the
200 ms debounce, immediate `replay.done` flush, graceful-disconnect flush, and
30-second connected high-water resend retained as safeguards. V1 storage `seq`
remains sparse and opaque.

Materialized-message upsert is keyed by stable `message_id`. A provisional
reply is only one with `stream_merged: true`: it cannot overwrite an existing
author-final reply, while a later author-final reply replaces a provisional
copy and updates a still-queued turn atomically. Mention-only Group Dispatch
accepts canonical mention objects, legacy bare user IDs, and the canonical
`all` sentinel; malformed opaque entries are ignored without blocking durable
admission or ACK.

`history.truncated` persists a monotonic `oldest_seq` plus observation time in
the Gateway Store and surfaces it through Gateway diagnostics and
`clawchat-pi status`. It is an operator-visible replay-loss boundary, never a
synthetic user message.

### Durable outbound reconciliation

The Gateway assigns a canonical `msg-` Crockford-base32 ULID before inserting
each materialized outbound frame. That `message_id` is indexed with and
serialized into the Outbox row and is reused across first send, reconnect,
process restart, and legacy-row migration. `trace_id` remains the distinct
`message.ack` / `message.error` correlation key.

After a write to an open socket, the Outbox records attempt count and
last-attempt time and starts a bounded ACK deadline. Positive ACK or negative
`message.error` cancels settlement timing; only the negative ACK marks the row
failed. Expiry leaves it pending, coalesces the expired batch into one
backoff-controlled reconnect, waits for the new replay barrier, and resends the
exact serialized identity. Durable attempt timestamps restore this behavior
after process restart.

### Recovery and Hosted Session Bindings

Exact `nonce mismatch` opens a fresh connection with a new challenge, the same
opaque access token, and normal reconnect backoff. Exact
`authentication failed` permits one single-flight refresh since the prior
successful `hello-ok`; only a later healthy `hello-ok` resets that latch.
Remote-auth-service and unknown transient failures reconnect without refresh,
and a rejected replacement token cannot create a refresh loop.

Every successful `hello-ok` starts non-blocking, single-flight convergence of
the conversation list, known conversation detail and announcement state, and
the connected agent's structured behavior/profile state. Identical snapshots
are no-ops; changes coalesce into at most one owner Awareness Turn per recovery
cycle, while failures retry with bounded backoff.

An Awareness Turn uses an explicit Hosted Session Binding for the owner's
direct Chat Session, not a fabricated inbound message. The binding supplies
Owner Turn Memory, Active ClawChat Turn tool context, and an optional audit
source, and is cleared on success, failure, or abort. Model-generated Awareness
text and output-projection events remain internal; an Awareness Turn can affect
ClawChat only through an explicit registered ClawChat tool call. Automatic
assistant output uses ordinary `message.send`; `clawchat_send_message` lets Pi
deliberately send an explicit reply, structured mentions, or both.

### Activation, identity, and endpoints

CLI and Management Extension Activation take the same exclusive Host Profile
operation lease as Host startup before reading profile state and retain it
through invite redemption, destructive Profile Rebinding reset, profile commit,
and output-setting restoration. Every exit releases only its verified lease.

Host Profiles store separately validated REST and Media HTTP(S) origins and a
WebSocket URL; Media is never inferred from WebSocket state. Access and refresh
tokens are opaque. Routing and control authority come only from the required
structured Activation fields for agent ID, agent-user ID, and owner ID.

## Current Limits

- The interactive Extension intentionally binds to one active Pi session. Use
  `clawchat-pi run` for durable multi-chat isolation.
- Live concurrent TUI attachment to a Host-owned Pi session is unsupported;
  session handoff is sequential.
- The ClawChat backend must accept `platform: "pi"` for activation.
- Awareness requires Activation to return the owner's direct conversation id;
  profiles created from older responses omit awareness capabilities until rebound.
- Sibling history transfer is plaintext only. The package does not advertise E2EE
  or interpret `ciphertext_fragments`.
