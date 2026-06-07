---
name: msUntilNextSlot always-positive pitfall
description: The vektalnodes.in "Next slot opens in" pill is always present — do not use it alone to detect 24h limit exhaustion
---

## Rule
Guard the 24h-limit sleep with `usageToday >= usageMax && msUntilNextSlot > 0`, NOT just `msUntilNextSlot > 0`.

## Why
The earn page always renders a "Next slot opens in Xh Xm" pill, even when the user still has remaining slots (e.g. 5/10 used). This is a rolling timer showing when the oldest completed slot will clear, not a "you are blocked" indicator. If you sleep based on `msUntilNextSlot > 0` alone, the runner will sleep ~18h after every failed cycle regardless of remaining quota.

## How to apply
```typescript
if (!cycleResult.ok && cycleResult.usageToday >= cycleResult.usageMax && cycleResult.msUntilNextSlot > 0) {
  // genuine 24h daily limit — sleep until server-reported next slot
} else {
  // normal cooldown: server-side cooldown + 15s, or default COOLDOWN_MS
}
```
