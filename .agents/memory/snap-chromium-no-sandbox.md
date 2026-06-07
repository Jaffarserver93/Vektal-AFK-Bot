---
name: snap Chromium + root + --no-sandbox
description: Why --no-sandbox is still required for snap Chromium when running as root, despite snap providing its own confinement.
---

## The rule
Always pass `--no-sandbox` and `--disable-setuid-sandbox` to Chrome, even for snap Chromium, especially when running as root.

**Why:** snap provides its own EXTERNAL confinement (snapd security policy). Chrome's `--no-sandbox` flag disables Chrome's INTERNAL sandbox (which runs sub-processes as a less-privileged user). These are two completely separate mechanisms. When Chrome runs as root without `--no-sandbox`, it detects root and refuses to start sub-processes (can't drop privileges further from root) → Chrome exits before binding its DevTools port → ECONNREFUSED in puppeteer.

**How to apply:** In every `connect()` call, always include `["--no-sandbox", "--disable-setuid-sandbox"]` in `args[]`. The `ignoreAllFlags: true` (snap path) prevents the library from double-adding flags in conflicting ways, but we add `--no-sandbox` ourselves explicitly.

The earlier theory that "snap Chromium crashes with --no-sandbox" was incorrect — the original crash was caused by a different issue (Xvfb conflict or missing --disable-gpu), not by --no-sandbox itself.
