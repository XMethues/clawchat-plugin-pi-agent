# Prioritize deep modules over internal export compatibility

During architecture deepening, undocumented package-root TypeScript exports may be removed or reshaped instead of retained through compatibility modules, aliases, or parallel implementations. User-observable CLI, Pi Extension, ClawChat Protocol, and persisted-data semantics remain stable; preserving accidental `0.1.0` interfaces would obstruct deep modules and leave duplicate implementation paths.
