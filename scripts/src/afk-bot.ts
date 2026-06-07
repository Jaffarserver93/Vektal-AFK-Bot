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
const XVFB_PATH =
  process.env.XVFB_PATH ??
  "/usr/bin/Xvfb";
const DISPLAY_NUM = ":99";

// Snap Chromium must NOT receive --no-sandbox (it manages its own sandbox)
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

// LinkPays constants
const LP_MIN_WAIT_MS  = 248_000; // 248s > 240s minimum
const LP_COOLDOWN_MS  = 310_000; // 310s > 300s cooldown
const LP_MAX_DAILY    = 10;
const LP_COINS_EACH   = 12;

if (!EMAIL || !PASSWORD) {
  console.error("[AFK Bot] VEKTAL_EMAIL and VEKTAL_PASSWORD must be set");
  process.exit(1);
}

function log(msg: string) {
  console.log(`[AFK Bot ${new Date().toISOString()}] ${msg}`);
}
function lpLog(msg: string) {
  console.log(`[LinkPays ${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startXvfb(): Promise<ChildProcess | null> {
  // If DISPLAY is already set (e.g. by xvfb-run in start.sh), skip spawning
  if (process.env.DISPLAY) {
    log(`[Xvfb] DISPLAY already set to ${process.env.DISPLAY} — skipping internal Xvfb spawn.`);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    log(`[Xvfb] Spawning ${XVFB_PATH} on display ${DISPLAY_NUM}...`);
    const xvfb = spawn(
      XVFB_PATH,
      [DISPLAY_NUM, "-screen", "0", "1280x800x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );

    xvfb.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) log(`[Xvfb] ${line}`);
    });

    xvfb.on("error", (err) => {
      log(`[Xvfb] ERROR: ${err.message} — install with: sudo apt-get install -y xvfb`);
      reject(err);
    });

    setTimeout(() => {
      log("Xvfb started.");
      resolve(xvfb);
    }, 2000);
  });
}

async function waitForCF(page: any, timeoutMs = 120_000) {
  // Use waitForFunction so the check runs INSIDE the browser — no external
  // polling that could trigger Cloudflare's bot heuristics.
  log("[CF] Waiting for Cloudflare challenge to clear…");
  await page.waitForFunction(
    () =>
      !document.title.toLowerCase().includes("just a moment") &&
      !location.href.includes("challenge") &&
      !location.href.includes("cf-"),
    { timeout: timeoutMs, polling: 2000 },
  ).catch(() => {
    log("[CF] Warning: challenge did not clear within timeout.");
  });
  const title: string = await page.title().catch(() => "");
  if (!title.toLowerCase().includes("just a moment")) {
    log("[CF] Challenge cleared ✓");
  }
}

async function login(page: any) {
  log("Navigating to homepage to warm up Cloudflare trust…");
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForCF(page, 60_000);
  await sleep(2_000);

  log(`Navigating to ${SITE}/login`);
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);

  log("Looking for login form...");
  await page
    .waitForSelector('input[type="email"], input[name="email"], input[id="email"]', {
      timeout: 30_000,
    })
    .catch(() => log("Warning: email input wait timed out, trying anyway"));

  await sleep(800);

  const emailInput = await page.$(
    'input[type="email"], input[name="email"], input[id="email"]'
  );
  if (!emailInput) throw new Error("Could not find email input");
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(EMAIL, { delay: 60 });

  const passwordInput = await page.$(
    'input[type="password"], input[name="password"], input[id="password"]'
  );
  if (!passwordInput) throw new Error("Could not find password input");
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(PASSWORD, { delay: 60 });

  log("Submitting login form...");
  const [nav] = await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);

  if (nav.status === "rejected") {
    log(`Navigation after login: ${(nav as PromiseRejectedResult).reason}`);
  }

  await waitForCF(page);
  log(`After login — current URL: ${page.url()}`);
}

async function ensureOnEarnPage(page: any) {
  const url: string = page.url();
  if (!url.includes("/earn")) {
    log(`Not on /earn (at ${url}), navigating...`);
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(page);
    log(`Now at: ${page.url()}`);
  } else {
    log(`On earn page: ${url}`);
  }
}

// ── AFK keep-alive loop (main tab) ─────────────────────────────────────────
async function keepAlive(page: any) {
  let tick = 0;
  while (true) {
    tick++;
    try {
      const url: string = page.url();

      if (url.includes("/login") || url.includes("/signin")) {
        log("Session expired — re-logging in...");
        await login(page);
        await ensureOnEarnPage(page);
        continue;
      }

      await ensureOnEarnPage(page);

      const title: string = await page.title().catch(() => "unknown");
      log(`[tick ${tick}] alive — title: "${title}" | url: ${page.url()}`);

      await page.evaluate(() => {
        const evt = new (globalThis as any).MouseEvent("mousemove", { bubbles: true, clientX: 640, clientY: 400 });
        (globalThis as any).document?.dispatchEvent(evt);
      });

      const cookies = await page.cookies().catch(() => [] as any[]);
      log(`[tick ${tick}] session cookies: ${cookies.length}`);
      // Share cookies with the runner so it can bypass CF on restart
      if (cookies.length > 0) {
        try { writeFileSync("/tmp/vektal-cookies.json", JSON.stringify(cookies)); } catch {}
      }
    } catch (err: any) {
      log(`[tick ${tick}] Error during keep-alive: ${err.message}`);
    }

    await sleep(30_000);
  }
}

// ── LinkPays helpers ────────────────────────────────────────────────────────
async function lpGetCoins(page: any): Promise<number> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    // Find all list-row elements containing "Coin balance" label
    const rows = Array.from(doc.querySelectorAll(".list-row"));
    for (const row of rows as any[]) {
      const spans = row.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent?.includes("Coin balance")) {
          const strong = row.querySelector("strong");
          if (strong) {
            const n = parseInt(strong.textContent?.replace(/,/g, "") ?? "", 10);
            if (!isNaN(n)) return n;
          }
        }
      }
    }
    // Fallback: first strong > 0 in info-stack
    const strongs = Array.from(doc.querySelectorAll(".info-stack strong")) as any[];
    for (const s of strongs) {
      const n = parseInt(s.textContent?.replace(/,/g, "") ?? "", 10);
      if (!isNaN(n) && n >= 0) return n;
    }
    return -1;
  }).catch(() => -1);
}

async function lpGetCsrf(page: any): Promise<string> {
  const csrf: string = await page.evaluate(() => {
    const el =
      (globalThis as any).document.querySelector('input[name="_csrf"]') ??
      (globalThis as any).document.querySelector('meta[name="csrf-token"]');
    return el ? (el.value ?? el.getAttribute("content") ?? "") : "";
  }).catch(() => "");
  return csrf;
}

interface LPStatus {
  available: boolean;
  cooldownSec: number;
  usage: string;
  flashMsg: string;
}

async function lpGetStatus(page: any): Promise<LPStatus> {
  return page.evaluate(() => {
    const btn = (globalThis as any).document.querySelector('button[type="submit"].button-primary');
    const available = !!btn && !btn.disabled;

    let cooldownSec = 0;
    const timer = (globalThis as any).document.querySelector("[data-expire-seconds]");
    if (timer) {
      const val = parseInt(timer.getAttribute("data-expire-seconds") ?? "0", 10);
      if (!isNaN(val) && val > 0) cooldownSec = val;
    }

    let usage = "";
    const usageEl = (globalThis as any).document.querySelector("[data-lp-usage], .lp-usage");
    if (usageEl) usage = usageEl.textContent?.trim() ?? "";

    let flashMsg = "";
    const flash = (globalThis as any).document.querySelector(".alert, .flash, [role='alert']");
    if (flash) flashMsg = flash.textContent?.trim() ?? "";

    return { available, cooldownSec, usage, flashMsg } as any;
  }).catch(() => ({ available: false, cooldownSec: 0, usage: "", flashMsg: "" }));
}

// Attach CDP network tracking to a page
async function attachNetTracking(page: any, label: string, store: {
  reqs: any[]; ress: any[]; bodies: Record<string, string>;
}) {
  const cdp = await page.createCDPSession().catch(() => null);
  if (!cdp) return cdp;
  await cdp.send("Network.enable").catch(() => {});

  const noise = ["challenge-platform", "googlesyndication", "doubleclick", "gravatar",
    "criteo", "openx", ".png", ".jpg", ".woff", "fonts.g", "cloudflareinsights",
    "google-analytics", "googletagmanager", "fundingchoices", "adtrafficquality",
    "challenges.cloudflare"];

  cdp.on("Network.requestWillBeSent", (e: any) => {
    const url: string = e.request.url;
    if (!noise.some(n => url.includes(n)))
      lpLog(`[${label}] → ${e.request.method} ${url.slice(0, 120)}`);
    store.reqs.push({ id: e.requestId, url, method: e.request.method, postData: e.request.postData ?? null, ts: Date.now() });
  });
  cdp.on("Network.responseReceived", (e: any) => {
    const url: string = e.response.url;
    if (!noise.some(n => url.includes(n)))
      lpLog(`[${label}] ← ${e.response.status} ${url.slice(0, 120)}`);
    store.ress.push({ id: e.requestId, url, status: e.response.status, headers: e.response.headers });
  });
  cdp.on("Network.loadingFinished", async (e: any) => {
    try {
      const r = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
      store.bodies[e.requestId] = r.body;
    } catch {}
  });
  return cdp;
}

// Find the proceed() redirect target from linkpays.in HTML/scripts
async function lpExtractProceedTarget(page: any): Promise<string> {
  return page.evaluate(() => {
    const scripts = Array.from((globalThis as any).document.querySelectorAll("script"));
    for (const s of scripts as any[]) {
      const txt = s.textContent ?? s.innerHTML ?? "";
      const m = txt.match(/atob\s*\(\s*["'`]([A-Za-z0-9+/=]+)["'`]\s*\)/);
      if (m) {
        try { return atob(m[1]); } catch {}
      }
    }
    // Also check window variables
    const w = globalThis as any;
    for (const k of Object.keys(w)) {
      try {
        const v = w[k];
        if (typeof v === "string" && (v.startsWith("https://") || v.startsWith("http://"))) {
          if (v.includes("rank1st") || v.includes("evspec") || v.includes("vektalnodes"))
            return v;
        }
      } catch {}
    }
    return "";
  }).catch(() => "");
}

