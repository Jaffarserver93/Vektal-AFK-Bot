---
name: page.evaluate named-fn __name bug
description: esbuild/tsx injects __name() for named bindings inside page.evaluate() callbacks, breaking them in the browser context
---

## Rule
Never define named `const fn = () => {}` or `function foo() {}` inside a `page.evaluate()` callback when the project uses tsx/esbuild as the TypeScript runner.

## Why
esbuild injects `var __name = ...` at module scope and calls `__name(fn, "fn")` for every named function/arrow binding to preserve `.name` after minification. When Puppeteer serialises the evaluate callback (via `.toString()`), the function body references `__name` but the browser context has no such variable. The evaluate throws `ReferenceError: __name is not defined` and the `.catch()` swallows it, returning silent defaults.

The error message is deliberately cryptic: `app.js:1:200` — you only see it if you rethrow instead of silently catching.

## How to apply
Inside any `page.evaluate()` callback:
- Use only `for` loops, `let`/`const` for plain data, and inline expressions.
- If you need a reusable operation, inline it directly — do not assign it to a named `const`.
- OK: `const t = (el.textContent ?? "").trim();`
- NOT OK: `const getText = (el: any) => (el.textContent ?? "").trim();`
- To debug evaluate failures: change `.catch(() => defaultValue)` to `.catch(err => { throw new Error(...) })` so the real error surfaces in the runner logs.
