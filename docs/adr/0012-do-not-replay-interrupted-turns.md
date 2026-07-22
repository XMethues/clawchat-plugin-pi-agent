# Do not automatically replay interrupted Pi turns

On Host restart, an admitted Chat Turn that never started returns to its Chat Session's FIFO queue, but a turn recorded as running is marked interrupted and is not automatically sent to Pi again. The integration does not synthesize an error reply for the interrupted turn; subsequent user messages may continue the persisted Pi session normally.

A process can fail after a Pi tool has changed external state but before the Gateway records turn completion. Automatically replaying that prompt would risk repeating non-idempotent tool effects. This policy prefers an observable missing reply over silent duplicate execution while preserving all work that was durably queued but never started.