// Find the vektalnodes.in return URL inside the ad site HTML/network
function lpFindReturnUrl(store: { reqs: any[]; ress: any[]; bodies: Record<string, string> }): string {
  // Check all requests for vektalnodes redirect
  for (const req of store.reqs) {
    if (req.url.includes("vektalnodes.in") && (req.url.includes("/earn") || req.url.includes("/return") || req.url.includes("/credit") || req.url.includes("/callback") || req.url.includes("/complete"))) {
      return req.url;
    }
  }
  // Check all response bodies for vektalnodes.in links
  for (const [, body] of Object.entries(store.bodies)) {
    if (!body) continue;
    const matches = body.matchAll(/https?:\/\/vektalnodes\.in[^\s"'<>]*/g);
    for (const m of matches) {
      const url = m[0].replace(/\\u0026/g, "&").replace(/\\"/g, "").replace(/['"<>]/g, "").trim();
      if (url.includes("/earn") || url.includes("/return") || url.includes("/credit") || url.includes("/callback") || url.includes("/complete") || url.includes("token") || url.includes("session")) {
        return url;
      }
    }
  }
  return "";
}

// ── LinkPays earn cycle (runs on a dedicated second tab) ────────────────────
async function linkpaysLoop(browser: any) {
  lpLog("LinkPays loop starting. Opening dedicated tab...");
  await sleep(10_000); // Let main tab login/stabilize first

  let lpPage: any = null;
  let dailyCount = 0;
  let dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;

  const openLpTab = async () => {
    try { await lpPage?.close(); } catch {}
    lpPage = await browser.newPage();
    // Give it the same viewport
    await lpPage.setViewport({ width: 1280, height: 800 }).catch(() => {});
    lpLog("New tab opened for LinkPays.");
  };

  while (true) {
    // Reset daily counter
    if (Date.now() >= dailyResetAt) {
      lpLog("24h reset — clearing daily counter.");
      dailyCount = 0;
      dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
    }

    if (dailyCount >= LP_MAX_DAILY) {
      const waitMs = dailyResetAt - Date.now();
      lpLog(`Daily limit (${LP_MAX_DAILY}) reached. Waiting ${Math.round(waitMs / 60000)}m for reset...`);
      await sleep(waitMs + 5000);
      dailyCount = 0;
      dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
      continue;
    }

    try {
      await openLpTab();

      // ── Navigate to /earn ──────────────────────────────────────────────
      lpLog("Navigating to /earn...");
      await lpPage.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForCF(lpPage);
      await sleep(1500);

      // Check if redirected to login
      if (lpPage.url().includes("/login")) {
        lpLog("Redirected to login on LP tab — waiting for main tab to re-auth...");
        await sleep(60_000);
        continue;
      }

      const coinsBefore = await lpGetCoins(lpPage);
      const status = await lpGetStatus(lpPage);
      lpLog(`Coins: ${coinsBefore} | LP available: ${status.available} | cooldown: ${status.cooldownSec}s | flash: "${status.flashMsg}"`);

      if (!status.available) {
        if (status.cooldownSec > 0) {
          lpLog(`Cooldown active: ${status.cooldownSec}s. Waiting...`);
          await sleep((status.cooldownSec + 10) * 1000);
          continue;
        }
        // May have hit daily limit via server, wait before retry
        lpLog("LP button not available (no cooldown). Waiting 10m...");
        await sleep(10 * 60 * 1000);
        continue;
      }

      // ── Get CSRF & click button ───────────────────────────────────────
      const csrf = await lpGetCsrf(lpPage);
      if (!csrf) {
        lpLog("No CSRF token found on /earn — retrying in 30s...");
        await sleep(30_000);
        continue;
      }

      const store: { reqs: any[]; ress: any[]; bodies: Record<string, string> } = { reqs: [], ress: [], bodies: {} };
      await attachNetTracking(lpPage, "LP-TAB", store);

      lpLog("Clicking LinkPays button...");
      const btn = await lpPage.$('button[type="submit"].button-primary');
      if (!btn) {
        lpLog("LP button disappeared — retrying in 30s...");
        await sleep(30_000);
        continue;
      }
      await btn.click();

      // ── Wait for redirect to linkpays.in ──────────────────────────────
      lpLog("Waiting for redirect to linkpays.in...");
      let onLinkpays = false;
      for (let i = 0; i < 25; i++) {
        await sleep(800);
        const u: string = lpPage.url();
        if (u.includes("linkpays.in")) { onLinkpays = true; lpLog(`→ linkpays.in: ${u}`); break; }
      }
      if (!onLinkpays) {
        lpLog(`WARNING: Did not reach linkpays.in. Current URL: ${lpPage.url()}`);
        // May have gotten flash message — check for cooldown
        const s2 = await lpGetStatus(lpPage);
        if (s2.cooldownSec > 0) {
          lpLog(`Flash: "${s2.flashMsg}" — cooldown: ${s2.cooldownSec}s`);
          await sleep((s2.cooldownSec + 10) * 1000);
          continue;
        }
        await sleep(60_000);
        continue;
      }

      // ── Capture linkpays.in HTML + extract proceed() target ───────────
      const lpUrl: string = lpPage.url();
      const lpHtml: string = await lpPage.content().catch(() => "");
      writeFileSync("/tmp/lp-linkpays-page.html", lpHtml, "utf8");
      lpLog(`linkpays.in page captured (${lpHtml.length} chars)`);

      // Extract the base64-encoded redirect target
      const adSiteUrl = await lpExtractProceedTarget(lpPage);
      lpLog(`proceed() target: "${adSiteUrl}"`);

      // ── Call proceed() via JS (sets user_verified=true cookie + redirect) ─
      lpLog("Calling proceed() on linkpays.in...");
      const proceedResult: string = await lpPage.evaluate(() => {
        const w = globalThis as any;
        if (typeof w.proceed === "function") {
          try { w.proceed(); return "called"; } catch (e: any) { return `error: ${e.message}`; }
        }
        // Fallback: simulate the proceed flow manually
        const scripts = Array.from(w.document.querySelectorAll("script"));
        for (const s of scripts as any[]) {
          const txt = s.textContent ?? "";
          if (txt.includes("user_verified") || txt.includes("proceed")) {
            // Try to extract and call the proceed logic
            const setCookieMatch = txt.match(/document\.cookie\s*=\s*["'`]([^"'`]+)["'`]/);
            if (setCookieMatch) {
              try { eval(setCookieMatch[0]); } catch {}
            }
          }
        }
        // Set user_verified cookie directly
        w.document.cookie = "user_verified=true; path=/; domain=linkpays.in";
        return "cookie-set-fallback";
      }).catch((e: any) => `evaluate-error: ${e.message}`);
      lpLog(`proceed() result: ${proceedResult}`);

      // Wait for redirect to ad site (proceed() has 3.5s delay)
      lpLog("Waiting 5s for ad site redirect...");
      await sleep(5000);

      let adUrl: string = lpPage.url();
      lpLog(`After proceed() URL: ${adUrl}`);

      // If still on linkpays.in, navigate manually to adSiteUrl
      if (adUrl.includes("linkpays.in") && adSiteUrl) {
        lpLog(`Navigating manually to ad site: ${adSiteUrl}`);
        await lpPage.goto(adSiteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        adUrl = lpPage.url();
        lpLog(`Ad site URL after manual nav: ${adUrl}`);
      }

      // ── Capture ad site ───────────────────────────────────────────────
      const adHtml: string = await lpPage.content().catch(() => "");
      writeFileSync("/tmp/lp-ad-site.html", adHtml, "utf8");
      lpLog(`Ad site captured: ${adUrl} (${adHtml.length} chars)`);

      // Find return URL in network captures
      const returnUrl = lpFindReturnUrl(store);
      lpLog(`Return URL from network: "${returnUrl}"`);

      // Also scan ad site HTML for vektalnodes links
      const htmlReturnMatch = adHtml.match(/https?:\/\/vektalnodes\.in[^\s"'<>]*/g);
      if (htmlReturnMatch) {
        lpLog(`vektalnodes.in URLs in ad HTML: ${htmlReturnMatch.slice(0, 5).join(", ")}`);
      }

      // ── Wait the minimum time (240s) ──────────────────────────────────
      const elapsed = Date.now() - Date.now(); // will recalculate below
      const clickTs = Date.now();
      lpLog(`Waiting ${LP_MIN_WAIT_MS / 1000}s minimum earn time...`);

      // While waiting, keep monitoring for any automatic redirect back to vektalnodes
      let autoReturned = false;
      const waitEnd = clickTs + LP_MIN_WAIT_MS;
      while (Date.now() < waitEnd) {
        await sleep(10_000);
        const curUrl: string = lpPage.url();
        if (curUrl.includes("vektalnodes.in")) {
          lpLog(`Auto-redirected back to vektalnodes.in: ${curUrl}`);
          autoReturned = true;
          break;
        }
        const remaining = Math.round((waitEnd - Date.now()) / 1000);
        if (remaining > 0) lpLog(`Still waiting... ${remaining}s remaining. Current: ${curUrl}`);
      }

      // ── Navigate back to /earn to trigger credit ───────────────────────
      if (!autoReturned) {
        // Try return URL first if found
        if (returnUrl) {
          lpLog(`Navigating to return URL: ${returnUrl}`);
          await lpPage.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
          await sleep(2000);
          const afterReturn: string = lpPage.url();
          lpLog(`After return URL: ${afterReturn}`);
        }

        // Navigate to /earn
        lpLog("Navigating to /earn for coin credit...");
        await lpPage.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForCF(lpPage);
      }

      await sleep(2000);

      // ── Check credit ──────────────────────────────────────────────────
      const coinsAfter = await lpGetCoins(lpPage);
      const statusAfter = await lpGetStatus(lpPage);
      const earnHtml = await lpPage.content().catch(() => "");
      writeFileSync("/tmp/lp-earn-after.html", earnHtml, "utf8");

      lpLog(`Coins BEFORE: ${coinsBefore} | AFTER: ${coinsAfter} | Diff: +${coinsAfter - coinsBefore}`);
      lpLog(`Flash: "${statusAfter.flashMsg}" | cooldown: ${statusAfter.cooldownSec}s`);

      const credited = coinsAfter > coinsBefore;
      if (credited) {
        dailyCount++;
        lpLog(`✅ Cycle SUCCESS — earned ${coinsAfter - coinsBefore} coins (${coinsBefore} → ${coinsAfter}) | daily: ${dailyCount}/${LP_MAX_DAILY}`);
      } else {
        lpLog(`❌ No credit. Flash: "${statusAfter.flashMsg}" | cooldown: ${statusAfter.cooldownSec}s`);
        // Dump partial HTML context for debugging
        const flashMatch = earnHtml.match(/<[^>]*(?:alert|flash)[^>]*>[\s\S]{0,300}/i);
        if (flashMatch) lpLog(`Earn page alert: ${flashMatch[0]}`);
      }

      // ── Wait cooldown ─────────────────────────────────────────────────
      const cdWait = statusAfter.cooldownSec > 0
        ? (statusAfter.cooldownSec + 15) * 1000
        : LP_COOLDOWN_MS;
      lpLog(`Waiting cooldown: ${Math.round(cdWait / 1000)}s...`);
      await sleep(cdWait);

    } catch (err: any) {
      lpLog(`Error in LP cycle: ${err.message}`);
      try { await lpPage?.close(); } catch {}
      lpPage = null;
      await sleep(60_000); // back off on errors
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log("Starting AFK bot with puppeteer-real-browser...");

  const xvfb = await startXvfb();
  if (!process.env.DISPLAY) {
    process.env.DISPLAY = DISPLAY_NUM;
  }
  log(`DISPLAY=${process.env.DISPLAY} | chromium=${CHROMIUM_PATH} | snap=${IS_SNAP_CHROMIUM}`);

  let browser: any;

  const cleanup = async (signal: string) => {
    log(`${signal} received — shutting down...`);
    try { await browser?.close(); } catch {}
    if (xvfb) xvfb.kill("SIGTERM");
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  try {
    log(`Launching browser… (chromium: ${CHROMIUM_PATH}, snap: ${IS_SNAP_CHROMIUM}, display: ${process.env.DISPLAY ?? "not set"})`);

    const sandboxArgs = IS_SNAP_CHROMIUM
      ? []
      : ["--no-sandbox", "--disable-setuid-sandbox"];

    const result = await connect({
      headless: false,
      args: [
        ...sandboxArgs,
        "--disable-dev-shm-usage",
        "--window-size=1280,900",
      ],
      customConfig: {
        chromePath: CHROMIUM_PATH,
      },
      turnstile: true,
      connectOption: {
        defaultViewport: { width: 1280, height: 800 },
      },
    } as any);

    browser = result.browser;
    const page = result.page;

    log("Browser launched successfully.");

    await login(page);
    await ensureOnEarnPage(page);

    // Run LinkPays loop in parallel with keepAlive (independent — errors don't crash bot)
    linkpaysLoop(browser).catch((err: any) => {
      lpLog(`LinkPays loop crashed: ${err.message}. Restarting in 2m...`);
      setTimeout(() => linkpaysLoop(browser).catch(() => {}), 120_000);
    });

    await keepAlive(page);
  } catch (err: any) {
    log(`Fatal error: ${err.message}`);
    try { await browser?.close(); } catch {}
    if (xvfb) xvfb.kill("SIGTERM");
    process.exit(1);
  }
}

main();
