/**
 * linkpays-bypasser.ts
 *
 * Complete automated bypass for the vektalnodes.in LinkPays earn flow.
 *
 * Full chain discovered:
 *   POST /earn/linkpays/start
 *     → 302 → linkpays.in/VEKTALNODES_COINS  (sets AppSession cookie)
 *     → 3.5s auto-proceed() → atob(b64) → evspec.in or rank1st.in
 *     → ad site has return redirect → vektalnodes.in/earn/linkpays/complete?token=...
 *     → server credits 12 coins, 300s cooldown
 *
 * Strategy:
 *   1. Login via browser (Cloudflare bypass)
 *   2. POST /earn/linkpays/start → follow to linkpays.in
 *   3. Execute proceed() on linkpays.in
 *   4. Follow to ad site (evspec.in / rank1st.in) — capture ALL network + HTML
 *   5. Find return URL to vektalnodes.in, follow it
 *   6. Confirm coin credit
 *   7. Wait 300s cooldown → repeat up to 10x / day
 */

import { connect } from "puppeteer-real-browser";
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, appendFileSync } from "fs";

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.VEKTAL_EMAIL ?? "";
const PASSWORD = process.env.VEKTAL_PASSWORD ?? "";
const CHROMIUM_PATH =
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const XVFB_PATH =
  "/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin/Xvfb";
const DISPLAY_NUM = ":93";
const COOLDOWN_MS = 310_000; // 310s (server sets 300s)
const MAX_DAILY_USES = 10;
const LOG_FILE = "/tmp/bypasser.log";

