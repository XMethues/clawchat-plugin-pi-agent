# Use one SQLite Gateway Store per Host Profile

Each Host Profile owns one local SQLite Gateway Store for inbound admission, deduplication, replay acknowledgement state, Chat Turn Queues, Chat Session mappings, and outbound delivery attempts. Protocol acknowledgement advances only after the corresponding inbound frame has committed, while Pi conversation history remains in Pi's native append-only session JSONL files.

These concerns require atomic updates across several records and must survive process or network failure. One transactional file per profile provides that boundary without coupling independent workspaces, introducing an external service, or inventing a second Pi session format. The storage adapter remains an internal seam so tests can use an isolated temporary database.
