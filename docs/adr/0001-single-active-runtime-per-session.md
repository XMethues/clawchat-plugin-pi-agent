# Use one active runtime per Pi session

The Headless Pi Host will persist standard Pi sessions and allow a stopped host and Pi TUI to resume each other's session, but two processes will not operate the same session concurrently. This preserves session portability without introducing cross-process coordination for in-memory agent state, active tree position, streaming, and JSONL writes; a future live TUI must share the host's single `AgentSessionRuntime` rather than open the session independently.
