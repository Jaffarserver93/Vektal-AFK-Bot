/**
 * linkpays-complete-probe.ts
 * 
 * Follows the COMPLETE flow from /earn click all the way through:
 * 1. POST /earn/linkpays/start
 * 2. linkpays.in Secure Gateway → proceed() → rank1st.in
 * 3. rank1st.in full HTML + all links/redirects back to vektalnodes.in
 * 4. Any token/session in return URL
 * 5. Manually hits the return URL and captures coin credit response
 */

import { connect } from "puppeteer-real-browser";
import { spawn, execSync, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.VEKTAL_EMAIL ?? "";
const PASSWORD = process.env.VEKTAL_PASSWORD ?? "";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  process.env.PUPPETEER_EXECUTABLE_PATH ??
  (() => {
    try { const p = execSync("which chromium 2>/dev/null").toString().trim(); if (p) return p; } catch {}
    try { const p = execSync("which chromium-browser 2>/dev/null").toString().trim(); if (p) return p; } catch {}
    for (const c of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
      try { execSync(`test -x ${c}`); return c; } catch {}
    }
    return "/usr/bin/chromium-browser";
  })();
const XVFB_PATH = process.env.XVFB_PATH ?? "/usr/bin/Xvfb";
const DISPLAY_NUM = ":98";
const IS_SNAP_CHROMIUM =
  process.env.IS_SNAP_CHROMIUM === "true" ||
  CHROMIUM_PATH.includes("/snap/") ||
  (() => {
    try {
      const resolved = execSync(`readlink -f "${CHROMIUM_PATH}" 2>/dev/null || echo ""`).toString().trim();
      if (resolved.includes("/snap/")) return true;
      // Ubuntu 22.04+: /usr/bin/chromium-browser is a shell script wrapper — read it
      const head = execSync(`head -5 "${CHROMIUM_PATH}" 2>/dev/null || echo ""`).toString();
      return head.includes("/snap/");
    } catch { return false; }
  })();
const MINIMUM_WAIT_MS = 245_000; // 245s > 240s minimum

function log(m: string) { console.log(`[probe ${new Date().toISOString()}] ${m}`); }
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function startXvfb(): Promise<ChildProcess | null> {
  if (process.env.DISPLAY) {
    log(`[Xvfb] DISPLAY already set to ${process.env.DISPLAY} — skipping internal Xvfb spawn.`);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const xvfb = spawn(
      XVFB_PATH,
      [DISPLAY_NUM, "-screen", "0", "1280x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
    xvfb.on("error", reject);
    setTimeout(() => resolve(xvfb), 2000);
  });
}

async function waitForCF(page: any, ms = 45_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const t: string = await page.title().catch(() => "");
    if (!t.toLowerCase().includes("just a moment")) return;
    await sleep(2000);
  }
}

function attachNet(cdp: any, label: string, store: { reqs: any[], ress: any[], bodies: Record<string,string> }) {
  cdp.on("Network.requestWillBeSent", (e: any) => {
    const url = e.request.url;
    const noise = ["challenge-platform", "googlesyndication", "doubleclick", "gravatar",
      "criteo", "openx", ".png", ".jpg", ".woff", "fonts.g", "cloudflareinsights",
      "google-analytics", "googletagmanager", "fundingchoices", "adtrafficquality"];
    if (!noise.some(n => url.includes(n)))
      log(`[${label}] → ${e.request.method} ${url.slice(0,140)} post=${e.request.postData?.slice(0,100) ?? ""}`);
    store.reqs.push({
      id: e.requestId, label, url, method: e.request.method,
      headers: e.request.headers, postData: e.request.postData ?? null,
      type: e.type, redirect: e.redirectResponse ?? null, ts: Date.now(),
    });
  });
  cdp.on("Network.responseReceived", (e: any) => {
    const url = e.response.url;
    const noise = ["challenge-platform", "googlesyndication", "doubleclick", "gravatar",
      "criteo", "openx", ".png", ".jpg", ".woff", "fonts.g", "cloudflareinsights"];
    if (!noise.some(n => url.includes(n)))
      log(`[${label}] ← ${e.response.status} ${url.slice(0,140)}`);
    store.ress.push({ id: e.requestId, label, url, status: e.response.status, headers: e.response.headers, mime: e.response.mimeType });
  });
  cdp.on("Network.loadingFinished", async (e: any) => {
    try { const r = await cdp.send("Network.getResponseBody", { requestId: e.requestId }); store.bodies[e.requestId] = r.body; } catch {}
  });
}

async function main() {
  log("=== LINKPAYS COMPLETE FLOW PROBE ===");
  const xvfb = await startXvfb();
  if (!process.env.DISPLAY) process.env.DISPLAY = DISPLAY_NUM;
  log(`DISPLAY=${process.env.DISPLAY} | chromium=${CHROMIUM_PATH} | snap=${IS_SNAP_CHROMIUM}`);

  let browser: any;
  const cleanup = () => { try { browser?.close(); } catch {} if (xvfb) xvfb.kill("SIGTERM"); };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const sandboxArgs = IS_SNAP_CHROMIUM ? [] : ["--no-sandbox", "--disable-setuid-sandbox"];
  const { browser: b, page } = await connect({
    headless: false,
    args: [...sandboxArgs, "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-software-rasterizer", "--disable-extensions",
      "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,900"],
    customConfig: { chromePath: CHROMIUM_PATH },
    turnstile: true,
    connectOption: { defaultViewport: { width: 1280, height: 900 } },
  } as any);
  browser = b;

  const store: { reqs: any[], ress: any[], bodies: Record<string,string> } = { reqs: [], ress: [], bodies: {} };
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  attachNet(cdp, "TAB", store);

  // Track new tabs
  const tabs: any[] = [];
  browser.on("targetcreated", async (target: any) => {
    const p = await target.page().catch(() => null);
    if (p && p !== page) {
      log(`[NEW_TAB] ${target.url()}`);
      const c = await p.createCDPSession().catch(() => null);
      if (c) { await c.send("Network.enable").catch(() => {}); attachNet(c, "NEW_TAB", store); }
      tabs.push(p);
    }
  });

  // Inject console bridge
  await page.evaluateOnNewDocument(() => {
    const w = globalThis as any;
    const orig = w.console.log;
    w.console.log = (...args: any[]) => { orig(...args); };
  });

  page.on("console", (msg: any) => {
    const t = msg.text();
    if (t.includes("[F") || t.includes("[X") || t.includes("SUBMIT") || t.includes("vektalnodes"))
      log(`[PAGE] ${t}`);
  });

  // ── 1. Login ─────────────────────────────────────────────────────────────
  log("Logging in...");
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);
  await sleep(600);
  const emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) throw new Error("No email input");
  await emailEl.click({ clickCount: 3 }); await emailEl.type(EMAIL, { delay: 55 });
  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("No pass input");
  await passEl.click({ clickCount: 3 }); await passEl.type(PASSWORD, { delay: 55 });
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);
  await waitForCF(page);
  log(`Logged in → ${page.url()}`);

  // ── 2. Go to /earn ───────────────────────────────────────────────────────
  if (!page.url().includes("/earn")) {
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(page);
  }
  await sleep(1000);
  
  // Save CSRF token and session state
  const csrfToken: string = await page.evaluate(() => {
    const m = (globalThis as any).document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : "";
  });
  const cookies = await page.cookies();
  const sessionCookie = cookies.find((c: any) => c.name === "connect.sid");
  const cfClearance = cookies.find((c: any) => c.name === "cf_clearance");
  
  log(`CSRF: ${csrfToken}`);
  log(`Session cookie: ${sessionCookie?.value?.slice(0, 40)}...`);

  const SEP = "═".repeat(80);
  const DIV = "─".repeat(70);

  // ── 3. Clear net + click LinkPays button ─────────────────────────────────
  log("Clearing network capture. Clicking 'Open LinkPays'...");
  store.reqs.length = 0; store.ress.length = 0;
  Object.keys(store.bodies).forEach(k => delete store.bodies[k]);

  // Inject XHR/fetch monitor before click
  await page.evaluate(() => {
    const w = globalThis as any;
    const origFetch = w.fetch;
    w.fetch = async function (...args: any[]) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] as any)?.url ?? "";
      console.log("[FETCH_OUT] " + url);
      const res = await origFetch.apply(this, args);
      const clone = res.clone();
      clone.text().then((t: string) => console.log("[FETCH_IN] " + url + " → " + t.slice(0, 400))).catch(() => {});
      return res;
    };
  });

  const lpBtn = await page.$('button.button-primary[type="submit"]');
  if (!lpBtn) {
    const all: string[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("button")).map((b: any) => b.outerHTML)
    );
    log("WARNING: No button-primary found. All buttons:\n" + all.join("\n"));
  } else {
    const txt: string = await page.evaluate((el: any) => el.innerText, lpBtn);
    log(`Clicking: "${txt.trim()}"`);
    const startTime = Date.now();
    await lpBtn.click();
    log(`Clicked at ${new Date().toISOString()}`);

    // ── 4. Follow through linkpays.in ───────────────────────────────────────
    log("Watching navigation...");
    let prevUrl = page.url();
    
    // Wait for navigation to linkpays.in
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const u = page.url();
      if (u !== prevUrl) { log(`[MAIN] navigated → ${u}`); prevUrl = u; }
      if (u.includes("linkpays.in")) { log("Arrived at linkpays.in!"); break; }
    }

    // ── 5. Capture linkpays.in full HTML + JS ───────────────────────────────
    const linkpaysHtml = await page.content().catch(() => "");
    const linkpaysUrl = page.url();
    writeFileSync("/tmp/linkpays-page.html", linkpaysHtml, "utf8");
    log(`linkpays.in HTML: ${linkpaysHtml.length} chars → /tmp/linkpays-page.html`);

    // Get all inline scripts from linkpays.in
    const linkpaysScripts: any[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("script")).map((s: any) => ({
        src: s.src || null, content: s.textContent || "",
      }))
    ).catch(() => []);

    // Get cookies on linkpays.in
    const linkpaysCookies = await page.cookies().catch(() => []);

    console.log("\n" + SEP);
    console.log("LINKPAYS.IN PAGE");
    console.log(SEP);
    console.log(`URL: ${linkpaysUrl}`);
    console.log("Cookies:", JSON.stringify(linkpaysCookies, null, 2));
    console.log("\n— ALL INLINE SCRIPTS ON LINKPAYS.IN —");
    for (const s of linkpaysScripts) {
      if (!s.src && s.content.trim().length > 30) {
        console.log("--- SCRIPT ---");
        console.log(s.content);
        console.log("--- END ---");
      }
    }

    // ── 6. Execute proceed() to navigate to rank1st.in ─────────────────────
    log("Executing proceed() on linkpays.in to trigger the redirect...");
    
    // Wait for proceed to exist or just call it
    await sleep(4000); // Wait for the 3.5s timeout to fire naturally
    
    const afterProceedUrl = page.url();
    log(`URL after wait: ${afterProceedUrl}`);

    // Monitor for redirect to rank1st.in
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const u = page.url();
      if (u !== afterProceedUrl && u.includes("rank1st")) {
        log(`Arrived at rank1st.in: ${u}`); break;
      }
      if (u !== afterProceedUrl) { log(`URL changed → ${u}`); }
    }

    // ── 7. Capture rank1st.in full HTML + all links ─────────────────────────
    const rank1stUrl = page.url();
    log(`rank1st.in URL: ${rank1stUrl}`);
    
    const rank1stHtml = await page.content().catch(() => "");
    writeFileSync("/tmp/rank1st-page.html", rank1stHtml, "utf8");
    log(`rank1st.in HTML: ${rank1stHtml.length} chars → /tmp/rank1st-page.html`);

    // Get all links on rank1st.in that go back to vektalnodes
    const rank1stLinks: any = await page.evaluate(() => {
      const allLinks = Array.from((globalThis as any).document.querySelectorAll("a[href]"))
        .map((a: any) => ({ href: a.href, text: a.innerText.trim().slice(0, 100) }));
      const vektalLinks = allLinks.filter((l: any) => l.href.includes("vektalnodes"));
      const rank1stButtons = Array.from((globalThis as any).document.querySelectorAll("button, a.btn")).map((el: any) => el.outerHTML.slice(0, 200));
      return { allLinks: allLinks.slice(0, 30), vektalLinks, buttons: rank1stButtons };
    }).catch(() => ({}));

    // Get rank1st cookies
    const rank1stCookies = await page.cookies().catch(() => []);

    // Get rank1st inline scripts
    const rank1stScripts: any[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("script")).map((s: any) => ({
        src: s.src || null, content: s.textContent || "",
      }))
    ).catch(() => []);

    console.log("\n" + SEP);
    console.log("RANK1ST.IN PAGE");
    console.log(SEP);
    console.log(`URL: ${rank1stUrl}`);
    console.log("Cookies:", JSON.stringify(rank1stCookies, null, 2));
    console.log("\n— LINKS BACK TO VEKTALNODES —");
    console.log(JSON.stringify(rank1stLinks.vektalLinks, null, 2));
    console.log("\n— ALL LINKS (first 30) —");
    console.log(JSON.stringify(rank1stLinks.allLinks, null, 2));
    console.log("\n— BUTTONS —");
    console.log((rank1stLinks.buttons ?? []).join("\n"));
    console.log("\n— INLINE SCRIPTS ON RANK1ST —");
    for (const s of rank1stScripts) {
      if (!s.src && s.content.trim().length > 30) {
        console.log("--- SCRIPT ---");
        console.log(s.content.slice(0, 3000));
        console.log("--- END ---");
      }
    }

    // ── 8. Watch for auto-redirect from rank1st.in ──────────────────────────
    log("Watching rank1st.in for auto-redirect back to vektalnodes.in (30s)...");
    let prevRank1stUrl = rank1stUrl;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const u = page.url();
      if (u !== prevRank1stUrl) {
        log(`[rank1st REDIRECT] → ${u}`);
        prevRank1stUrl = u;
        if (u.includes("vektalnodes")) {
          log("RETURNED TO VEKTALNODES.IN!");
          const html = await page.content().catch(() => "");
          writeFileSync("/tmp/vektal-return.html", html, "utf8");
          log(`Return page HTML: ${html.length} chars → /tmp/vektal-return.html`);
          break;
        }
      }
    }

    // ── 9. Now wait 245s total minimum, then navigate back to /earn ─────────
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, MINIMUM_WAIT_MS - elapsed);
    log(`Elapsed since click: ${Math.round(elapsed/1000)}s. Need to wait ${Math.round(remaining/1000)}s more for credit...`);
    
    if (remaining > 0) {
      log(`Waiting ${Math.round(remaining/1000)}s...`);
      // Tick every 30s
      for (let t = 0; t < remaining; t += 30000) {
        await sleep(Math.min(30000, remaining - t));
        log(`[waiting] ${Math.round((t + 30000)/1000)}s elapsed of ${Math.round(remaining/1000)}s`);
      }
    }

    // ── 10. Navigate back to /earn to trigger credit ─────────────────────────
    log("Navigating back to /earn to trigger credit...");
    store.reqs.length = 0; store.ress.length = 0;
    Object.keys(store.bodies).forEach(k => delete store.bodies[k]);

    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(page);
    await sleep(2000);

    const earnAfterUrl = page.url();
    const earnAfterHtml = await page.content().catch(() => "");
    writeFileSync("/tmp/earn-after.html", earnAfterHtml, "utf8");
    log(`Returned to /earn: ${earnAfterUrl}`);

    // Get coin count after
    const coinsAfter: string = await page.evaluate(() => {
      const el = (globalThis as any).document.querySelector(".topbar-pill strong");
      return el ? el.innerText : "?";
    }).catch(() => "?");
    log(`COINS AFTER RETURN: ${coinsAfter}`);

    // ── 11. Print full network capture ────────────────────────────────────────
    console.log("\n" + SEP);
    console.log(`NETWORK — ${store.reqs.length} requests captured`);
    console.log(SEP);

    const noise = ["googlesyndication", "doubleclick", "google-analytics", "googletagmanager",
      "criteo", "openx", "gravatar", "cloudflareinsights", "fundingchoices", ".png", ".jpg",
      ".gif", ".woff", ".css", "challenge-platform", "fonts.g", "applixir.app"];

    for (const req of store.reqs) {
      if (noise.some(n => req.url.includes(n))) continue;
      const res = store.ress.find(r => r.id === req.id);
      const body = store.bodies[req.id];

      console.log("\n" + "·".repeat(60));
      console.log(`[${req.label}] ▶ ${req.method} ${req.url}`);
      console.log(`  type=${req.type}`);
      if (req.redirect) console.log(`  ↪ from redirect: ${req.redirect.url} [${req.redirect.status}] → headers: ${JSON.stringify(req.redirect.headers)}`);
      if (req.postData) console.log(`  POST: ${req.postData}`);
      if (res) {
        console.log(`◀ ${res.status} ${res.mime}`);
        console.log(`  Res headers: ${JSON.stringify(res.headers).slice(0, 800)}`);
      }
      if (body && !body.includes("\x00")) console.log(`  Body:\n${body.slice(0, 3000)}`);
    }

    // Print /earn after return
    console.log("\n" + SEP);
    console.log(`/earn AFTER RETURN — coins: ${coinsAfter}`);
    console.log(SEP);
    console.log(earnAfterHtml.slice(0, 5000));
  }

  console.log("\n" + SEP);
  console.log("PROBE COMPLETE");
  console.log(SEP);

  cleanup();
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
