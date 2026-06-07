/**
 * linkpays-runner.ts
 *
 * Automates the exact LinkPays earn flow described manually:
 *
 *   /earn  → click LinkPays button
 *   → linkpays.in/VEKTALNODES_COINS            click "Continue to next step"
 *   → rank1st.in/?link=VEKTALNODES_COINS       wait 15s, I-am-not-robot, scroll, Verify, Continue
 *   → rank1st.in/<article>                     same
 *   → savepe.in/<article-1>                    same
 *   → savepe.in/<article-2>                    same
 *   → bookyourhotel.in/?link=VEKTALNODES_COINS wait 30s, Get Link
 *   → linkpays.in/VEKTALNODES_COINS            → vektalnodes.in/earn  ✅
 *
 * Loops every COOLDOWN_MS (310s) up to MAX_DAILY_USES per day.
 */

import { connect } from "puppeteer-real-browser";
import { spawn, execSync, type ChildProcess } from "child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";

const SITE         = "https://vektalnodes.in";
const EMAIL        = process.env.VEKTAL_EMAIL    ?? "";
const PASSWORD     = process.env.VEKTAL_PASSWORD ?? "";
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
const DISPLAY_NUM     = ":94";

// Detect snap Chromium — snap packages must NOT receive --no-sandbox
const IS_SNAP_CHROMIUM =
  process.env.IS_SNAP_CHROMIUM === "true" ||
  CHROMIUM_PATH.includes("/snap/") ||
  (() => {
    try {
      // Check if symlink resolves to snap
      const resolved = execSync(`readlink -f "${CHROMIUM_PATH}" 2>/dev/null || echo ""`).toString().trim();
      if (resolved.includes("/snap/")) return true;
      // Ubuntu 22.04+: /usr/bin/chromium-browser is a shell script wrapper — read it
      const head = execSync(`head -5 "${CHROMIUM_PATH}" 2>/dev/null || echo ""`).toString();
      return head.includes("/snap/");
    } catch { return false; }
  })();
const COOLDOWN_MS     = 310_000; // 310s > 300s server cooldown
const MAX_DAILY_USES  = 10;
const LOG_FILE        = "/tmp/linkpays-runner.log";
const COOKIE_FILE     = "/tmp/vektal-cookies.json";

