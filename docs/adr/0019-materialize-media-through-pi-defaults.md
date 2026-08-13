# Materialize inbound media through Pi defaults

ClawChat media becomes understandable only after the Headless Pi Host downloads it at Turn execution time under a private, Turn-scoped lease. The package will natively bridge images and validated text documents using Pi 0.84.1 defaults, while audio, video, PDF, and other files are handed to Pi as local attachment paths so user-installed Pi Packages may process them; the ClawChat Pi Package will not bundle document, OCR, audio, or video parsers.

## Consequences

Downloads are limited to HTTPS hosts under `clawling.com` or `clawling.chat`, bounded to 100 MiB per attachment and 256 MiB per Turn, retried only within fixed time budgets, and reported independently so one failed attachment does not discard the rest of the Turn. Remote URLs never enter Pi context, original files are removed after the Turn settles, and stale private media directories are cleared at Host startup. Derived images may persist in Pi session history according to Pi defaults. Host Profiles load optional Pi Packages only from their configured Agent Directory; the integration neither detects nor adapts to package-specific tools.
