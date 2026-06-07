/**
 * linkpays-full-flow.ts
 * Full end-to-end capture:
 *  1. Login to vektalnodes.in
 *  2. Capture /earn page HTML + ALL JS (cooldown timer, button enable logic)
 *  3. Click "Open LinkPays" → follow through linkpays.in
 *  4. Follow through rank1st.in → wherever it ends
 *  5. Capture any callback/credit API call back to vektalnodes.in
 *  6. Watch for 300s cooldown reset on /earn
 */

import { connect } from "puppeteer-real-browser";
import { spawn, execSync, type ChildProcess } from "child_process";

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
const DISPLAY_NUM = ":96";
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

const SEP = "═".repeat(80);
const DIV = "─".repeat(70);

if (!EMAIL || !PASSWORD) { console.error("Missing credentials"); process.exit(1); }

function log(msg: string) { console.log(`[flow ${new Date().toISOString()}] ${msg}`); }
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

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

async function waitForCloudflare(page: any, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title: string = await page.title().catch(() => "");
    if (!title.toLowerCase().includes("just a moment")) return;
    await sleep(2000);
  }
}

function attachCDP(cdpClient: any, label: string, store: { reqs: any[], ress: any[], bodies: Record<string,string> }) {
  cdpClient.on("Network.requestWillBeSent", (evt: any) => {
    store.reqs.push({
      label, id: evt.requestId, url: evt.request.url,
      method: evt.request.method, headers: evt.request.headers,
      postData: evt.request.postData ?? null,
      type: evt.type, initiator: evt.initiator?.type,
      redirect: evt.redirectResponse ? { url: evt.redirectResponse.url, status: evt.redirectResponse.status, headers: evt.redirectResponse.headers } : null,
      ts: new Date().toISOString(),
    });
    const url = evt.request.url;
    if (!url.includes("challenge-platform") && !url.includes("doubleclick") && !url.includes("google") && !url.includes("criteo") && !url.includes("openx") && !url.includes("gravatar"))
      log(`[${label}] → ${evt.request.method} ${url.slice(0, 120)}`);
  });
  cdpClient.on("Network.responseReceived", (evt: any) => {
    store.ress.push({
      label, id: evt.requestId, url: evt.response.url,
      status: evt.response.status, headers: evt.response.headers,
      mime: evt.response.mimeType, ts: new Date().toISOString(),
    });
    const url = evt.response.url;
    if (!url.includes("challenge-platform") && !url.includes("doubleclick") && !url.includes("google") && !url.includes("criteo") && !url.includes("openx") && !url.includes("gravatar"))
      log(`[${label}] ← ${evt.response.status} ${url.slice(0, 120)}`);
  });
  cdpClient.on("Network.loadingFinished", async (evt: any) => {
    try {
      const r = await cdpClient.send("Network.getResponseBody", { requestId: evt.requestId });
      store.bodies[evt.requestId] = r.body;
    } catch {}
  });
}

async function login(page: any) {
  log("Navigating to /login");
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCloudflare(page);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30_000 }).catch(() => {});
  await sleep(600);
  const emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) throw new Error("No email input");
  await emailEl.click({ clickCount: 3 });
  await emailEl.type(EMAIL, { delay: 55 });
  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("No pass input");
  await passEl.click({ clickCount: 3 });
  await passEl.type(PASSWORD, { delay: 55 });
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);
  await waitForCloudflare(page);
  log(`Logged in → ${page.url()}`);
}

