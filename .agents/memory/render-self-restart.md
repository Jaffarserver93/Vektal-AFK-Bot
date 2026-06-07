---
name: Render process self-restart pattern
description: How to keep a long-running bot alive on Render without the container restarting
---

## Rule
Never let the main Node process exit on a recoverable error when running on Render. Wrap all bot logic (browser launch → login → cycle loop) in a separate `runBot()` function; `main()` calls it in an infinite `while (!stopping)` loop with a `try/catch` and a 30s sleep on error.

## Why
When the Node process exits with any non-zero code, Render restarts the entire container. On Render, Cloudflare challenges sometimes take longer than expected, causing `"No email input on login page"` to propagate to `main()` and crash. The container restart wastes ~30s and shows noisy restart logs. With the self-restart pattern, only the browser session is restarted (browser.close → re-launch), the health-check server and Xvfb keep running, and Render never sees the process die.

## How to apply
Structure:
1. `main()` — starts health server once, starts Xvfb once, installs SIGTERM/SIGINT handlers that set `stopping = true` and call `process.exit(0)`.
2. `runBot(xvfb, cycleNumRef)` — launches browser, logs in, runs cycle loop. Any throw propagates to `main()`.
3. `main()` infinite loop: `while (!stopping) { try { await runBot(...) } catch { log error; await sleep(30_000); } }`
4. A shared `cycleNumRef = { n: 0 }` counter persists across browser restarts so cycle numbering is sequential.
