# Buffer group output for Silent Turns

Group Chat Turns buffer automatic Reply Delivery until the Turn settles so that a final exact `[SILENT]` marker can suppress every assistant, thinking, and tool message while retaining the Turn in Pi context. This deliberately delays non-silent group output but preserves each Output Mode's content and ordering; direct chats remain immediate, direct Agent mentions are ineligible for silence, typing remains visible, aborted buffers are discarded, and already completed explicit sends cannot be retracted.
