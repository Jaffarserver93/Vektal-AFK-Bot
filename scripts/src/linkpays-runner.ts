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
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync } from "fs";

const SITE         = "https://vektalnodes.in";
const EMAIL        = process.env.VEKTAL_EMAIL    ?? "";
const PASSWORD     = process.env.VEKTAL_PASSWORD ?? "";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const XVFB_PATH =
  process.env.XVFB_PATH ??
  "/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin/Xvfb";
const DISPLAY_NUM     = ":94";
const COOLDOWN_MS     = 310_000; // 310s > 300s server cooldown
const MAX_DAILY_USES  = 10;
const LOG_FILE        = "/tmp/linkpays-runner.log";

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

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x900x24"], {
      stdio: ["ignore", "ignore", "pipe"], detached: false,
    });
    xvfb.stderr?.on("data", (d: Buffer) => {
      const l = d.toString().trim();
      if (l) log(`[Xvfb] ${l}`);
    });
    xvfb.on("error", reject);
    setTimeout(() => resolve(xvfb), 1500);
  });
}

async function waitForCF(page: any, ms = 60_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const title: string = await page.title().catch(() => "");
    const url:   string = page.url();
    if (
      !title.toLowerCase().includes("just a moment") &&
      !url.includes("/cdn-cgi/challenge")
    ) return;
    log(`CF challenge active ("${title}") — waiting 2s…`);
    await sleep(2000);
  }
  log("Warning: CF may not have cleared within timeout.");
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
  log("Navigating to /login…");
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30_000 }).catch(() => {});
  await sleep(600);

  let emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) {
    log("Email input not found — reloading…");
    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
  available: boolean; cooldownSec: number; flashMsg: string;
}> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    // Read flash/alert message from the page
    const flashEl = doc.querySelector(".alert, .flash, [role='alert'], .notice");
    const flashMsg: string = flashEl ? (flashEl.innerText ?? flashEl.textContent ?? "").trim() : "";

    const cards = Array.from(doc.querySelectorAll("article.offer-card"));
    let lpCard: any = null;
    for (const c of cards as any[]) {
      const h = (c as any).querySelector("h3")?.innerText ?? "";
      if (h.toLowerCase().includes("linkpays")) { lpCard = c; break; }
    }
    if (!lpCard) {
      // Fallback: look for any submit button
      const btn = doc.querySelector('button.button-primary[type="submit"]');
      return { available: !!btn && !(btn as any).disabled, cooldownSec: 0, flashMsg };
    }
    const btn = lpCard.querySelector("button.button-primary[type='submit']");
    const available = !!btn && !(btn as any).disabled;
    const expireEl = lpCard.querySelector("[data-expire-seconds]");
    const cooldownSec = expireEl
      ? parseInt((expireEl as any).getAttribute("data-expire-seconds") ?? "0", 10)
      : 0;
    return { available, cooldownSec, flashMsg };
  }).catch(() => ({ available: false, cooldownSec: 0, flashMsg: "" }));
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