if (!EMAIL || !PASSWORD) {
  console.error("[runner] VEKTAL_EMAIL and VEKTAL_PASSWORD must be set");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts()       { return new Date().toISOString(); }
function log(msg: string) {
  const line = `[runner ${ts()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Cookie persistence (avoids CF challenge on every browser restart) ─────────

async function saveCookies(page: any) {
  try {
    const cookies = await page.cookies();
    writeFileSync(COOKIE_FILE, JSON.stringify(cookies));
    log(`[cookies] Saved ${cookies.length} cookies.`);
  } catch (err: any) {
    log(`[cookies] Save failed: ${err?.message}`);
  }
}

async function tryRestoreSession(page: any): Promise<boolean> {
  try {
    if (!existsSync(COOKIE_FILE)) return false;
    const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await page.setCookie(...cookies);
    log(`[cookies] Restored ${cookies.length} cookies — navigating to /earn…`);
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Give CF a short window — valid session cookies usually bypass it quickly
    await waitForCF(page, 30_000);
    const url: string   = page.url();
    const title: string = await page.title().catch(() => "");
    if (!url.includes("/login") && title.toLowerCase().includes("earn")) {
      log("[cookies] Session restored — skipping login ✓");
      return true;
    }
    log(`[cookies] Session expired (url: ${url}) — falling back to fresh login.`);
    return false;
  } catch (err: any) {
    log(`[cookies] Restore failed: ${err?.message} — falling back to fresh login.`);
    return false;
  }
}

function startXvfb(): Promise<ChildProcess | null> {
  // If DISPLAY is already set (e.g. by xvfb-run in start.sh), skip spawning
  if (process.env.DISPLAY) {
    log(`[Xvfb] DISPLAY already set to ${process.env.DISPLAY} — skipping internal Xvfb spawn.`);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    log(`[Xvfb] Spawning ${XVFB_PATH} on display ${DISPLAY_NUM}…`);
    const xvfb = spawn(
      XVFB_PATH,
      [DISPLAY_NUM, "-screen", "0", "1280x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
    xvfb.stderr?.on("data", (d: Buffer) => {
      const l = d.toString().trim();
      if (l) log(`[Xvfb] ${l}`);
    });
    xvfb.on("error", (err) => {
      log(`[Xvfb] ERROR: ${err.message} — if this is Ubuntu, ensure xvfb is installed: sudo apt-get install -y xvfb`);
      reject(err);
    });
    setTimeout(() => resolve(xvfb), 2000);
  });
}

async function waitForCF(page: any, ms = 120_000) {
  // Use waitForFunction so the check runs INSIDE the browser — no external
  // polling that could trigger Cloudflare's bot heuristics.
  // puppeteer-real-browser with turnstile:true handles the JS challenge automatically.
  log("[CF] Waiting for Cloudflare challenge to clear…");
  await page.waitForFunction(
    () =>
      !document.title.toLowerCase().includes("just a moment") &&
      !location.href.includes("/cdn-cgi/challenge"),
    { timeout: ms, polling: 2000 },
  ).catch(() => {
    log("[CF] Warning: challenge did not clear within timeout — continuing anyway.");
  });
  const title: string = await page.title().catch(() => "");
  if (!title.toLowerCase().includes("just a moment")) {
    log("[CF] Challenge cleared ✓");
  }
}

/**
 * Wait until the page URL contains one of the given substrings.
 * Returns the matched URL or throws on timeout.
 */
async function waitForUrl(
  page: any,
  matches: string[],
  timeoutMs = 60_000,
  label = "",
): Promise<string> {
  const dl = Date.now() + timeoutMs;
  let prev = "";
  while (Date.now() < dl) {
    const u: string = page.url();
    if (u !== prev) { log(`${label ? "[" + label + "] " : ""}URL → ${u}`); prev = u; }
    if (matches.some(m => u.includes(m))) return u;
    await sleep(800);
  }
  throw new Error(`Timeout waiting for URL matching [${matches.join(", ")}]. Current: ${page.url()}`);
}

/** Try to read a visible countdown on the page (returns seconds remaining, or 0). */
async function readCountdown(page: any): Promise<number> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    // Common selector patterns used by shortlink/ad sites
    const candidates = [
      doc.querySelector("#timer"),
      doc.querySelector("#countdown"),
      doc.querySelector(".timer"),
      doc.querySelector(".countdown"),
      doc.querySelector("[id*='timer']"),
      doc.querySelector("[id*='count']"),
      doc.querySelector("[class*='timer']"),
      doc.querySelector("[class*='count']"),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const txt = el.innerText?.trim() ?? "";
      const n = parseInt(txt, 10);
      if (!isNaN(n) && n >= 0) return n;
    }
    return 0;
  }).catch(() => 0);
}

/**
 * Wait until the countdown on the page reaches 0 (or disappears).
 * Polls every second, logs ticks every 5s.
 * Also enforces a minimum floor wait so the ad server registers a real visit.
 */
async function waitForCountdown(page: any, maxWaitMs = 45_000, label = "", minWaitMs = 15_000) {
  const prefix = label ? `[${label}] ` : "";
  // Brief pause so page JS can initialize the timer before we first read it
  await sleep(1500);

  const dl = Date.now() + maxWaitMs;
  const minDeadline = Date.now() + minWaitMs;
  let last = -1;
  let seen = false; // whether we ever saw a non-zero countdown
  while (Date.now() < dl) {
    const secs = await readCountdown(page);
    if (secs !== last) { log(`${prefix}Countdown: ${secs}s`); last = secs; }
    if (secs > 0) seen = true;
    if (secs <= 0 && Date.now() >= minDeadline) return;
    await sleep(1000);
  }
  if (!seen) log(`${prefix}Countdown never started — used minimum ${minWaitMs / 1000}s floor.`);
  log(`${prefix}Countdown wait done.`);
}

/**
 * Click the first visible element matching any of the CSS selectors or
 * (case-insensitive) text substrings. Returns true if something was clicked.
 */
async function clickButton(
  page: any,
  selectors: string[],
  textMatches: string[],
  label = "",
): Promise<boolean> {
  return page.evaluate(
    (sels: string[], texts: string[]) => {
      const doc = (globalThis as any).document;

      // Try explicit selectors first
      for (const sel of sels) {
        try {
          const el: any = doc.querySelector(sel);
          if (el && !el.disabled) { el.click(); return true; }
        } catch {}
      }

      // Fallback: scan all clickable elements for matching text
      const clickables = Array.from(
        doc.querySelectorAll("button, a, input[type=submit], input[type=button], [role=button]"),
      );
      for (const el of clickables as any[]) {
        const text = (el.innerText || el.value || "").toLowerCase();
        if (texts.some(t => text.includes(t.toLowerCase()))) {
          if (!el.disabled) { el.click(); return true; }
        }
      }
      return false;
    },
    selectors,
    textMatches,
  ).catch(() => false);
}

/**
 * Scroll the page to the bottom (reveals hidden buttons on shortlink pages).
 */
async function scrollToBottom(page: any) {
  await page.evaluate(() => {
    (globalThis as any).window.scrollTo(0, (globalThis as any).document.body.scrollHeight);
  }).catch(() => {});
  await sleep(600);
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function login(page: any) {
  log("Navigating to homepage to warm up Cloudflare trust…");
  // Visit the homepage first — CF evaluates a benign page before the login page.
  // This significantly increases the chance of passing the managed JS challenge.
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitForCF(page, 60_000);
  await sleep(2_000);

  log("Navigating to /login…");
  // Retry up to 3 times — Render's cold-start network can be slow on first request
  let navOk = false;
  for (let attempt = 1; attempt <= 3 && !navOk; attempt++) {
    try {
      await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      navOk = true;
    } catch (err: any) {
      log(`Login nav attempt ${attempt} failed: ${err?.message ?? err}. Retrying…`);
      await sleep(5_000);
    }
  }
  if (!navOk) throw new Error("Login page navigation failed after 3 attempts");

  await waitForCF(page);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30_000 }).catch(() => {});
  await sleep(600);

  let emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) {
    log("Email input not found — reloading…");
    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await waitForCF(page);
    await sleep(800);
    emailEl = await page.$('input[type="email"], input[name="email"]');
  }
  if (!emailEl) throw new Error("No email input on login page");

  await emailEl.click({ clickCount: 3 });
  await emailEl.type(EMAIL, { delay: 55 });

  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("No password input on login page");
  await passEl.click({ clickCount: 3 });
  await passEl.type(PASSWORD, { delay: 55 });

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);
  await waitForCF(page);

  const afterUrl: string = page.url();
  log(`After login → ${afterUrl}`);
  if (afterUrl.includes("/login")) {
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForCF(page);
    if (page.url().includes("/login")) throw new Error("Login failed — still on /login");
  }
  log("Logged in ✓");
}

// ─── Earn page helpers ────────────────────────────────────────────────────────

async function getCoins(page: any): Promise<number> {
  const text: string = await page.evaluate(() => {
    const el = (globalThis as any).document.querySelector(".topbar-pill strong");
    return el ? el.innerText.trim() : "0";
  }).catch(() => "0");
  return parseInt(text, 10) || 0;
}

async function getLinkPaysStatus(page: any): Promise<{
  available: boolean;
  cooldownSec: number;
  flashMsg: string;
  usageToday: number;      // X from "24h usage: X / 10"
  usageMax: number;        // Y from "24h usage: X / Y"
  msUntilNextSlot: number; // parsed from "Next slot opens in Xh Xm" — 0 if slots available now
}> {
  // NOTE: Do NOT define named `const fn = () => {}` inside page.evaluate() — esbuild (used
  // by tsx) injects `__name(fn,"fn")` for every named binding, and __name is not available
  // in the browser context that Puppeteer serialises the callback into.
  // All helpers here are inlined as plain expressions to avoid that.
  return page.evaluate(() => {
    const doc = (globalThis as any).document;

    // Flash/alert message
    const flashEl = doc.querySelector(".alert, .flash, [role='alert'], .notice");
    const flashMsg: string = flashEl
      ? ((flashEl.textContent ?? flashEl.innerText ?? "") as string).trim()
      : "";

    // Find the LinkPays offer card — check every article.offer-card for "linkpays" text
    const cards: any[] = Array.from(doc.querySelectorAll("article.offer-card"));
    let lpCard: any = null;
    for (let ci = 0; ci < cards.length; ci++) {
      const c = cards[ci];
      // Check heading/eyebrow elements
      const heads: any[] = Array.from(c.querySelectorAll("h2,h3,h4,p.eyebrow,.eyebrow"));
      let match = false;
      for (let hi = 0; hi < heads.length; hi++) {
        const t = ((heads[hi].textContent ?? heads[hi].innerText ?? "") as string)
                    .trim().toLowerCase();
        if (t.includes("linkpays")) { match = true; break; }
      }
      if (!match) {
        // Wider fallback: any text in the card
        const full = ((c.textContent ?? c.innerText ?? "") as string).toLowerCase();
        match = full.includes("linkpays");
      }
      if (match) { lpCard = c; break; }
    }

    if (!lpCard) {
      // No LP card found — return unavailable with safe defaults
      const anyBtn = doc.querySelector('button.button-primary[type="submit"]');
      return { available: false, cooldownSec: 0, flashMsg,
               usageToday: 0, usageMax: 10, msUntilNextSlot: 0,
               _dbg: `no-lp-card|total-cards:${cards.length}` };
    }

    // Button availability
    const btn: any = lpCard.querySelector("button.button-primary[type='submit']")
                  ?? lpCard.querySelector("button[type='submit']");
    const available = !!btn && !btn.disabled;

    // Parse all .status-pill texts first — used for cooldown, usage, and next-slot
    let usageToday = 0;
    let usageMax   = 10;
    let cooldownSec = 0;
    const pillEls: any[] = Array.from(lpCard.querySelectorAll(".status-pill"));
    let pillTexts = "";
    for (let pi = 0; pi < pillEls.length; pi++) {
      const t = ((pillEls[pi].textContent ?? pillEls[pi].innerText ?? "") as string).trim();
      pillTexts += (pi ? "|" : "") + t;
      // "24h usage: X / Y"
      const mu = t.match(/24h usage:\s*(\d+)\s*\/\s*(\d+)/i);
      if (mu) { usageToday = parseInt(mu[1]); usageMax = parseInt(mu[2]); }
      // "Cooldown: Xs" or "Cooldown: Xm Ys"
      const mc = t.match(/^cooldown:\s*(\d+)s$/i);
      if (mc) cooldownSec = parseInt(mc[1]);
    }
    // Also check data-expire-seconds attribute as fallback
    if (!cooldownSec) {
      const expireEl: any = lpCard.querySelector("[data-expire-seconds]");
      if (expireEl) {
        const v = parseInt(expireEl.getAttribute("data-expire-seconds") ?? "0", 10);
        if (v > 0) cooldownSec = v;
      }
    }

    // Parse "Next slot opens in Xh Xm" from pills or paragraphs
    let msUntilNextSlot = 0;
    // Combine pill and paragraph text for the search
    const paraEls: any[] = Array.from(lpCard.querySelectorAll("p"));
    const allTexts: string[] = [];
    for (let pi = 0; pi < pillEls.length; pi++) {
      allTexts.push(((pillEls[pi].textContent ?? "") as string).trim());
    }
    for (let pi = 0; pi < paraEls.length; pi++) {
      allTexts.push(((paraEls[pi].textContent ?? "") as string).trim());
    }
    for (let ti = 0; ti < allTexts.length; ti++) {
      const t = allTexts[ti];
      if (t.toLowerCase().includes("next slot") || t.toLowerCase().includes("slot opens")) {
        // Inline time parse: "Xh Ym", "Xh", "Ym"
        const hm = t.match(/(\d+)h\s*(\d+)m/);
        if (hm) { msUntilNextSlot = (parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60) * 1000; break; }
        const ho = t.match(/(\d+)\s*h/);
        if (ho) { msUntilNextSlot = parseInt(ho[1]) * 3600000; break; }
        const mo = t.match(/(\d+)\s*m/);
        if (mo) { msUntilNextSlot = parseInt(mo[1]) * 60000; break; }
      }
    }

    return { available, cooldownSec, flashMsg, usageToday, usageMax, msUntilNextSlot,
             _dbg: `cards:${cards.length}|lp:found|btn:${!!btn}|avail:${available}|exp:${cooldownSec}|pills:[${pillTexts}]` };
  }).catch((err: any) => {
    // Surface the real error so it appears in runner logs
    throw new Error(`getLinkPaysStatus evaluate failed: ${err?.message ?? String(err)}`);
  });
}

// ─── Ad-page flow (rank1st.in / savepe.in) ───────────────────────────────────
//
// Pattern on each ad page:
//   1. Wait for countdown to reach 0  (15–20s)
//   2. Click "I am not robot" checkbox  (Turnstile — puppeteer-real-browser auto-solves)
//   3. Scroll to bottom
//   4. Click "Verify" button
//   5. Wait for "verifying…" to resolve
//   6. Click "Continue" button
//   7. Wait for navigation to next page

async function handleAdPage(page: any, label: string): Promise<void> {
  log(`[${label}] Handling ad page: ${page.url()}`);
  await waitForCF(page, 30_000);

  // 1. Wait for countdown
  log(`[${label}] Waiting for countdown…`);
  await waitForCountdown(page, 45_000, label);
  await sleep(1000); // small buffer after timer hits 0

  // 2. "I am not robot" checkbox — Turnstile is auto-solved by puppeteer-real-browser.
  //    Some pages also have a visible checkbox/button labelled "I am not a robot".
  log(`[${label}] Clicking "I am not robot"…`);
  const ianrClicked = await clickButton(
    page,
    [
      'input[type="checkbox"]',
      ".cf-turnstile",
      "#turnstile-wrapper",
      "[class*='robot']",
      "[id*='robot']",
      "[class*='human']",
      ".captcha-checkbox",
    ],
    ["not a robot", "not robot", "human", "captcha"],
    label,
  );
  log(`[${label}] "I am not robot" clicked: ${ianrClicked}`);
  await sleep(2000);

  // 3. Scroll to bottom to reveal buttons
  log(`[${label}] Scrolling to bottom…`);
  await scrollToBottom(page);
  await sleep(800);

  // 4. Click "Verify" button
  log(`[${label}] Clicking Verify…`);
  let verifyClicked = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    verifyClicked = await clickButton(
      page,
      [
        "#verify-btn",
        ".verify-btn",
        "button[id*='verify']",
        "button[class*='verify']",
        "a[id*='verify']",
        "a[class*='verify']",
      ],
      ["verify"],
      label,
    );
    if (verifyClicked) break;
    await sleep(1000);
    await scrollToBottom(page);
  }
  log(`[${label}] Verify clicked: ${verifyClicked}`);
  await sleep(2500);

  // 5. Wait for "verifying" spinner to disappear / "Continue" to appear
  log(`[${label}] Waiting for Continue to appear…`);
  for (let i = 0; i < 15; i++) {
    const hasBtn = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const els = Array.from(
        doc.querySelectorAll("button, a, input[type=submit]"),
      ) as any[];
      return els.some(el => (el.innerText || el.value || "").toLowerCase().includes("continu"));
    }).catch(() => false);
    if (hasBtn) break;
    await sleep(1000);
  }

  // 6. Click "Continue"
  log(`[${label}] Clicking Continue…`);
  let continueClicked = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    continueClicked = await clickButton(
      page,
      [
        "#continue-btn",
        ".continue-btn",
        "button[id*='continue']",
        "a[id*='continue']",
        ".btn-continue",
      ],
      ["continue"],
      label,
    );
    if (continueClicked) break;
    await sleep(1200);
    await scrollToBottom(page);
  }
  log(`[${label}] Continue clicked: ${continueClicked}`);

  // 7. Wait for navigation away from this page
  const currentUrl = page.url();
  log(`[${label}] Waiting for navigation away from ${currentUrl}…`);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (page.url() !== currentUrl) {
      log(`[${label}] Navigated → ${page.url()}`);
      return;
    }
  }
  log(`[${label}] Warning: page did not navigate within 20s. Continuing anyway.`);
}

// ─── bookyourhotel.in handler ─────────────────────────────────────────────────
//
// Pattern: wait 30s countdown → click "Get Link" → wait for redirect back to linkpays.in
//
// chainStartMs: timestamp when LP button was clicked on /earn (used to delay
// "Get Link" until 237s elapsed, so the linkpays.in→vektalnodes.in redirect
// lands at 241-243s — safely over the 240s server-side minimum).

async function handleBookyourhotel(page: any, chainStartMs?: number): Promise<void> {
  log(`[bookyourhotel] Handling: ${page.url()}`);
  await waitForCF(page, 30_000);

  // Step A: handle the main /?link=… page (countdown + Get Link)
  if (page.url().includes("bookyourhotel.in") && !page.url().includes("/disclaimer")) {
    log("[bookyourhotel] Waiting for countdown…");
    await waitForCountdown(page, 60_000, "bookyourhotel");
    await sleep(1000);
    await scrollToBottom(page);
    await sleep(500);

    // ── Pre-click timing pad ────────────────────────────────────────────────
    // Ensure we click "Get Link" no earlier than 237s since chain start so that
    // the automatic linkpays.in→vektalnodes.in redirect (~4s later) lands at
    // 241s+, satisfying the 240s server-side minimum.
    if (chainStartMs !== undefined) {
      const PRE_CLICK_TARGET_MS = 237_000; // 245s minimum − ~8s for redirects
      const elapsed = Date.now() - chainStartMs;
      const padMs = PRE_CLICK_TARGET_MS - elapsed;
      if (padMs > 0) {
        log(`[bookyourhotel] Elapsed: ${Math.round(elapsed / 1000)}s — waiting ${Math.round(padMs / 1000)}s before Get Link to hit 237s mark…`);
        const padEnd = Date.now() + padMs;
        while (Date.now() < padEnd) {
          await sleep(5000);
          const rem = Math.round((padEnd - Date.now()) / 1000);
          if (rem > 0) log(`[bookyourhotel] Pre-click pad: ${rem}s remaining…`);
        }
      } else {
        log(`[bookyourhotel] Elapsed: ${Math.round(elapsed / 1000)}s — already past 237s mark, clicking now.`);
      }
    }

    log("[bookyourhotel] Clicking 'Get Link'…");
    let clicked = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      clicked = await clickButton(
        page,
        [
          "#get-link",
          ".get-link",
          "button[id*='link']",
          "a[id*='link']",
          "#getlink",
          ".getlink",
          "a.btn",
          "button.btn",
        ],
        ["get link", "getlink", "get-link", "claim", "proceed", "continue", "get"],
        "bookyourhotel",
      );
      if (clicked) break;
      await sleep(1500);
      await scrollToBottom(page);
    }
    log(`[bookyourhotel] Get Link clicked: ${clicked}`);

    // Wait for any navigation away from the landing page
    const landingUrl = page.url();
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      if (page.url() !== landingUrl) { log(`[bookyourhotel] Redirected → ${page.url()}`); break; }
    }
  }

  // Step B: if we landed on /disclaimer/, click Continue/Agree/Accept
  if (page.url().includes("bookyourhotel.in")) {
    const curUrl = page.url();
    log(`[bookyourhotel] On: ${curUrl}`);

    if (curUrl.includes("/disclaimer") || curUrl === "https://bookyourhotel.in/" || curUrl === "https://bookyourhotel.in") {
      // Dump page HTML for debugging
      const html: string = await page.content().catch(() => "");
      const { writeFileSync } = await import("fs");
      writeFileSync("/tmp/bookyourhotel-disclaimer.html", html, "utf8");
      log(`[bookyourhotel] Disclaimer page captured (${html.length} chars) → /tmp/bookyourhotel-disclaimer.html`);

      await waitForCF(page, 20_000);
      await sleep(1000);
      await scrollToBottom(page);

      log("[bookyourhotel] Clicking Continue/Agree on disclaimer page…");
      let disclaimerClicked = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        disclaimerClicked = await clickButton(
          page,
          [
            "#continueBtn",
            ".continue-btn",
            "#proceed",
            "a.btn-primary",
            "button.btn-primary",
            "a.btn",
            "button.btn",
            "a[href*='vektalnodes']",
            "a[href*='linkpays']",
          ],
          ["continue", "agree", "accept", "proceed", "next", "get link", "claim", "ok"],
          "bookyourhotel-disclaimer",
        );
        if (disclaimerClicked) break;
        await sleep(1500);
        await scrollToBottom(page);
      }
      log(`[bookyourhotel] Disclaimer button clicked: ${disclaimerClicked}`);

      // Wait for navigation
      const disclaimerUrl = page.url();
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const u = page.url();
        if (u !== disclaimerUrl) { log(`[bookyourhotel] Disclaimer redirect → ${u}`); break; }
      }
    }
  }

  // Step C: wait for final redirect back to linkpays.in or vektalnodes.in
  log("[bookyourhotel] Waiting for final redirect to linkpays.in/vektalnodes.in…");
  await waitForUrl(page, ["linkpays.in", "vektalnodes.in"], 30_000, "bookyourhotel").catch(err => {
    log(`[bookyourhotel] ${err.message}`);
  });
  log(`[bookyourhotel] Done → ${page.url()}`);
}

// ─── linkpays.in handler ─────────────────────────────────────────────────────
//
// Pattern: click "Continue to next step" → navigate to rank1st.in

async function handleLinkpays(page: any): Promise<void> {
  log(`[linkpays] On page: ${page.url()}`);
  await waitForCF(page, 30_000);
  await sleep(1000);

  log("[linkpays] Clicking 'Continue to next step'…");
  let clicked = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    clicked = await clickButton(
      page,
      [
        "#continueBtn",
        ".continue-btn",
        "#proceed",
        "button[id*='continu']",
        "a[id*='continu']",
        "button.btn-primary",
        "a.btn-primary",
      ],
      [
        "continue to next",
        "continue",
        "next step",
        "proceed",
        "go to",
      ],
      "linkpays",
    );
    if (clicked) break;

    // linkpays.in sometimes has a JS proceed() call on a timer; also try calling it
    const proceedCalled: boolean = await page.evaluate(() => {
      if (typeof (globalThis as any).proceed === "function") {
        (globalThis as any).proceed();
        return true;
      }
      return false;
    }).catch(() => false);
    if (proceedCalled) { clicked = true; break; }

    await sleep(1500);
  }
  log(`[linkpays] Continue clicked: ${clicked}`);

  // Wait for navigation away from linkpays.in
  const current = page.url();
  log("[linkpays] Waiting for navigation away from linkpays.in…");
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const u = page.url();
    if (u !== current && !u.includes("linkpays.in")) {
      log(`[linkpays] Navigated → ${u}`);
      return;
    }
  }
  log("[linkpays] Warning: still on linkpays.in after 20s. Continuing anyway.");
}

// ─── One full earn cycle ──────────────────────────────────────────────────────
//
// Opens a fresh browser tab for each cycle (same pattern as afk-bot.ts).
// Also tracks new-tab creation: if the button click spawns a popup/new window,
// we switch to that new tab as our active page.

async function runOneCycle(browser: any, cycleNum: number): Promise<{
  ok: boolean;
  cooldownSec: number;
  msUntilNextSlot: number; // >0 when 24h limit reached — how long until next slot opens
  usageToday: number;
  usageMax: number;
}> {
  const SEP = "═".repeat(70);
  log(`\n${SEP}`);
  log(`CYCLE ${cycleNum} START`);
  log(SEP);

  // Open a fresh page for this cycle (inherits cookies from same browser ctx)
  let cyclePage: any = await browser.newPage().catch(async () => {
    // Fallback: get all pages and use the last one
    const pages: any[] = await browser.pages().catch(() => []);
    return pages[pages.length - 1] ?? null;
  });
  if (!cyclePage) throw new Error("Could not open a page for this cycle.");
  await cyclePage.setViewport({ width: 1280, height: 900 }).catch(() => {});
  // Forward console messages from cyclePage so page.evaluate console.log appears in runner logs
  cyclePage.on("console", (msg: any) => log(`[PAGE] ${msg.text()}`));

  // Track new tabs opened during this cycle so we can follow them
  let newTabPage: any = null;
  const onNewTarget = async (target: any) => {
    try {
      const p = await target.page().catch(() => null);
      if (p && p !== cyclePage) {
        log(`[NEW TAB] ${target.url() || "?"}`);
        newTabPage = p;
        await p.setViewport({ width: 1280, height: 900 }).catch(() => {});
      }
    } catch {}
  };
  browser.on("targetcreated", onNewTarget);

  /**
   * Return the page that's currently "active" (the one furthest in the flow).
   * If a new tab was opened and has moved away from vektalnodes.in, use it.
   */
  const activePage = (): any => {
    if (newTabPage) {
      try {
        const u: string = newTabPage.url();
        if (u && !u.startsWith("about:") && !u.includes("vektalnodes.in")) return newTabPage;
      } catch {}
    }
    return cyclePage;
  };

  try {
    // Navigate to /earn on the fresh tab
    log("Navigating to /earn on fresh tab…");
    await cyclePage.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(cyclePage);
    await sleep(1500);

    // Check if redirected to login (session expired)
    if (cyclePage.url().includes("/login")) {
      log("Session expired — aborting cycle. Re-login needed.");
      return { ok: false, cooldownSec: 0, msUntilNextSlot: 0, usageToday: 0, usageMax: 10 };
    }

    const coinsBefore = await getCoins(cyclePage);
    const status      = await getLinkPaysStatus(cyclePage);
    log(`Coins: ${coinsBefore} | LP available: ${status.available} | Session: ${status.cooldownSec > 0 ? status.cooldownSec + "s" : "none"} | Usage: ${status.usageToday}/${status.usageMax} | dbg: ${(status as any)._dbg}`);

    if (!status.available) {
      if (status.cooldownSec > 0) {
        log(`Cooldown active: ${status.cooldownSec}s.`);
        return { ok: false, cooldownSec: status.cooldownSec, msUntilNextSlot: 0, usageToday: status.usageToday, usageMax: status.usageMax };
      }
      // 24h limit hit — report next-slot time so the main loop can sleep correctly
      if (status.msUntilNextSlot > 0) {
        log(`24h limit reached (${status.usageToday}/${status.usageMax}). Next slot in ${Math.round(status.msUntilNextSlot / 60_000)}min.`);
      } else {
        log("LP button not available — 24h limit or other block.");
      }
      return { ok: false, cooldownSec: 0, msUntilNextSlot: status.msUntilNextSlot, usageToday: status.usageToday, usageMax: status.usageMax };
    }

    // ── Step 1: Click the LinkPays button ──────────────────────────────────
    log("Clicking LinkPays button on /earn…");
    const lpBtn = await cyclePage.$('button.button-primary[type="submit"]');
    if (!lpBtn) {
      log("ERROR: LinkPays button not found on /earn.");
      return { ok: false, cooldownSec: 0, msUntilNextSlot: 0, usageToday: status.usageToday, usageMax: status.usageMax };
    }
    const btnText: string = await cyclePage.evaluate((el: any) => el.innerText, lpBtn).catch(() => "");
    log(`Clicking: "${btnText.trim()}"`);
    const chainStartMs = Date.now(); // track elapsed for 240s minimum
    await lpBtn.click();

    // ── Step 2: Wait for linkpays.in on current tab OR new tab ─────────────
    log("Waiting for linkpays.in (same tab or new tab)…");
    let lpPage: any = cyclePage; // will be updated if a new tab takes over
    let onLinkpays = false;
    for (let i = 0; i < 40 && !onLinkpays; i++) {
      await sleep(800);
      // Check current tab
      if (cyclePage.url().includes("linkpays.in")) {
        lpPage = cyclePage; onLinkpays = true; break;
      }
      // Check if new tab opened and navigated to linkpays.in
      if (newTabPage) {
        try {
          const u: string = newTabPage.url();
          if (u.includes("linkpays.in")) { lpPage = newTabPage; onLinkpays = true; break; }
          if (u && !u.startsWith("about:") && !u.includes("vektalnodes.in")) {
            // New tab is somewhere in the flow — use it
            log(`New tab is at ${u} — switching to it.`);
            lpPage = newTabPage; onLinkpays = true; break;
          }
        } catch {}
      }
      if (i % 5 === 4) log(`Still waiting for linkpays.in… (${cyclePage.url()})`);
    }

    if (!onLinkpays) {
      // Check for cooldown flash message
      const s2 = await getLinkPaysStatus(cyclePage);
      if (s2.cooldownSec > 0) {
        log(`Flash cooldown detected: ${s2.cooldownSec}s.`);
        return { ok: false, cooldownSec: s2.cooldownSec, msUntilNextSlot: 0, usageToday: s2.usageToday, usageMax: s2.usageMax };
      }
      log(`WARNING: Did not reach linkpays.in. Current tab: ${cyclePage.url()}`);
      return { ok: false, cooldownSec: 60, msUntilNextSlot: 0, usageToday: s2.usageToday, usageMax: s2.usageMax };
    }

    log(`Active page for ad chain: ${lpPage.url()}`);

    // ── Step 3: Handle linkpays.in ─────────────────────────────────────────
    if (lpPage.url().includes("linkpays.in")) {
      await handleLinkpays(lpPage);
    }

    // ── Step 4+: Ad page chain ─────────────────────────────────────────────
    const DONE_DOMAINS  = ["vektalnodes.in"];
    const FINAL_DOMAIN  = "bookyourhotel.in";
    const SKIP_DOMAINS  = ["linkpays.in"];
    const MAX_AD_PAGES  = 10;

    for (let pageNum = 1; pageNum <= MAX_AD_PAGES; pageNum++) {
      // Check both tabs; prefer the one furthest in the chain
      if (newTabPage && newTabPage !== lpPage) {
        try {
          const ntUrl: string = newTabPage.url();
          if (ntUrl && !ntUrl.startsWith("about:") && !ntUrl.includes("vektalnodes.in/earn") &&
              !ntUrl.includes("linkpays.in")) {
            log(`Switching active page to new tab: ${ntUrl}`);
            lpPage = newTabPage;
          }
        } catch {}
      }

      const currentUrl: string = lpPage.url();
      log(`Ad page ${pageNum}: ${currentUrl}`);

      if (DONE_DOMAINS.some(d => currentUrl.includes(d))) {
        log("Returned to vektalnodes.in — chain complete.");
        break;
      }
      if (currentUrl.includes(FINAL_DOMAIN)) {
        await handleBookyourhotel(lpPage, chainStartMs);
        break;
      }
      if (SKIP_DOMAINS.some(d => currentUrl.includes(d))) {
        log(`[ad-${pageNum}] linkpays.in pass-through — waiting for redirect…`);
        const prev = currentUrl;
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          if (lpPage.url() !== prev) { log(`Redirected → ${lpPage.url()}`); break; }
        }
        continue;
      }
      // Any other domain → standard ad page (countdown → IANR → Verify → Continue)
      await handleAdPage(lpPage, `ad-${pageNum}`);
      await sleep(500);
    }

    // ── Step 7.5: Safety-net wait ──────────────────────────────────────────
    //
    // The pre-click pad inside handleBookyourhotel already ensures the
    // linkpays.in→vektalnodes.in redirect lands at 241s+.
    // This 5s safety sleep just lets the server process the return before
    // we do any further navigation.
    {
      const elapsed = Date.now() - chainStartMs;
      log(`Chain elapsed: ${Math.round(elapsed / 1000)}s — safety sleep 5s…`);
      await sleep(5000);
    }

    // ── Step 8: Return to /earn and check coins ────────────────────────────
    log("Waiting for return to vektalnodes.in…");
    await waitForUrl(lpPage, ["vektalnodes.in"], 30_000, "return").catch(err => {
      log(`Return wait: ${err.message}. Navigating to /earn manually…`);
    });

    // Use whichever page landed on vektalnodes.in
    let earnPage = lpPage.url().includes("vektalnodes.in") ? lpPage : cyclePage;

    // Always do a fresh /earn load so coin count is up-to-date
    log(`Navigating to /earn for final coin check (currently: ${earnPage.url()})…`);
    await earnPage.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(earnPage);
    await sleep(3000); // let server update

    // Dump earn page HTML for debugging
    const earnHtml: string = await earnPage.content().catch(() => "");
    const { writeFileSync } = await import("fs");
    writeFileSync("/tmp/linkpays-earn-after.html", earnHtml, "utf8");
    log(`Earn page HTML saved (${earnHtml.length} chars) → /tmp/linkpays-earn-after.html`);

    const coinsAfter  = await getCoins(earnPage);
    const statusAfter = await getLinkPaysStatus(earnPage);
    const diff        = coinsAfter - coinsBefore;
    log(`Coins BEFORE: ${coinsBefore} | AFTER: ${coinsAfter} | Diff: +${diff}`);
    const nextWaitSec = statusAfter.cooldownSec > 0
      ? statusAfter.cooldownSec + 15
      : COOLDOWN_MS / 1000;
    log(`Flash: "${statusAfter.flashMsg}" | Next wait: ${nextWaitSec}s${statusAfter.cooldownSec > 0 ? " (server)" : " (default)"}`);

    // Check if flash mentions anything about credits
    const flashLower = (statusAfter.flashMsg ?? "").toLowerCase();
    const earnHtmlLower = earnHtml.toLowerCase();
    const alertMatch = earnHtml.match(/<[^>]*(alert|flash|notice)[^>]*>[\s\S]{0,500}/i);
    if (alertMatch) log(`Alert on /earn: ${alertMatch[0].replace(/\s+/g, " ").slice(0, 300)}`);

    if (diff > 0) {
      log(`✅ CYCLE ${cycleNum} SUCCESS — earned ${diff} coins | Usage: ${statusAfter.usageToday}/${statusAfter.usageMax}`);
      return { ok: true, cooldownSec: statusAfter.cooldownSec || 0, msUntilNextSlot: statusAfter.msUntilNextSlot, usageToday: statusAfter.usageToday, usageMax: statusAfter.usageMax };
    } else {
      log(`❌ CYCLE ${cycleNum} — No coins credited. Flash: "${statusAfter.flashMsg}" | Usage: ${statusAfter.usageToday}/${statusAfter.usageMax}`);
      return { ok: false, cooldownSec: statusAfter.cooldownSec || 0, msUntilNextSlot: statusAfter.msUntilNextSlot, usageToday: statusAfter.usageToday, usageMax: statusAfter.usageMax };
    }

  } finally {
    browser.off("targetcreated", onNewTarget);
    // Close the new tab if one was opened
    try { if (newTabPage) await newTabPage.close(); } catch {}
    // Close the cycle tab
    try { await cyclePage.close(); } catch {}
  }
}

// ─── Bot session (browser launch → login → cycle loop) ────────────────────────
//
// Extracted so main() can restart it on any fatal error without exiting the
// Node process — Render must never see the process die on a recoverable error.

async function runBot(xvfb: ChildProcess | null, cycleNumRef: { n: number }) {
  let browser: any;
  try {
    log(`Launching browser… (chromium: ${CHROMIUM_PATH}, snap: ${IS_SNAP_CHROMIUM}, display: ${process.env.DISPLAY ?? "not set"})`);

    // Snap Chromium manages its own sandbox — passing --no-sandbox causes an immediate crash.
    // Non-snap/system Chromium on a headless server requires --no-sandbox.
    const sandboxArgs = IS_SNAP_CHROMIUM
      ? []
      : ["--no-sandbox", "--disable-setuid-sandbox"];

    const { browser: b, page } = await connect({
      headless: false,
      args: [
        ...sandboxArgs,
        "--disable-dev-shm-usage",
        "--window-size=1280,900",
      ],
      customConfig: { chromePath: CHROMIUM_PATH },
      turnstile: true,
      connectOption: { defaultViewport: { width: 1280, height: 900 } },
    } as any);
    browser = b;
    log("Browser launched ✓");

    page.on("console", (msg: any) => {
      const t = msg.text();
      if (t.startsWith("[FETCH") || t.startsWith("[XHR") || t.includes("vektalnodes") || t.includes("earn"))
        log(`[PAGE] ${t}`);
    });

    // Try to restore a previous session (skips CF challenge on restart).
    // Falls back to fresh login if cookies are missing or expired.
    const restored = await tryRestoreSession(page);
    if (!restored) {
      await login(page);
      await saveCookies(page);
    }

    while (true) {
      cycleNumRef.n++;
      const cycleNum = cycleNumRef.n;
      let cycleResult = {
        ok: false, cooldownSec: 0, msUntilNextSlot: 0, usageToday: 0, usageMax: 10,
      };

      try {
        cycleResult = await runOneCycle(browser, cycleNum);
      } catch (err: any) {
        log(`CYCLE ${cycleNum} ERROR: ${err?.message ?? err}`);
        // Re-login if session appears dead
        try {
          const pages: any[] = await browser.pages().catch(() => []);
          const anyPage = pages[0];
          if (anyPage) {
            const u: string = anyPage.url();
            if (u.includes("/login") || !u.includes("vektalnodes.in")) {
              log("Attempting re-login after error…");
              await login(anyPage);
              await saveCookies(anyPage);
            }
          }
        } catch (loginErr: any) {
          log(`Re-login failed: ${loginErr?.message ?? loginErr} — will restart browser.`);
          throw loginErr; // bubble up to trigger browser restart
        }
      }

      // ── Decide how long to wait before the next cycle ─────────────────────
      // If the server reports a next-slot time, honour it — the rolling 24h window
      // means you can hit the limit with fewer than usageMax total uses if the
      // oldest uses haven't expired yet.
      if (!cycleResult.ok && cycleResult.msUntilNextSlot > 0) {
        const sleepMs = cycleResult.msUntilNextSlot + 2 * 60_000;
        log(`24h limit (${cycleResult.usageToday}/${cycleResult.usageMax}). Sleeping ${Math.round(sleepMs / 60_000)}min until next slot…`);
        const wakeAt = Date.now() + sleepMs;
        while (Date.now() < wakeAt) {
          const remMin = Math.round((wakeAt - Date.now()) / 60_000);
          log(`  waiting for daily reset — ${remMin}min remaining…`);
          await sleep(Math.min(10 * 60_000, wakeAt - Date.now()));
        }
        log("Daily reset reached — resuming.");
      } else {
        const waitSec = cycleResult.cooldownSec > 0
          ? cycleResult.cooldownSec + 15
          : COOLDOWN_MS / 1000;
        log(`Waiting ${waitSec}s cooldown before next cycle…`);
        await sleep(waitSec * 1000);
      }
    }
  } finally {
    try { browser?.close(); } catch {}
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log("═══ LINKPAYS RUNNER STARTING ═══");

  // Render requires a bound port — spin up a minimal health-check server.
  // PORT=5000 is reserved for the API server on Replit. Fall back to 10000.
  const rawPort = parseInt(process.env.PORT ?? "10000", 10);
  const healthPort = rawPort === 5000 ? 10000 : rawPort;
  createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }).listen(healthPort, "0.0.0.0", () => {
    log(`Health-check server listening on port ${healthPort}`);
  });

  const xvfb = await startXvfb();
  // Only set DISPLAY if not already provided (xvfb-run sets it automatically)
  if (!process.env.DISPLAY) {
    process.env.DISPLAY = DISPLAY_NUM;
  }
  log(`DISPLAY=${process.env.DISPLAY} | chromium=${CHROMIUM_PATH} | snap=${IS_SNAP_CHROMIUM}`);

  // Only exit on intentional signals — every other error restarts the bot session.
  let stopping = false;
  const onStop = () => {
    stopping = true;
    log("Stop signal received — shutting down.");
    if (xvfb) xvfb.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT",  onStop);
  process.on("SIGTERM", onStop);

  // Cycle counter persists across browser restarts so logs are sequential.
  const cycleNumRef = { n: 0 };

  // Infinite self-restart loop — Render must never see this process die.
  while (!stopping) {
    try {
      await runBot(xvfb, cycleNumRef);
    } catch (err: any) {
      log(`Bot session crashed: ${err?.message ?? err}`);
      log("Restarting bot session in 30s…");
      await sleep(30_000);
    }
  }
}

main().catch(err => {
  console.error("[runner] Fatal:", err);
  process.exit(1);
});
