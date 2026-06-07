---
name: LinkPays 240s timing fix
description: How to satisfy the vektalnodes.in 240s minimum for LP coin credit
---

## The rule
Delay the "Get Link" click on bookyourhotel.in until **237s have elapsed** since the LP button click on /earn. Do NOT pad after the chain completes — by then, linkpays.in has already auto-redirected to vektalnodes.in and the server consumed the session.

## Why
The vektalnodes.in server checks that at least 240s elapsed between POST /earn/linkpays/start and the browser's return from linkpays.in→vektalnodes.in. linkpays.in auto-redirects ~2s after arrival. So: click Get Link at 237s → bookyourhotel→linkpays at 239s → linkpays→vektalnodes at 241s ✓.

Padding AFTER the chain (Step 7.5 style) fails because the server consumes the session on first return (at ~225s) and the post-pad revisit to /earn has no LP session context.

## How to apply
- `handleBookyourhotel(page, chainStartMs)` — pass chainStartMs (set at LP button click)
- Inside, after countdown completes, pad until `Date.now() - chainStartMs >= 237_000`
- Keep a small 5s safety sleep after the chain as a buffer for server processing
- PRE_CLICK_TARGET_MS = 237_000 (245s minimum − 8s redirect latency)
