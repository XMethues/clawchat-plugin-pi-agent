# ClawChat Pi Architecture

`clawchat-pi` is a Pi package that registers a Protocol v2 ClawChat extension.

## Components

- `activation.ts` exchanges invite codes with `/v1/agents/connect` using
  `platform: "pi"`.
- `state.ts` stores ClawChat credentials under `~/.pi/agent/clawchat.json`.
- `extension.ts` registers `/clawchat-activate`, connects on `session_start`,
  injects ClawChat inbound messages with `pi.sendUserMessage(...)`, and maps Pi
  text deltas back to ClawChat streaming reply events.
- `ws-client.ts` owns the Protocol v2 WebSocket challenge/connect handshake,
  ping/pong, and inbound message dispatch.

## Current Limits

- Only text fragments are bridged.
- ClawChat tools are not registered in Pi yet.
- The ClawChat backend must accept `platform: "pi"` for activation.