async function runOneCycle(browser: any, cycleNum: number): Promise<{ ok: boolean; cooldownSec: number }> {
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
      return { ok: false, cooldownSec: 0 };
    }

    const coinsBefore = await getCoins(cyclePage);
    const status      = await getLinkPaysStatus(cyclePage);
    log(`Coins: ${coinsBefore} | LP available: ${status.available} | Cooldown: ${status.cooldownSec}s`);

    if (!status.available) {
      if (status.cooldownSec > 0) {
        log(`Cooldown active: ${status.cooldownSec}s.`);
        return { ok: false, cooldownSec: status.cooldownSec };
      }
      log("LP button not available — 24h limit or other block.");
      return { ok: false, cooldownSec: 0 };
    }

    // ── Step 1: Click the LinkPays button ──────────────────────────────────
    log("Clicking LinkPays button on /earn…");
    const lpBtn = await cyclePage.$('button.button-primary[type="submit"]');
    if (!lpBtn) {
      log("ERROR: LinkPays button not found on /earn.");
      return { ok: false, cooldownSec: 0 };
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
        return { ok: false, cooldownSec: s2.cooldownSec };
      }
      log(`WARNING: Did not reach linkpays.in. Current tab: ${cyclePage.url()}`);
      return { ok: false, cooldownSec: 60 };
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
    log(`Flash: "${statusAfter.flashMsg}" | Cooldown: ${statusAfter.cooldownSec}s`);

    // Check if flash mentions anything about credits
    const flashLower = (statusAfter.flashMsg ?? "").toLowerCase();
    const earnHtmlLower = earnHtml.toLowerCase();
    const alertMatch = earnHtml.match(/<[^>]*(alert|flash|notice)[^>]*>[\s\S]{0,500}/i);
    if (alertMatch) log(`Alert on /earn: ${alertMatch[0].replace(/\s+/g, " ").slice(0, 300)}`);

    if (diff > 0) {
      log(`✅ CYCLE ${cycleNum} SUCCESS — earned ${diff} coins`);
      return { ok: true, cooldownSec: statusAfter.cooldownSec || 0 };
    } else {
      log(`❌ CYCLE ${cycleNum} — No coins credited. Flash: "${statusAfter.flashMsg}"`);
      return { ok: false, cooldownSec: statusAfter.cooldownSec || 0 };
    }

  } finally {
    browser.off("targetcreated", onNewTarget);
    // Close the new tab if one was opened
    try { if (newTabPage) await newTabPage.close(); } catch {}
    // Close the cycle tab
    try { await cyclePage.close(); } catch {}
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  log("═══ LINKPAYS RUNNER STARTING ═══");
  const xvfb = await startXvfb();
  process.env.DISPLAY = DISPLAY_NUM;

  let browser: any;
  const cleanup = () => {
    log("Cleaning up…");
    try { browser?.close(); } catch {}
    xvfb.kill("SIGTERM");
  };
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  log("Launching browser…");
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
  log("Browser launched ✓");

  // Log browser console output
  page.on("console", (msg: any) => {
    const t = msg.text();
    if (t.startsWith("[FETCH") || t.startsWith("[XHR") || t.includes("vektalnodes") || t.includes("earn"))
      log(`[PAGE] ${t}`);
  });

  await login(page);

  let cycleNum    = 0;
  let successesThisDay = 0;
  let dayStart    = Date.now();

  while (true) {
    // Reset daily counter
    const nowMs = Date.now();
    if (nowMs - dayStart > 24 * 60 * 60 * 1000) {
      log("24h reset — resetting daily counter.");
      successesThisDay = 0;
      dayStart = nowMs;
    }

    if (successesThisDay >= MAX_DAILY_USES) {
      const msUntilReset = 24 * 60 * 60 * 1000 - (nowMs - dayStart);
      log(`Daily limit reached (${MAX_DAILY_USES} uses). Sleeping ${Math.round(msUntilReset / 1000 / 60)}min until reset.`);
      await sleep(msUntilReset + 60_000);
      successesThisDay = 0;
      dayStart = Date.now();
      continue;
    }

    cycleNum++;
    let cycleResult = { ok: false, cooldownSec: 0 };
    try {
      cycleResult = await runOneCycle(browser, cycleNum);
      if (cycleResult.ok) successesThisDay++;
      log(`Daily uses today: ${successesThisDay}/${MAX_DAILY_USES}`);
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
          }
        }
      } catch {}
    }

    // Use server-reported cooldown if available, otherwise fall back to default
    const waitSec = cycleResult.cooldownSec > 0
      ? cycleResult.cooldownSec + 15
      : COOLDOWN_MS / 1000;
    log(`Waiting ${waitSec}s cooldown before next cycle…`);
    await sleep(waitSec * 1000);
  }
}

main().catch(err => {
  console.error("[runner] Fatal:", err);
  process.exit(1);
});
