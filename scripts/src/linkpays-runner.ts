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
 */
async function waitForCountdown(page: any, maxWaitMs = 45_000, label = "") {
  const prefix = label ? `[${label}] ` : "";
  const dl = Date.now() + maxWaitMs;
  let last = -1;
  while (Date.now() < dl) {
    const secs = await readCountdown(page);
    if (secs !== last) { log(`${prefix}Countdown: ${secs}s`); last = secs; }
    if (secs <= 0) return;
    await sleep(1000);
  }
  log(`${prefix}Countdown wait timed out — proceeding anyway.`);
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
  available: boolean; cooldownSec: number;
}> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const cards = Array.from(doc.querySelectorAll("article.offer-card"));
    let lpCard: any = null;
    for (const c of cards as any[]) {
      const h = (c as any).querySelector("h3")?.innerText ?? "";
      if (h.toLowerCase().includes("linkpays")) { lpCard = c; break; }
    }
    if (!lpCard) {
      // Fallback: look for any submit button
      const btn = doc.querySelector('button.button-primary[type="submit"]');
      return { available: !!btn && !(btn as any).disabled, cooldownSec: 0 };
    }
    const btn = lpCard.querySelector("button.button-primary[type='submit']");
    const available = !!btn && !(btn as any).disabled;
    const expireEl = lpCard.querySelector("[data-expire-seconds]");
    const cooldownSec = expireEl
      ? parseInt((expireEl as any).getAttribute("data-expire-seconds") ?? "0", 10)
      : 0;
    return { available, cooldownSec };
  }).catch(() => ({ available: false, cooldownSec: 0 }));
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

async function handleBookyourhotel(page: any): Promise<void> {
  log(`[bookyourhotel] Handling: ${page.url()}`);
  await waitForCF(page, 30_000);

  log("[bookyourhotel] Waiting for 30s countdown…");
  await waitForCountdown(page, 60_000, "bookyourhotel");
  await sleep(1000);

  await scrollToBottom(page);
  await sleep(500);

  log("[bookyourhotel] Clicking 'Get Link'…");
  let clicked = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    clicked = await clickButton(
      page,
      [
        "#get-link",
        ".get-link",
        "button[id*='link']",
        "a[id*='link']",
        "#getlink",
        ".getlink",
      ],
      ["get link", "getlink", "get-link", "claim", "proceed"],
      "bookyourhotel",
    );
    if (clicked) break;
    await sleep(1500);
    await scrollToBottom(page);
  }
  log(`[bookyourhotel] Get Link clicked: ${clicked}`);

  // Wait for redirect back to linkpays.in
  log("[bookyourhotel] Waiting for redirect to linkpays.in…");
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

async function runOneCycle(page: any, cycleNum: number): Promise<boolean> {
  const SEP = "═".repeat(70);
  log(`\n${SEP}`);
  log(`CYCLE ${cycleNum} START`);
  log(SEP);

  // Navigate to /earn
  await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);
  await sleep(1000);

  const coinsBefore = await getCoins(page);
  const status      = await getLinkPaysStatus(page);
  log(`Coins: ${coinsBefore} | LP available: ${status.available} | Cooldown: ${status.cooldownSec}s`);

  if (!status.available) {
    if (status.cooldownSec > 0) {
      const waitMs = (status.cooldownSec + 10) * 1000;
      log(`Cooldown active: ${status.cooldownSec}s. Waiting ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      return false;
    }
    log("LP button not available and no cooldown — 24h limit or other block.");
    return false;
  }

  // ── Step 1: Click the LinkPays button on /earn ────────────────────────────
  log("Clicking LinkPays button on /earn…");
  const lpBtn = await page.$('button.button-primary[type="submit"]');
  if (!lpBtn) {
    log("ERROR: LinkPays button not found on /earn. Retrying next cycle.");
    return false;
  }
  const btnText: string = await page.evaluate((el: any) => el.innerText, lpBtn).catch(() => "");
  log(`Clicking: "${btnText.trim()}"`);
  await lpBtn.click();

  // ── Step 2: Wait for linkpays.in ─────────────────────────────────────────
  log("Waiting for linkpays.in…");
  await waitForUrl(page, ["linkpays.in"], 30_000, "earn→linkpays");

  // ── Step 3: Handle linkpays.in (click "Continue to next step") ────────────
  await handleLinkpays(page);

  // ── Step 4-7: Handle the 4 ad pages in sequence ───────────────────────────
  //
  // After linkpays.in we expect:
  //   rank1st.in/?link=…
  //   rank1st.in/<article>
  //   savepe.in/<article-1>
  //   savepe.in/<article-2>
  //
  // We don't hardcode the exact URLs — we just handle each page that matches
  // the known ad-page domains until we reach bookyourhotel.in.

  const AD_DOMAINS    = ["rank1st.in", "savepe.in"];
  const FINAL_DOMAIN  = "bookyourhotel.in";
  const MAX_AD_PAGES  = 6; // safety cap

  for (let pageNum = 1; pageNum <= MAX_AD_PAGES; pageNum++) {
    const currentUrl = page.url();
    log(`Ad page ${pageNum}: ${currentUrl}`);

    if (currentUrl.includes(FINAL_DOMAIN)) {
      await handleBookyourhotel(page);
      break;
    }

    if (AD_DOMAINS.some(d => currentUrl.includes(d))) {
      await handleAdPage(page, `ad-${pageNum}`);
      await sleep(500);
      continue;
    }

    // Unexpected domain — wait a moment in case of in-flight redirect
    log(`Unexpected URL "${currentUrl}" — waiting 3s for redirect…`);
    await sleep(3000);

    const nextUrl = page.url();
    if (nextUrl === currentUrl) {
      log("URL didn't change — attempting to continue anyway.");
      break;
    }
  }

  // ── Step 8: Wait for return to vektalnodes.in/earn ───────────────────────
  log("Waiting for return to vektalnodes.in…");
  await waitForUrl(page, ["vektalnodes.in"], 30_000, "return").catch(err => {
    log(`Return wait: ${err.message}. Navigating to /earn manually…`);
  });
  if (!page.url().includes("vektalnodes.in")) {
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(page);
  }

  await sleep(2000);
  const coinsAfter = await getCoins(page);
  const diff       = coinsAfter - coinsBefore;
  log(`Coins BEFORE: ${coinsBefore} | Coins AFTER: ${coinsAfter} | Diff: +${diff}`);

  if (diff > 0) {
    log(`✅ CYCLE ${cycleNum} SUCCESS — earned ${diff} coins (${coinsBefore} → ${coinsAfter})`);
    return true;
  } else {
    log(`❌ CYCLE ${cycleNum} — No coins credited this cycle.`);
    return false;
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
    try {
      const ok = await runOneCycle(page, cycleNum);
      if (ok) successesThisDay++;
      log(`Daily uses today: ${successesThisDay}/${MAX_DAILY_USES}`);
    } catch (err: any) {
      log(`CYCLE ${cycleNum} ERROR: ${err?.message ?? err}`);
      // Try to recover by navigating back to /earn
      try {
        await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await waitForCF(page);
      } catch {}
    }

    log(`Waiting ${COOLDOWN_MS / 1000}s cooldown before next cycle…`);
    await sleep(COOLDOWN_MS);
  }
}

main().catch(err => {
  console.error("[runner] Fatal:", err);
  process.exit(1);
});