function ts() { return new Date().toISOString(); }
function log(msg: string) {
  const line = `[bypasser ${ts()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x900x24"], {
      stdio: ["ignore", "ignore", "pipe"], detached: false,
    });
    xvfb.on("error", reject);
    setTimeout(() => resolve(xvfb), 1500);
  });
}

async function waitForCF(page: any, ms = 60_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const url: string = page.url();
    const t: string = await page.title().catch(() => "");
    if (
      !t.toLowerCase().includes("just a moment") &&
      !url.includes("challenge") &&
      !url.includes("cf-")
    ) return;
    log(`CF challenge active — "${t}" — waiting...`);
    await sleep(2000);
  }
  log("Warning: CF may not have cleared within timeout.");
}

// Track ALL network for a CDP session
function trackNet(cdp: any, label: string, out: { reqs: any[], ress: any[], bodies: Record<string,string> }) {
  const noise = ["challenge-platform", "googlesyndication", "doubleclick", "gravatar",
    "criteo", "openx", ".png", ".jpg", ".woff", "fonts.g", "cloudflareinsights",
    "google-analytics", "googletagmanager", "fundingchoices", "adtrafficquality",
    "applixir.app", ".css", ".ico", ".svg", ".gif"];

  cdp.on("Network.requestWillBeSent", (e: any) => {
    const url = e.request.url;
    if (!noise.some(n => url.includes(n)))
      log(`[NET:${label}] → ${e.request.method} ${url.slice(0,160)}`);
    out.reqs.push({
      id: e.requestId, url, method: e.request.method,
      headers: e.request.headers, postData: e.request.postData ?? null,
      type: e.type, redirectResponse: e.redirectResponse ?? null, ts: Date.now(),
    });
  });
  cdp.on("Network.responseReceived", (e: any) => {
    const url = e.response.url;
    if (!noise.some(n => url.includes(n)))
      log(`[NET:${label}] ← ${e.response.status} ${url.slice(0,160)}`);
    out.ress.push({ id: e.requestId, url, status: e.response.status, headers: e.response.headers, mime: e.response.mimeType });
  });
  cdp.on("Network.loadingFinished", async (e: any) => {
    try { const r = await cdp.send("Network.getResponseBody", { requestId: e.requestId }); out.bodies[e.requestId] = r.body; } catch {}
  });
}

// ── Login ────────────────────────────────────────────────────────────────────
async function login(page: any) {
  log("Logging in...");
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);

  // Wait for email input to actually appear (may take a moment after CF clears)
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30_000 }).catch(() => {});
  await sleep(600);

  const emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) {
    // Try reloading once
    log("Email input not found, reloading...");
    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCF(page);
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30_000 }).catch(() => {});
    await sleep(800);
  }

  const emailEl2 = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl2) throw new Error("No email input on login page after retry");
  await emailEl2.click({ clickCount: 3 });
  await emailEl2.type(EMAIL, { delay: 50 });

  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("No password input on login page");
  await passEl.click({ clickCount: 3 });
  await passEl.type(PASSWORD, { delay: 50 });

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);
  await waitForCF(page);

  const afterUrl: string = await page.url();
  log(`After login → ${afterUrl}`);
  if (afterUrl.includes("/login")) {
    // May have landed on favicon or other redirect, check again
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForCF(page);
    const earnUrl: string = await page.url();
    if (earnUrl.includes("/login")) throw new Error("Login failed — redirected back to login");
    log(`Confirmed logged in → ${earnUrl}`);
  }
}

// ── Get current coin count ────────────────────────────────────────────────────
async function getCoins(page: any): Promise<number> {
  const text: string = await page.evaluate(() => {
    const el = (globalThis as any).document.querySelector(".topbar-pill strong");
    return el ? el.innerText.trim() : "0";
  }).catch(() => "0");
  return parseInt(text, 10) || 0;
}

// ── Get CSRF token from current page ─────────────────────────────────────────
async function getCsrf(page: any): Promise<string> {
  return page.evaluate(() => {
    const m = (globalThis as any).document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute("content") || "" : "";
  }).catch(() => "");
}

// ── Get LinkPays status from /earn page ───────────────────────────────────────
async function getLinkPaysStatus(page: any): Promise<{
  available: boolean; usage: string; cooldownSec: number; flashMsg: string;
}> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    // Find LinkPays card
    const cards = Array.from(doc.querySelectorAll("article.offer-card"));
    let lpCard: any = null;
    for (const c of cards as any[]) {
      const h = c.querySelector("h3")?.innerText || "";
      if (h.toLowerCase().includes("linkpays")) { lpCard = c; break; }
    }
    if (!lpCard) return { available: false, usage: "?", cooldownSec: 0, flashMsg: "" };

    const btn = lpCard.querySelector("button.button-primary[type='submit']");
    const available = !!btn && !btn.disabled;
    const usagePill = lpCard.querySelector(".status-pill")?.innerText || "?";
    const expireEl = lpCard.querySelector("[data-expire-seconds]");
    const cooldownSec = expireEl ? parseInt(expireEl.getAttribute("data-expire-seconds") || "0", 10) : 0;

    const flash = doc.querySelector(".flash-success, .flash-error")?.innerText || "";
    return { available, usage: usagePill, cooldownSec, flashMsg: flash };
  }).catch(() => ({ available: false, usage: "?", cooldownSec: 0, flashMsg: "" }));
}

// ── One full bypass cycle ─────────────────────────────────────────────────────
async function runOneCycle(page: any, cycleNum: number, net: { reqs: any[], ress: any[], bodies: Record<string,string> }): Promise<boolean> {
  log(`\n${"═".repeat(60)}`);
  log(`CYCLE ${cycleNum} START`);

  // Navigate to /earn
  await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);
  await sleep(1000);

  const coinsBefore = await getCoins(page);
  const status = await getLinkPaysStatus(page);
  log(`Coins: ${coinsBefore} | LP status: available=${status.available} usage="${status.usage}" cooldown=${status.cooldownSec}s flash="${status.flashMsg}"`);

  if (!status.available) {
    if (status.cooldownSec > 0) {
      log(`Cooldown active: ${status.cooldownSec}s remaining. Waiting...`);
      await sleep((status.cooldownSec + 5) * 1000);
      return false; // retry
    }
    log("LinkPays button not available and no cooldown. 24h limit or other issue.");
    return false;
  }

  // Get CSRF
  const csrf = await getCsrf(page);
  if (!csrf) throw new Error("No CSRF token found on /earn page");
  log(`CSRF: ${csrf.slice(0, 20)}...`);

  // Clear network capture
  net.reqs.length = 0; net.ress.length = 0;
  Object.keys(net.bodies).forEach(k => delete net.bodies[k]);

  // ── Step 1: Click the button → POST /earn/linkpays/start ─────────────────
  const clickTime = Date.now();
  log("Clicking 'Open LinkPays'...");
  const lpBtn = await page.$('button.button-primary[type="submit"]');
  if (!lpBtn) throw new Error("LinkPays button not found");
  await lpBtn.click();

  // Wait for navigation to linkpays.in
  log("Waiting for redirect to linkpays.in...");
  for (let i = 0; i < 20; i++) {
    await sleep(800);
    const u = page.url();
    if (u.includes("linkpays.in")) { log(`Arrived at linkpays.in: ${u}`); break; }
    if (i === 19) log(`WARNING: Did not reach linkpays.in in 16s. Current: ${u}`);
  }

  // ── Step 2: Capture linkpays.in page & extract proceed() target ──────────
  const linkpaysUrl = page.url();
  const linkpaysHtml = await page.content().catch(() => "");
  log(`linkpays.in URL: ${linkpaysUrl}`);

  // Extract the base64-encoded redirect target inside proceed()
  const proceedTarget: string = await page.evaluate(() => {
    const scripts = Array.from((globalThis as any).document.querySelectorAll("script"));
    for (const s of scripts as any[]) {
      const text = s.textContent || "";
      const m = text.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
      if (m) {
        try { return atob(m[1]); } catch { return ""; }
      }
    }
    return "";
  }).catch(() => "");
  log(`proceed() target (decoded): ${proceedTarget}`);

  // Get AppSession cookie from linkpays.in
  const linkpaysCookies = await page.cookies().catch(() => []);
  const appSession = linkpaysCookies.find((c: any) => c.name === "AppSession");
  log(`AppSession cookie: ${appSession?.value?.slice(0, 40) ?? "NOT FOUND"}`);

  // ── Step 3: Wait for the 3.5s auto-proceed + follow through ─────────────
  log("Waiting for linkpays.in proceed() to fire (4s)...");
  await sleep(4000);

  // Also call proceed() manually in case it didn't fire
  const proceedCalled: boolean = await page.evaluate(() => {
    if (typeof (globalThis as any).proceed === "function") {
      (globalThis as any).proceed();
      return true;
    }
    return false;
  }).catch(() => false);
  log(`proceed() manually called: ${proceedCalled}`);

  // Wait for navigation to ad site
  log("Waiting for redirect to ad site...");
  let adSiteUrl = "";
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const u = page.url();
    if (!u.includes("linkpays.in") && u !== linkpaysUrl) {
      adSiteUrl = u;
      log(`Arrived at ad site: ${adSiteUrl}`);
      break;
    }
  }

  if (!adSiteUrl) {
    log("WARNING: Did not leave linkpays.in. Trying direct navigation to proceed target...");
    if (proceedTarget) {
      // Set the cookie and navigate directly
      await page.evaluate(() => {
        const d = new Date();
        d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
        (globalThis as any).document.cookie = "user_verified=true; expires=" + d.toUTCString() + "; path=/";
      });
      await page.goto(proceedTarget, { waitUntil: "domcontentloaded", timeout: 30_000 });
      adSiteUrl = page.url();
      log(`Navigated directly to: ${adSiteUrl}`);
    }
  }

  // ── Step 4: Capture ad site (evspec.in / rank1st.in) ────────────────────
  const adSiteHtml = await page.content().catch(() => "");
  log(`Ad site HTML: ${adSiteHtml.length} chars, URL: ${page.url()}`);
  writeFileSync("/tmp/ad-site.html", adSiteHtml, "utf8");

  // Get all links on the ad site that point back to vektalnodes.in
  const adSiteData: any = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const allLinks = Array.from(doc.querySelectorAll("a[href]"))
      .map((a: any) => ({ href: a.href, text: a.innerText.trim().slice(0, 80) }));
    const vektalLinks = allLinks.filter((l: any) =>
      l.href.includes("vektalnodes") || l.href.includes("linkpays") || l.href.includes("earn")
    );
    const scripts = Array.from(doc.querySelectorAll("script")).map((s: any) => ({
      src: s.src || null, content: s.textContent?.slice(0, 3000) || "",
    }));
    const meta = Array.from(doc.querySelectorAll("meta[http-equiv], meta[name='refresh']"))
      .map((m: any) => ({ name: m.name || m.httpEquiv, content: m.content }));
    return { allLinks: allLinks.slice(0, 40), vektalLinks, scripts, meta };
  }).catch(() => ({}));

  log(`Ad site — total links: ${adSiteData.allLinks?.length ?? 0}, vektal-links: ${adSiteData.vektalLinks?.length ?? 0}`);

  console.log("\n=== AD SITE ANALYSIS ===");
  console.log(`URL: ${adSiteUrl}`);
  console.log("VEKTALNODES LINKS:", JSON.stringify(adSiteData.vektalLinks, null, 2));
  console.log("ALL LINKS:", JSON.stringify(adSiteData.allLinks, null, 2));
  console.log("META REFRESH:", JSON.stringify(adSiteData.meta, null, 2));
  console.log("INLINE SCRIPTS:");
  for (const s of (adSiteData.scripts ?? [])) {
    if (!s.src && s.content.trim().length > 30) {
      console.log("--- SCRIPT ---\n" + s.content + "\n--- END ---");
    }
  }
  console.log("EXTERNAL SCRIPTS:", (adSiteData.scripts ?? []).filter((s: any) => s.src).map((s: any) => s.src).join("\n"));

  // Check network for any vektalnodes callbacks FROM ad site
  console.log("\n=== NET REQUESTS FROM AD SITE ===");
  const adSiteReqs = net.reqs.filter(r =>
    !["googlesyndication","doubleclick","criteo","openx",".png",".jpg",".woff",".css",
      "fonts.g","cloudflareinsights","applixir","google-analytics","googletagmanager",
      "fundingchoices","adtrafficquality"].some(n => r.url.includes(n))
  );
  for (const req of adSiteReqs) {
    const res = net.ress.find(r => r.id === req.id);
    const body = net.bodies[req.id];
    console.log(`\n▶ ${req.method} ${req.url}`);
    if (req.redirectResponse) console.log(`  ↪ from: ${req.redirectResponse.url} [${req.redirectResponse.status}]`);
    if (req.postData) console.log(`  POST: ${req.postData}`);
    if (res) {
      console.log(`◀ ${res.status} ${res.mime}`);
      console.log(`  Res headers: ${JSON.stringify(res.headers).slice(0, 600)}`);
    }
    if (body && !body.includes("\x00")) console.log(`  Body:\n${body.slice(0, 2000)}`);
  }

  // ── Step 5: Watch for auto-redirect from ad site back to vektalnodes ─────
  log("Watching ad site for return redirect to vektalnodes.in (60s)...");
  let returnUrl = "";
  let prevUrl2 = page.url();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const u = page.url();
    if (u !== prevUrl2) {
      log(`[ad site] URL changed → ${u}`);
      prevUrl2 = u;
      if (u.includes("vektalnodes.in")) {
        returnUrl = u;
        log(`RETURNED TO VEKTALNODES.IN via redirect: ${u}`);
        break;
      }
    }
    // Scan network for any request back to vektalnodes.in
    const vektalReqs = net.reqs.filter(r =>
      r.url.includes("vektalnodes.in") && r.ts > clickTime && !r.url.includes("cdn-cgi")
    );
    if (vektalReqs.length > 0) {
      for (const r of vektalReqs) {
        log(`[net] Request back to vektalnodes: ${r.method} ${r.url}`);
      }
    }
  }

  // ── Step 6: If no auto-redirect, look for the return link ─────────────────
  if (!returnUrl) {
    log("No auto-redirect found. Looking for 'Continue', 'Get Reward', or return link...");

    // Try clicking any button that says Continue / Get / Claim / Proceed
    const returnBtn: string = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const btns = Array.from(doc.querySelectorAll("a[href], button"));
      for (const el of btns as any[]) {
        const text = (el.innerText || "").toLowerCase();
        const href = (el.href || "").toLowerCase();
        if (
          text.includes("continu") || text.includes("claim") || text.includes("get") ||
          text.includes("proceed") || text.includes("reward") || text.includes("return") ||
          href.includes("vektalnodes") || href.includes("earn")
        ) {
          return el.outerHTML.slice(0, 200);
        }
      }
      return "";
    }).catch(() => "");
    log(`Possible return button: ${returnBtn}`);

    // Try clicking it
    if (returnBtn) {
      const clickResult: boolean = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const btns = Array.from(doc.querySelectorAll("a[href], button"));
        for (const el of btns as any[]) {
          const text = (el.innerText || "").toLowerCase();
          const href = (el.href || "").toLowerCase();
          if (
            text.includes("continu") || text.includes("claim") || text.includes("get") ||
            text.includes("proceed") || text.includes("reward") || text.includes("return") ||
            href.includes("vektalnodes") || href.includes("earn")
          ) {
            (el as any).click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      log(`Return button clicked: ${clickResult}`);

      // Wait for navigation
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const u = page.url();
        if (u.includes("vektalnodes.in")) { returnUrl = u; log(`Navigated to: ${u}`); break; }
      }
    }
  }

  // ── Step 7: Also check network for the actual return URL ─────────────────
  const vektalNetReqs = net.reqs.filter(r =>
    r.url.includes("vektalnodes.in") && r.ts > clickTime &&
    !r.url.includes("cdn-cgi") && !r.url.includes(".css") && !r.url.includes(".js")
  );
  console.log("\n=== VEKTALNODES.IN REQUESTS AFTER CLICK ===");
  for (const req of vektalNetReqs) {
    const res = net.ress.find(r => r.id === req.id);
    const body = net.bodies[req.id];
    console.log(`▶ ${req.method} ${req.url}`);
    if (req.redirectResponse) console.log(`  ↪ from: ${req.redirectResponse.url} [${req.redirectResponse.status}]`);
    if (req.postData) console.log(`  POST: ${req.postData}`);
    if (res) {
      console.log(`◀ ${res.status} ${res.mime}`);
      console.log(`  Res headers: ${JSON.stringify(res.headers).slice(0, 600)}`);
    }
    if (body && !body.includes("\x00")) console.log(`  Body:\n${body.slice(0, 1000)}`);
  }

  // ── Step 8: Navigate to /earn and check if coins were credited ────────────
  log("Navigating to /earn to check for coin credit...");
  await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCF(page);
  await sleep(1500);

  const coinsAfter = await getCoins(page);
  const statusAfter = await getLinkPaysStatus(page);
  const earnHtmlAfter = await page.content().catch(() => "");
  writeFileSync("/tmp/earn-after-cycle.html", earnHtmlAfter, "utf8");

  log(`Coins BEFORE: ${coinsBefore} | Coins AFTER: ${coinsAfter} | Diff: +${coinsAfter - coinsBefore}`);
  log(`LP status after: available=${statusAfter.available} usage="${statusAfter.usage}" cooldown=${statusAfter.cooldownSec}s flash="${statusAfter.flashMsg}"`);

  const credited = coinsAfter > coinsBefore;
  if (credited) {
    log(`✅ CYCLE ${cycleNum} SUCCESS — earned ${coinsAfter - coinsBefore} coins (${coinsBefore} → ${coinsAfter})`);
  } else {
    log(`❌ CYCLE ${cycleNum} — No coins credited. Flash: "${statusAfter.flashMsg}"`);
    // Dump earn page state for debugging
    console.log("\n=== /earn PAGE AFTER RETURN (for debug) ===");
    console.log(earnHtmlAfter.slice(0, 6000));
  }

  return credited;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  if (!EMAIL || !PASSWORD) { console.error("Missing VEKTAL_EMAIL or VEKTAL_PASSWORD env"); process.exit(1); }

  log("=== LINKPAYS BYPASSER STARTING ===");
  const xvfb = await startXvfb();
  process.env.DISPLAY = DISPLAY_NUM;

  let browser: any;
  const cleanup = () => {
    log("Cleaning up...");
    try { browser?.close(); } catch {}
    xvfb.kill("SIGTERM");
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  log("Launching browser...");
  const { browser: b, page } = await connect({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--window-size=1280,900", "--disable-web-security"],
    customConfig: { chromePath: CHROMIUM_PATH },
    turnstile: true,
    connectOption: { defaultViewport: { width: 1280, height: 900 } },
  } as any);
  browser = b;
  log("Browser launched.");

  // Enable network tracking
  const net: { reqs: any[], ress: any[], bodies: Record<string,string> } = { reqs: [], ress: [], bodies: {} };
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  trackNet(cdp, "MAIN", net);

  // Track new tabs
  browser.on("targetcreated", async (target: any) => {
    const p = await target.page().catch(() => null);
    if (p && p !== page) {
      log(`[NEW TAB] ${target.url()}`);
      const c = await p.createCDPSession().catch(() => null);
      if (c) { await c.send("Network.enable").catch(() => {}); trackNet(c, "TAB", net); }
    }
  });

  // Login
  await login(page);

  // ── Main earn loop ────────────────────────────────────────────────────────
  let successCount = 0;
  let cycleNum = 0;

  while (successCount < MAX_DAILY_USES) {
    cycleNum++;
    try {
      const ok = await runOneCycle(page, cycleNum, net);
      if (ok) {
        successCount++;
        log(`Daily progress: ${successCount}/${MAX_DAILY_USES} completed`);
        if (successCount < MAX_DAILY_USES) {
          log(`Waiting ${COOLDOWN_MS / 1000}s cooldown...`);
          // Tick every 30s during cooldown
          for (let t = 0; t < COOLDOWN_MS; t += 30000) {
            await sleep(Math.min(30000, COOLDOWN_MS - t));
            const rem = Math.round((COOLDOWN_MS - t - 30000) / 1000);
            if (rem > 0) log(`[cooldown] ${rem}s remaining`);
          }
        }
      } else {
        // Not successful, wait 60s and retry
        log("Cycle not successful. Waiting 60s before retry...");
        await sleep(60_000);
      }
    } catch (err: any) {
      log(`Cycle ${cycleNum} ERROR: ${err.message}`);
      // Reload and retry
      await sleep(30_000);
    }
  }

  log(`ALL DONE — earned ${successCount * 12} coins today (${successCount} cycles)`);
  cleanup();
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
