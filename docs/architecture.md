# ClawChat Pi Architecture

`clawchat-pi` is a Protocol v2 client adapter that embeds Pi with the official
SDK instead of driving Pi as a subprocess.

## Components

- `activation.ts` exchanges invite codes with `/v1/agents/connect` using
  `platform: "pi"`.
- `pi-session.ts` creates a Pi SDK `AgentSession` with Pi's normal auth and
  model registry.
- `adapter.ts` maps ClawChat inbound messages to `session.prompt(...)` and maps
  Pi text deltas back to ClawChat streaming reply events.
- `ws-client.ts` owns the Protocol v2 WebSocket challenge/connect handshake,
  ping/pong, and inbound message dispatch.
- `bin/clawchat-pi.ts` exposes a small CLI for activation and starting the
  adapter.

## Current Limits

- Only text fragments are bridged.
- ClawChat tools are not registered in Pi yet.
- Activation prints credentials; persistence should be added before packaging
  this for end users.
- The ClawChat backend must accept `platform: "pi"` for activation.
