/**
 * linkpays-deep-probe.ts
 * Full deep-dive into linkpays.in/VEKTALNODES_COINS:
 *  - Complete page HTML + inline scripts
 *  - Every network request/response with full headers & bodies
 *  - localStorage, sessionStorage, cookies
 *  - All JS global variables set on page
 *  - WebSocket frames
 *  - Any XHR/fetch with payloads (completion/reward calls)
 *  - setTimeout/setInterval hooks to catch deferred calls
 */

import { connect } from "puppeteer-real-browser";
import { spawn, type ChildProcess } from "child_process";

const TARGET = "https://linkpays.in/VEKTALNODES_COINS";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const XVFB_PATH =
  process.env.XVFB_PATH ??
  "/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin/Xvfb";
const DISPLAY_NUM = ":97";
const OBSERVE_SECONDS = 60;

const SEP = "═".repeat(80);
const DIV = "─".repeat(70);

function log(msg: string) {
  console.log(`[deep-probe ${new Date().toISOString()}] ${msg}`);
}
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x900x24"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    xvfb.on("error", reject);
    setTimeout(() => resolve(xvfb), 1500);
  });
}

async function waitForCloudflare(page: any, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title: string = await page.title().catch(() => "");
    if (!title.toLowerCase().includes("just a moment")) {
      log(`CF cleared: "${title}"`);
      return;
    }
    log(`[CF] waiting... title="${title}"`);
    await sleep(2000);
  }
  log("CF timeout — continuing anyway");
}

