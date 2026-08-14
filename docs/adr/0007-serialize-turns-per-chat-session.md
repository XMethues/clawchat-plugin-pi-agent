# Serialize turns per Chat Session

Status: The per-Session Chat Turn Queue is superseded by ADR-0020's per-conversation work queue; durable FIFO ordering remains accepted.

Each Chat Session owns a durable FIFO Chat Turn Queue and dispatches at most one Pi turn at a time. A message accepted while that session is busy is queued without interrupting or steering the active turn and without sending a separate busy acknowledgement; once the active turn settles and its terminal reply state is delivered, the session starts the next queued turn. Different Chat Sessions may run concurrently because they own isolated Pi runtimes and queues.

This keeps a single chat's conversational order deterministic, preserves the association between an inbound message and its final reply across reconnects, and matches the queue-oriented ClawChat behavior used by the Hermes integration. Pi SDK `steer` and `followUp` remain runtime primitives rather than the Gateway's admission policy.
