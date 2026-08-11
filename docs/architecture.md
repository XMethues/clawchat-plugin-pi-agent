# ClawChat Pi Architecture

`clawchat-pi` is a Pi package with two entry points: a management-only standard
Pi Extension and a long-lived, non-interactive Pi SDK Host. The Host exclusively
owns the ClawChat Protocol v2 Gateway; both entry points share profile state,
REST/local tools, memory, packaged skills, and the output projection code used
by Hosted Session Bindings. The complete runtime contract is specified in
`docs/headless-host-spec.md`; delivery is tracked in
<https://github.com/XMethues/clawchat-plugin-pi-agent/issues/1>.

## Components

- `activation.ts` exchanges invite codes with `/v1/agents/connect` using
  `platform: "pi"`.
- `cli.ts` owns command parsing and the `activate`, `run`, and `status`
  workflows without executing as an import side effect.
- `bin.ts` is the thin installed executable entry point that invokes the CLI;
  it contains no reusable command logic or main-module path detection.
- `host-profile.ts` owns canonical Workspace binding, stable device identity,
  credentials, atomic profile writes, and the per-profile process lock.
- `gateway-store.ts` owns SQLite-backed durable admission, per-chat queues,
  deduplication, output/group settings, quarantine, session mappings, and the
  outbound outbox.
- `gateway.ts` owns challenge/connect, capability negotiation, replay gating,
  reliable-delivery v1/v2 acknowledgements, reconnect, self-echo filtering,
  and materialized outbound delivery.
- `session-registry.ts` owns one resident runtime per `chat_id`, cross-chat
  concurrency, same-chat FIFO, restart recovery, and graceful shutdown.
- `pi-session-factory.ts` creates isolated native Pi SDK sessions in the Host
  Profile Workspace and restores their standard JSONL files.
- `headless-host.ts` composes the profile, Store, Gateway, router, Registry,
  Pi session factory, and shutdown lifecycle for `clawchat-pi run`.
- `inbound.ts` extracts materialized ClawChat text and renders the Pi prompt.
- `inbound-router.ts` applies direct/group dispatch and integration commands
  before a message reaches Pi.
- `output-settings.ts` resolves the Host Profile tool-output default and
  per-chat `on`, `off`, or `inherit` override.
- `output-projector.ts` maps completed Pi assistant, thinking, tool, and
  `MEDIA:` attachment output to complete `message.reply` messages and brackets
  work with `typing.update`.
- `clawchat-api.ts` owns authenticated REST and upload envelopes plus the
  single reactive token-refresh retry.
- `clawchat-memory.ts` owns profile-local Markdown memory, metadata/body
  separation, safe atomic writes, search, and bounded turn context.
- `clawchat-tools.ts` registers the pinned ClawChat default tool set, validates
  Active ClawChat Turn mutations, maps permission gates, and records audits.
- `clawchat-runtime.ts` binds a Host Profile to its API and memory runtime.
- `headless-extension.ts` projects one SDK runtime's Pi lifecycle and tools
  without opening a per-session WebSocket.
- `extension.ts` registers Activation, REST/local tools, and packaged prompt
  guidance without opening a WebSocket or accepting remote turns.

There is no legacy output Adapter. The Output Projector is the single seam for
ClawChat output, and the package does not emit `message.created`, `message.add`,
`message.done`, or `message.failed`.

## Current Limits

- The interactive Extension intentionally binds to one active Pi session. Use
  `clawchat-pi run` for durable multi-chat isolation.
- Live concurrent TUI attachment to a Host-owned Pi session is unsupported;
  session handoff is sequential.
- The ClawChat backend must accept `platform: "pi"` for activation.
- The default Headless Pi Host does not advertise awareness or sibling-history
  capabilities. Embedders must provide `onAwarenessSignal` and
  `onHistoryTransit` consumers before those capabilities are declared.
