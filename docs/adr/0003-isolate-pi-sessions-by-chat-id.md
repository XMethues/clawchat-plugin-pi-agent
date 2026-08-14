# Isolate Pi sessions by ClawChat chat ID

Status: The one-session-per-`chat_id` portion is superseded by ADR-0020; cross-chat isolation remains accepted.

The Headless Pi Host will maintain one process-wide ClawChat Gateway and map every direct or group `chat_id` to its own persistent `AgentSessionRuntime`. Each Chat Session gets a separate `SessionManager`, `DefaultResourceLoader`, extension runtime, queue, and reply state; multiple chats may run concurrently but never share model context. Per-session WebSockets are rejected because ClawChat routes every business event by `chat_id` over the authenticated device connection, while duplicate connections complicate replay and session replacement.