async function main() {
  log("=== linkpays.in DEEP PROBE ===");

  const xvfb = await startXvfb();
  process.env.DISPLAY = DISPLAY_NUM;

  let browser: any;
  const cleanup = () => {
    try { browser?.close(); } catch {}
    xvfb.kill("SIGTERM");
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const { browser: b, page } = await connect({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
    customConfig: { chromePath: CHROMIUM_PATH },
    turnstile: true,
    connectOption: { defaultViewport: { width: 1280, height: 900 } },
  } as any);
  browser = b;
  log("Browser launched.");

  // ── CDP: capture everything ────────────────────────────────────────────────
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");

  const allRequests: Record<string, any> = {};
  const allResponses: Record<string, any> = {};
  const allBodies: Record<string, string> = {};
  const wsFrames: any[] = [];

  cdp.on("Network.requestWillBeSent", (evt: any) => {
    allRequests[evt.requestId] = {
      id: evt.requestId,
      url: evt.request.url,
      method: evt.request.method,
      headers: evt.request.headers,
      postData: evt.request.postData ?? null,
      type: evt.type,
      initiator: evt.initiator,
      redirectedFrom: evt.redirectResponse
        ? { url: evt.redirectResponse.url, status: evt.redirectResponse.status, headers: evt.redirectResponse.headers }
        : null,
      ts: new Date().toISOString(),
    };
    if (!evt.request.url.includes("challenge-platform")) {
      log(`→ REQ [${evt.type}] ${evt.request.method} ${evt.request.url.slice(0, 120)}`);
    }
  });

  cdp.on("Network.responseReceived", (evt: any) => {
    allResponses[evt.requestId] = {
      id: evt.requestId,
      url: evt.response.url,
      status: evt.response.status,
      statusText: evt.response.statusText,
      headers: evt.response.headers,
      mime: evt.response.mimeType,
      ts: new Date().toISOString(),
    };
    if (!evt.response.url.includes("challenge-platform")) {
      log(`← RES ${evt.response.status} ${evt.response.url.slice(0, 120)}`);
    }
  });

  cdp.on("Network.loadingFinished", async (evt: any) => {
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
      allBodies[evt.requestId] = body.body;
    } catch {}
  });

  cdp.on("Network.webSocketCreated", (evt: any) => {
    log(`[WS CREATED] ${evt.url}`);
    wsFrames.push({ type: "created", url: evt.url, ts: new Date().toISOString() });
  });
  cdp.on("Network.webSocketFrameSent", (evt: any) => {
    log(`[WS SENT] ${JSON.stringify(evt.response?.payloadData ?? "").slice(0, 200)}`);
    wsFrames.push({ type: "sent", data: evt.response, ts: new Date().toISOString() });
  });
  cdp.on("Network.webSocketFrameReceived", (evt: any) => {
    log(`[WS RECV] ${JSON.stringify(evt.response?.payloadData ?? "").slice(0, 200)}`);
    wsFrames.push({ type: "received", data: evt.response, ts: new Date().toISOString() });
  });

  // ── Inject JS hooks BEFORE page loads to intercept fetch/XHR ──────────────
  await page.evaluateOnNewDocument(() => {
    const w = globalThis as any;

    // Hook fetch
    const origFetch = w.fetch;
    w.fetch = async function (...args: any[]) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] as any)?.url ?? "";
      const opts = args[1] ?? {};
      console.log("[HOOK:fetch] " + url + " | body=" + JSON.stringify(opts.body ?? null));
      const res = await origFetch.apply(this, args);
      const clone = res.clone();
      clone.text().then((t: string) => {
        console.log("[HOOK:fetch:res] " + url + " | " + t.slice(0, 500));
      }).catch(() => {});
      return res;
    };

    // Hook XMLHttpRequest
    const XHR = (globalThis as any).XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any)._hookUrl = url;
      (this as any)._hookMethod = method;
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XHR.prototype.send = function (body?: any) {
      const url = (this as any)._hookUrl ?? "";
      console.log("[HOOK:XHR] " + (this as any)._hookMethod + " " + url + " | body=" + JSON.stringify(body ?? null).slice(0, 300));
      (this as any).addEventListener("load", () => {
        console.log("[HOOK:XHR:res] " + url + " | status=" + (this as any).status + " | " + (this as any).responseText.slice(0, 500));
      });
      return origSend.apply(this, [body]);
    };

    // Hook setTimeout/setInterval to catch deferred work
    const origSetTimeout = w.setTimeout;
    w.setTimeout = function (fn: any, delay: number, ...args: any[]) {
      if (delay > 500 && delay < 120000) {
        console.log("[HOOK:setTimeout] delay=" + delay + "ms fn=" + fn.toString().slice(0, 100));
      }
      return origSetTimeout.apply(this, [fn, delay, ...args]);
    };
  });

  // ── Navigate to linkpays.in directly ──────────────────────────────────────
  log(`Navigating to ${TARGET}`);
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await waitForCloudflare(page);

  log(`Page loaded: "${await page.title()}" — ${page.url()}`);
  await sleep(3000);

  // ── Dump page HTML ─────────────────────────────────────────────────────────
  const html = await page.content();

  // ── Dump all <script> tags ─────────────────────────────────────────────────
  const scripts: string[] = await page.evaluate(() => {
    return Array.from((globalThis as any).document.querySelectorAll("script"))
      .map((s: any) => ({
        src: s.src || "[inline]",
        content: s.src ? "" : s.textContent,
      }))
      .map((s: any) => `SRC: ${s.src}\n${s.content}`);
  });

  // ── Dump storage ───────────────────────────────────────────────────────────
  const storage: any = await page.evaluate(() => {
    const ls: Record<string, string> = {};
    const ss: Record<string, string> = {};
    for (let i = 0; i < (globalThis as any).localStorage.length; i++) {
      const k = (globalThis as any).localStorage.key(i)!;
      ls[k] = (globalThis as any).localStorage.getItem(k) ?? "";
    }
    for (let i = 0; i < (globalThis as any).sessionStorage.length; i++) {
      const k = (globalThis as any).sessionStorage.key(i)!;
      ss[k] = (globalThis as any).sessionStorage.getItem(k) ?? "";
    }
    return { localStorage: ls, sessionStorage: ss };
  });

  // ── Dump interesting global JS variables ───────────────────────────────────
  const globals: any = await page.evaluate(() => {
    const interesting: Record<string, any> = {};
    const skip = new Set(["window", "document", "location", "history", "navigator", "screen",
      "performance", "console", "crypto", "fetch", "XMLHttpRequest", "setTimeout", "setInterval",
      "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
      "addEventListener", "removeEventListener", "dispatchEvent", "postMessage",
      "getComputedStyle", "matchMedia", "open", "close", "focus", "blur", "print",
      "alert", "confirm", "prompt", "ResizeObserver", "MutationObserver", "IntersectionObserver"]);
    for (const key of Object.getOwnPropertyNames(globalThis as any)) {
      if (skip.has(key)) continue;
      try {
        const val = (globalThis as any)[key];
        const t = typeof val;
        if (t === "function") continue;
        if (val === null || val === undefined) continue;
        const str = JSON.stringify(val);
        if (str && str.length < 2000) {
          interesting[key] = val;
        }
      } catch {}
    }
    return interesting;
  });

  // ── Look for buttons/links on the page ────────────────────────────────────
  const pageButtons: string[] = await page.evaluate(() => {
    return [
      ...Array.from((globalThis as any).document.querySelectorAll("button, a, input[type=submit]"))
        .map((el: any) => el.outerHTML.slice(0, 300)),
    ];
  });

  // ── Look for all forms ─────────────────────────────────────────────────────
  const pageForms: string[] = await page.evaluate(() => {
    return Array.from((globalThis as any).document.querySelectorAll("form"))
      .map((f: any) => f.outerHTML.slice(0, 1000));
  });

  // ── Watch for 60 seconds for any activity ─────────────────────────────────
  log(`Observing for ${OBSERVE_SECONDS}s — watching for timers, clicks, API calls...`);

  // Try clicking any visible "continue", "verify", "proceed" buttons
  for (let elapsed = 0; elapsed < OBSERVE_SECONDS * 1000; elapsed += 5000) {
    await sleep(5000);

    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => "");
    log(`[t+${elapsed / 1000}s] url=${currentUrl} title="${currentTitle}"`);

    // Check for any action buttons to click
    const actionBtn = await page.$([
      'button:not([disabled])',
      'a.btn',
      'a.button',
      'input[type="submit"]',
    ].join(", "));

    if (actionBtn) {
      const btnText: string = await page.evaluate((el: any) => el.innerText || el.value || el.href || el.outerHTML.slice(0, 100), actionBtn);
      log(`[AUTO-CLICK] Found button: "${btnText.trim()}" — clicking...`);
      await actionBtn.click().catch(() => {});
      await sleep(2000);
    }

    // Dump storage again for any changes
    const storageNow: any = await page.evaluate(() => {
      const ls: Record<string, string> = {};
      const ss: Record<string, string> = {};
      for (let i = 0; i < (globalThis as any).localStorage.length; i++) {
        const k = (globalThis as any).localStorage.key(i)!;
        ls[k] = (globalThis as any).localStorage.getItem(k) ?? "";
      }
      for (let i = 0; i < (globalThis as any).sessionStorage.length; i++) {
        const k = (globalThis as any).sessionStorage.key(i)!;
        ss[k] = (globalThis as any).sessionStorage.getItem(k) ?? "";
      }
      return { localStorage: ls, sessionStorage: ss };
    }).catch(() => ({}));

    if (JSON.stringify(storageNow) !== JSON.stringify(storage)) {
      log(`[STORAGE CHANGED] ${JSON.stringify(storageNow)}`);
      Object.assign(storage, storageNow);
    }
  }

  // ── Final storage + cookies ────────────────────────────────────────────────
  const finalCookies = await page.cookies().catch(() => []);
  const finalUrl = page.url();
  const finalTitle = await page.title().catch(() => "");

  // ═══════════════════════════════════════════════════════════════════════════
  // PRINT REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n\n" + SEP);
  console.log("DEEP PROBE REPORT — linkpays.in/VEKTALNODES_COINS");
  console.log(SEP);

  console.log("\n" + DIV);
  console.log("FINAL STATE");
  console.log(DIV);
  console.log(`URL   : ${finalUrl}`);
  console.log(`Title : ${finalTitle}`);

  console.log("\n" + DIV);
  console.log("PAGE HTML (first 8000 chars)");
  console.log(DIV);
  console.log(html.slice(0, 8000));

  console.log("\n" + DIV);
  console.log("INLINE SCRIPTS");
  console.log(DIV);
  for (const s of scripts) {
    if (s.includes("[inline]") && s.length > 30) {
      console.log(s.slice(0, 3000));
      console.log("---");
    }
  }

  console.log("\n" + DIV);
  console.log("EXTERNAL SCRIPT URLS");
  console.log(DIV);
  for (const s of scripts) {
    if (!s.includes("[inline]")) {
      const src = s.split("\n")[0];
      console.log(src);
    }
  }

  console.log("\n" + DIV);
  console.log("BUTTONS / LINKS / FORMS");
  console.log(DIV);
  console.log("Buttons:", pageButtons.join("\n"));
  console.log("Forms:", pageForms.join("\n"));

  console.log("\n" + DIV);
  console.log("GLOBAL JS VARIABLES");
  console.log(DIV);
  console.log(JSON.stringify(globals, null, 2));

  console.log("\n" + DIV);
  console.log("STORAGE");
  console.log(DIV);
  console.log("localStorage:", JSON.stringify(storage.localStorage, null, 2));
  console.log("sessionStorage:", JSON.stringify(storage.sessionStorage, null, 2));

  console.log("\n" + DIV);
  console.log("COOKIES");
  console.log(DIV);
  console.log(JSON.stringify(finalCookies, null, 2));

  console.log("\n" + DIV);
  console.log("WEBSOCKET FRAMES");
  console.log(DIV);
  if (wsFrames.length === 0) {
    console.log("(none)");
  } else {
    console.log(JSON.stringify(wsFrames, null, 2));
  }

  console.log("\n" + DIV);
  console.log(`ALL NETWORK REQUESTS (${Object.keys(allRequests).length} total)`);
  console.log(DIV);

  for (const id of Object.keys(allRequests)) {
    const req = allRequests[id];
    const res = allResponses[id];
    const body = allBodies[id];

    // Skip Cloudflare internal challenge noise
    if (
      req.url.includes("challenge-platform") ||
      req.url.includes("cdn-cgi/challenge") ||
      req.url.includes("beacons.gcp") ||
      req.url.includes("google-analytics") ||
      req.url.includes("googletagmanager") ||
      req.url.endsWith(".png") ||
      req.url.endsWith(".jpg") ||
      req.url.endsWith(".gif") ||
      req.url.endsWith(".woff") ||
      req.url.endsWith(".woff2")
    ) continue;

    console.log("\n" + "·".repeat(50));
    console.log(`▶ ${req.method} ${req.url}`);
    console.log(`  Type: ${req.type ?? "?"} | Initiator: ${req.initiator?.type ?? "?"} (${req.initiator?.url ?? ""})`);
    if (req.postData) {
      console.log(`  POST body: ${req.postData}`);
    }
    if (req.redirectedFrom) {
      console.log(`  Redirected from: ${req.redirectedFrom.url} [${req.redirectedFrom.status}]`);
      console.log(`  Redirect headers: ${JSON.stringify(req.redirectedFrom.headers)}`);
    }
    console.log(`  Req headers: ${JSON.stringify(req.headers)}`);
    if (res) {
      console.log(`◀ ${res.status} ${res.statusText} — ${res.mime}`);
      console.log(`  Res headers: ${JSON.stringify(res.headers)}`);
    }
    if (body && body.length > 0) {
      const isBin = body.includes("\x00") || (res?.mime ?? "").includes("image");
      if (!isBin) {
        const preview = body.length > 3000 ? body.slice(0, 3000) + "\n...[truncated]" : body;
        console.log(`  Body:\n${preview}`);
      } else {
        console.log(`  Body: [binary ${body.length} chars]`);
      }
    }
  }

  console.log("\n" + SEP);
  console.log("END OF REPORT");
  console.log(SEP);

  log("Done. Closing.");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