async function main() {
  log("=== FULL LINKPAYS FLOW PROBE ===");
  const xvfb = await startXvfb();
  if (!process.env.DISPLAY) process.env.DISPLAY = DISPLAY_NUM;
  log(`DISPLAY=${process.env.DISPLAY} | chromium=${CHROMIUM_PATH} | snap=${IS_SNAP_CHROMIUM}`);

  let browser: any;
  const cleanup = () => { try { browser?.close(); } catch {} if (xvfb) xvfb.kill("SIGTERM"); };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const sandboxArgs = IS_SNAP_CHROMIUM ? [] : ["--no-sandbox", "--disable-setuid-sandbox"];
  const { browser: b, page: mainPage } = await connect({
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
  log("Browser launched.");

  const store = { reqs: [] as any[], ress: [] as any[], bodies: {} as Record<string,string> };

  const mainCDP = await mainPage.createCDPSession();
  await mainCDP.send("Network.enable");
  attachCDP(mainCDP, "MAIN", store);

  // Track new tabs
  const newTabPages: any[] = [];
  browser.on("targetcreated", async (target: any) => {
    const p = await target.page().catch(() => null);
    if (p && p !== mainPage) {
      log(`[NEW TAB] opened: ${target.url()}`);
      newTabPages.push(p);
      const c = await p.createCDPSession().catch(() => null);
      if (c) {
        await c.send("Network.enable").catch(() => {});
        attachCDP(c, "NEW_TAB", store);
      }
    }
  });

  // ── Inject fetch/XHR hooks ─────────────────────────────────────────────────
  await mainPage.evaluateOnNewDocument(() => {
    const w = globalThis as any;
    const origFetch = w.fetch;
    w.fetch = async function (...args: any[]) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] as any)?.url ?? "";
      const opts = args[1] ?? {};
      console.log("[FETCH] " + url + " body=" + JSON.stringify(opts.body ?? null).slice(0, 300));
      const res = await origFetch.apply(this, args);
      res.clone().text().then((t: string) => console.log("[FETCH:RES] " + url + " → " + t.slice(0, 600))).catch(() => {});
      return res;
    };
    const XHR = w.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (m: string, u: string, ...r: any[]) {
      (this as any)._url = u; (this as any)._m = m;
      return origOpen.apply(this, [m, u, ...r]);
    };
    XHR.prototype.send = function (body?: any) {
      const url = (this as any)._url ?? "";
      console.log("[XHR] " + (this as any)._m + " " + url + " body=" + JSON.stringify(body ?? null).slice(0, 300));
      (this as any).addEventListener("load", () => {
        console.log("[XHR:RES] " + url + " status=" + (this as any).status + " → " + (this as any).responseText.slice(0, 600));
      });
      return origSend.apply(this, [body]);
    };
  });

  // ── Step 1: Login ──────────────────────────────────────────────────────────
  await login(mainPage);
  if (!mainPage.url().includes("/earn")) {
    await mainPage.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCloudflare(mainPage);
  }

  // ── Step 2: Capture /earn page fully ──────────────────────────────────────
  log("=== CAPTURING /earn PAGE ===");
  const earnHtml = await mainPage.content();
  const earnScripts: any[] = await mainPage.evaluate(() => {
    return Array.from((globalThis as any).document.querySelectorAll("script")).map((s: any) => ({
      src: s.src || null,
      content: s.textContent || "",
    }));
  });

  // Dump timers/intervals from page
  const earnTimers = earnScripts
    .filter(s => !s.src)
    .map(s => s.content)
    .join("\n");

  // Get earn page buttons
  const earnButtons: string[] = await mainPage.evaluate(() => {
    return Array.from((globalThis as any).document.querySelectorAll("button, a.btn, input[type=submit]"))
      .map((el: any) => el.outerHTML);
  });

  // Get earn page localStorage/sessionStorage
  const earnStorage: any = await mainPage.evaluate(() => {
    const ls: Record<string,string> = {}, ss: Record<string,string> = {};
    for (let i=0;i<(globalThis as any).localStorage.length;i++){const k=(globalThis as any).localStorage.key(i)!;ls[k]=(globalThis as any).localStorage.getItem(k)??"";}
    for (let i=0;i<(globalThis as any).sessionStorage.length;i++){const k=(globalThis as any).sessionStorage.key(i)!;ss[k]=(globalThis as any).sessionStorage.getItem(k)??"";}
    return {ls,ss};
  });

  const earnCookies = await mainPage.cookies();

  // ── Step 3: Clear captured network data, then click LinkPays ──────────────
  log("Clearing network capture and clicking 'Open LinkPays'...");
  store.reqs.length = 0;
  store.ress.length = 0;
  Object.keys(store.bodies).forEach(k => delete store.bodies[k]);

  const linkpaysBtn = await mainPage.$('button.button-primary, button[type="submit"].button-primary');
  if (!linkpaysBtn) {
    log("WARNING: LinkPays button not found! Listing all buttons:");
    log(earnButtons.join("\n"));
  } else {
    const btnText: string = await mainPage.evaluate((el: any) => el.innerText, linkpaysBtn);
    log(`Clicking button: "${btnText.trim()}"`);
    await linkpaysBtn.click();
    log("Button clicked.");
  }

  // ── Step 4: Follow the flow for 30s, capturing everything ─────────────────
  log("Following flow for 30s...");
  for (let t = 0; t < 30; t += 3) {
    await sleep(3000);
    log(`[t+${t+3}s] main=${mainPage.url()}`);
    for (const p of newTabPages) {
      const u = await p.url().catch(() => "?");
      log(`  new tab: ${u}`);
    }
  }

  // ── Step 5: Get final state of all pages + their HTML ────────────────────
  log("Capturing final state of all pages...");
  const mainFinalUrl = mainPage.url();
  const mainFinalHtml = await mainPage.content().catch(() => "");
  const mainFinalTitle = await mainPage.title().catch(() => "");

  const tabData: any[] = [];
  for (const p of newTabPages) {
    const url = await p.url().catch(() => "?");
    const title = await p.title().catch(() => "?");
    const html = await p.content().catch(() => "");
    const scripts: any[] = await p.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("script")).map((s: any) => ({
        src: s.src || null, content: s.textContent || "",
      }))
    ).catch(() => []);
    const storage: any = await p.evaluate(() => {
      const ls: Record<string,string> = {}, ss: Record<string,string> = {};
      for (let i=0;i<(globalThis as any).localStorage.length;i++){const k=(globalThis as any).localStorage.key(i)!;ls[k]=(globalThis as any).localStorage.getItem(k)??"";}
      for (let i=0;i<(globalThis as any).sessionStorage.length;i++){const k=(globalThis as any).sessionStorage.key(i)!;ss[k]=(globalThis as any).sessionStorage.getItem(k)??"";}
      return {ls,ss};
    }).catch(() => ({}));
    const cookies = await p.cookies().catch(() => []);
    tabData.push({ url, title, html: html.slice(0, 6000), scripts, storage, cookies });
  }

  // ── PRINT FULL REPORT ──────────────────────────────────────────────────────
  console.log("\n\n" + SEP);
  console.log("FULL FLOW REPORT");
  console.log(SEP);

  // /earn page analysis
  console.log("\n" + DIV);
  console.log("/earn PAGE — FULL HTML (first 10000 chars)");
  console.log(DIV);
  console.log(earnHtml.slice(0, 10000));

  console.log("\n" + DIV);
  console.log("/earn PAGE — ALL INLINE SCRIPTS (cooldown logic, button enable, etc.)");
  console.log(DIV);
  for (const s of earnScripts) {
    if (!s.src && s.content.trim().length > 30) {
      console.log("--- INLINE SCRIPT ---");
      console.log(s.content);
      console.log("--- END ---");
    }
  }

  console.log("\n" + DIV);
  console.log("/earn PAGE — EXTERNAL SCRIPT URLS");
  console.log(DIV);
  for (const s of earnScripts) {
    if (s.src) console.log(s.src);
  }

  console.log("\n" + DIV);
  console.log("/earn PAGE — BUTTONS");
  console.log(DIV);
  console.log(earnButtons.join("\n"));

  console.log("\n" + DIV);
  console.log("/earn PAGE — STORAGE + COOKIES");
  console.log(DIV);
  console.log("localStorage:", JSON.stringify(earnStorage.ls, null, 2));
  console.log("sessionStorage:", JSON.stringify(earnStorage.ss, null, 2));
  console.log("cookies:", JSON.stringify(earnCookies, null, 2));

  // Network capture after button click
  console.log("\n" + DIV);
  console.log(`NETWORK AFTER BUTTON CLICK — ${store.reqs.length} requests`);
  console.log(DIV);

  for (const req of store.reqs) {
    const res = store.ress.find(r => r.id === req.id);
    const body = store.bodies[req.id];
    // Skip pure ad noise
    const adNoise = ["doubleclick", "googlesyndication", "google-analytics", "googletagmanager",
      "criteo", "openx", "gravatar", "cloudflareinsights", "fundingchoices", "adtrafficquality",
      ".png", ".jpg", ".gif", ".woff", ".css", "challenge-platform"];
    if (adNoise.some(n => req.url.includes(n))) continue;

    console.log("\n" + "·".repeat(60));
    console.log(`[${req.label}] ▶ ${req.method} ${req.url}`);
    console.log(`  Type: ${req.type} | Initiator: ${req.initiator}`);
    if (req.postData) console.log(`  POST body: ${req.postData}`);
    if (req.redirect) {
      console.log(`  ↪ Redirect from: ${req.redirect.url} [${req.redirect.status}]`);
      console.log(`    Headers: ${JSON.stringify(req.redirect.headers)}`);
    }
    console.log(`  Req headers: ${JSON.stringify(req.headers)}`);
    if (res) {
      console.log(`◀ ${res.status} ${res.mime}`);
      console.log(`  Res headers: ${JSON.stringify(res.headers)}`);
    }
    if (body && !body.includes("\x00")) {
      const preview = body.length > 4000 ? body.slice(0, 4000) + "\n...[truncated]" : body;
      console.log(`  Body:\n${preview}`);
    }
  }

  // Final state
  console.log("\n" + DIV);
  console.log("FINAL STATE — MAIN TAB");
  console.log(DIV);
  console.log(`URL   : ${mainFinalUrl}`);
  console.log(`Title : ${mainFinalTitle}`);
  console.log(`HTML (first 5000):\n${mainFinalHtml.slice(0, 5000)}`);

  for (let i = 0; i < tabData.length; i++) {
    const tab = tabData[i];
    console.log("\n" + DIV);
    console.log(`FINAL STATE — NEW TAB ${i + 1}`);
    console.log(DIV);
    console.log(`URL   : ${tab.url}`);
    console.log(`Title : ${tab.title}`);
    console.log("Cookies:", JSON.stringify(tab.cookies, null, 2));
    console.log("localStorage:", JSON.stringify(tab.storage.ls, null, 2));
    console.log("sessionStorage:", JSON.stringify(tab.storage.ss, null, 2));
    console.log("Inline scripts:");
    for (const s of tab.scripts) {
      if (!s.src && s.content.trim().length > 30) {
        console.log("--- INLINE SCRIPT ---");
        console.log(s.content.slice(0, 3000));
        console.log("--- END ---");
      }
    }
    console.log("External scripts:");
    for (const s of tab.scripts) {
      if (s.src) console.log(s.src);
    }
    console.log(`HTML (first 5000):\n${tab.html}`);
  }

  console.log("\n" + SEP);
  console.log("END OF FULL FLOW REPORT");
  console.log(SEP);

  log("Done.");
  cleanup();
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
