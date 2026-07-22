# Domain Docs

How engineering skills should consume this repository’s domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- `CONTEXT-MAP.md` instead, if one is introduced later.
- ADRs under `docs/adr/` that affect the area being changed.

If these files do not exist, proceed silently. Do not create them merely because they are absent. `/domain-modeling`, usually reached through `/grill-with-docs` or `/improve-codebase-architecture`, creates them when terminology or architectural decisions are actually resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary’s vocabulary

When an issue, specification, test, or implementation names a domain concept, use the term defined in `CONTEXT.md`. Avoid synonyms the glossary explicitly rejects.

If a required concept is missing, reconsider whether new terminology is necessary or record the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
