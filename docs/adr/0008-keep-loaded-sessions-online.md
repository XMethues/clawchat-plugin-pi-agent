# Keep loaded Chat Sessions online with the Host

Status: ADR-0020 adds explicit Session Transition and conversation-deletion disposal; the no-idle-eviction and reconnect lifetime rules remain accepted.

The Headless Pi Host continuously maintains or reconnects its single ClawChat Gateway until the Host process stops. Each Chat Session is loaded on demand, and its `AgentSessionRuntime` and Extension remain alive for the rest of that Online Host Profile's lifetime. The MVP will not use idle timeouts or LRU eviction; temporary WebSocket disconnections trigger replay-capable reconnects and do not dispose Pi runtimes.

This makes the Extension lifecycle follow Pi's runtime lifecycle and keeps every loaded chat immediately available. It intentionally trades increasing resident memory for straightforward online semantics. If resource limits are required later, eviction must be introduced as an explicit operational policy without changing Chat Session identity or deleting persisted Pi history.
