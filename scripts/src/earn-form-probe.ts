/**
 * earn-form-probe.ts
 * Extracts:
 * 1. The full <form> containing "Open LinkPays" (action URL, hidden fields, CSRF)
 * 2. Full app.js source code via browser (bypasses Cloudflare)
 * 3. What POST is actually sent when button is clicked, full server response
 * 4. Any redirect chain after the POST
 */

import { connect } from "puppeteer-real-browser";
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.VEKTAL_EMAIL ?? "";
const PASSWORD = process.env.VEKTAL_PASSWORD ?? "";
const CHROMIUM_PATH =
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const XVFB_PATH =
  "/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin/Xvfb";
const DISPLAY_NUM = ":97";

function log(msg: string) { console.log(`[probe ${new Date().toISOString()}] ${msg}`); }
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x900x24"], {
      stdio: ["ignore", "ignore", "pipe"], detached: false,
    });
    xvfb.on("error", reject);
    setTimeout(() => resolve(xvfb), 1500);
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
  log("=== EARN FORM + APP.JS PROBE ===");
  const xvfb = await startXvfb();
  process.env.DISPLAY = DISPLAY_NUM;

  let browser: any;
  const cleanup = () => { try { browser?.close(); } catch {} xvfb.kill("SIGTERM"); };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const { browser: b, page } = await connect({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900"],
    customConfig: { chromePath: CHROMIUM_PATH },
    turnstile: true,
    connectOption: { defaultViewport: { width: 1280, height: 900 } },
  } as any);
  browser = b;
  log("Browser launched.");

  // CDP for network capture
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");

  const requests: any[] = [];
  const responses: any[] = [];
  const bodies: Record<string, string> = {};

  cdp.on("Network.requestWillBeSent", (evt: any) => {
    const url = evt.request.url;
    if (!url.includes("challenge-platform") && !url.includes("googlesyndication") && !url.includes("doubleclick") && !url.includes("gravatar") && !url.includes("criteo") && !url.includes(".png") && !url.includes(".jpg") && !url.includes(".woff") && !url.includes("fonts.g"))
      log(`→ ${evt.request.method} ${url.slice(0, 140)} postData=${evt.request.postData ? JSON.stringify(evt.request.postData).slice(0,200) : ""}`);
    requests.push({
      id: evt.requestId, url, method: evt.request.method,
      headers: evt.request.headers, postData: evt.request.postData ?? null,
      type: evt.type, redirect: evt.redirectResponse ?? null, ts: Date.now(),
    });
  });
  cdp.on("Network.responseReceived", (evt: any) => {
    const url = evt.response.url;
    if (!url.includes("challenge-platform") && !url.includes("googlesyndication") && !url.includes("doubleclick") && !url.includes("gravatar") && !url.includes("criteo") && !url.includes(".png") && !url.includes(".jpg") && !url.includes(".woff") && !url.includes("fonts.g"))
      log(`← ${evt.response.status} ${url.slice(0, 140)}`);
    responses.push({
      id: evt.requestId, url, status: evt.response.status,
      headers: evt.response.headers, mime: evt.response.mimeType,
    });
  });
  cdp.on("Network.loadingFinished", async (evt: any) => {
    try {
      const r = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
      bodies[evt.requestId] = r.body;
    } catch {}
  });

  // ── Login ─────────────────────────────────────────────────────────────────
  await login(page);
  if (!page.url().includes("/earn")) {
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCloudflare(page);
  }
  await sleep(1500);

  // ── 1. Extract FULL /earn page HTML ──────────────────────────────────────
  log("Extracting full /earn HTML...");
  const fullHtml: string = await page.content();
  writeFileSync("/tmp/earn-page-full.html", fullHtml, "utf8");
  log(`Full earn HTML saved: ${fullHtml.length} chars → /tmp/earn-page-full.html`);

  // ── 2. Find the LinkPays form ─────────────────────────────────────────────
  const formData: any = await page.evaluate(() => {
    const forms = Array.from((globalThis as any).document.querySelectorAll("form"));
    return forms.map((f: any) => ({
      action: f.action,
      method: f.method,
      outerHtml: f.outerHTML,
      inputs: Array.from(f.querySelectorAll("input, select, textarea, button")).map((el: any) => ({
        tag: el.tagName, type: el.type, name: el.name, value: el.value,
        text: el.innerText?.slice(0, 80), disabled: el.disabled, outerHtml: el.outerHTML,
      })),
    }));
  });

  console.log("\n\n══════════════ ALL FORMS ON /earn ══════════════");
  for (const form of formData) {
    console.log(`\n── FORM: action=${form.action} method=${form.method}`);
    console.log(`   outerHTML:\n${form.outerHtml.slice(0, 2000)}`);
    console.log(`   Inputs/buttons:`);
    for (const inp of form.inputs) {
      console.log(`     [${inp.tag}] type=${inp.type} name=${inp.name} value=${inp.value} text=${inp.text} disabled=${inp.disabled}`);
    }
  }

  // ── 3. Extract LinkPays button form's EXACT details ──────────────────────
  const linkpaysFormDetails: any = await page.evaluate(() => {
    const btns = Array.from((globalThis as any).document.querySelectorAll("button"));
    const lpBtn = btns.find((b: any) => b.innerText.includes("Open LinkPays"));
    if (!lpBtn) return { found: false };
    const form: any = (lpBtn as any).closest("form");
    if (!form) return { found: true, btnHtml: (lpBtn as any).outerHTML, noForm: true };
    const inputs = Array.from(form.querySelectorAll("input[type=hidden]"));
    return {
      found: true,
      btnHtml: (lpBtn as any).outerHTML,
      btnDisabled: (lpBtn as any).disabled,
      formAction: form.action,
      formMethod: form.method,
      formOuterHtml: form.outerHTML,
      formHiddenFields: inputs.map((i: any) => ({ name: i.name, value: i.value })),
      formEnctype: form.enctype,
      formTarget: form.target,
    };
  });

  console.log("\n══════════════ LINKPAYS BUTTON FORM ══════════════");
  console.log(JSON.stringify(linkpaysFormDetails, null, 2));

  // ── 4. Get full app.js via browser ───────────────────────────────────────
  log("Fetching app.js via browser evaluate...");
  const appJsUrl = "https://vektalnodes.in/public/js/app.js?v=20260527-create-no-reward-1";
  const appJsBody: string = await page.evaluate(async (url: string) => {
    const res = await fetch(url);
    return res.text();
  }, appJsUrl).catch((e: any) => "FETCH_ERROR: " + e.message);

  writeFileSync("/tmp/earn-app.js", appJsBody, "utf8");
  log(`app.js fetched: ${appJsBody.length} chars → /tmp/earn-app.js`);

  // ── 5. Search app.js for cooldown/linkpays logic ─────────────────────────
  console.log("\n══════════════ APP.JS — LINKPAYS/COOLDOWN SECTION ══════════════");
  const terms = ["linkpay", "cooldown", "expire", "300", "timer", "setTimeout", "setInterval", "disabled", "earn", "claim", "reward", "coin", "credit", "applixir", "device"];
  for (const term of terms) {
    const idx = appJsBody.toLowerCase().indexOf(term.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 200);
      const end = Math.min(appJsBody.length, idx + 500);
      console.log(`\n─── FOUND: "${term}" at idx ${idx} ───`);
      console.log(appJsBody.slice(start, end));
    }
  }

  // ── 6. Clear network, then do the actual form submission ─────────────────
  log("Clearing network capture. About to click 'Open LinkPays'...");
  requests.length = 0;
  responses.length = 0;
  Object.keys(bodies).forEach(k => delete bodies[k]);

  // Intercept the form submit before it navigates away
  await page.evaluateOnNewDocument(() => {}); // no-op
  await page.evaluate(() => {
    const forms = Array.from((globalThis as any).document.querySelectorAll("form"));
    for (const form of forms as any[]) {
      const btn = form.querySelector("button");
      const hasLP = btn && btn.innerText.includes("Open LinkPays");
      if (hasLP) {
        (globalThis as any)._lpForm = form;
        (globalThis as any)._lpFormAction = form.action;
        (globalThis as any)._lpFormMethod = form.method;
        form.addEventListener("submit", () => {
          console.log("[FORM_SUBMIT] action=" + form.action + " method=" + form.method);
          const fd = new (globalThis as any).FormData(form);
          const entries: Record<string,string> = {};
          fd.forEach((v: any, k: string) => { entries[k] = String(v); });
          console.log("[FORM_SUBMIT_DATA] " + JSON.stringify(entries));
        });
      }
    }
  });

  // Listen for console messages from page
  page.on("console", (msg: any) => {
    const text = msg.text();
    if (text.includes("FORM_SUBMIT") || text.includes("FETCH") || text.includes("XHR"))
      log(`[PAGE_CONSOLE] ${text}`);
  });

  // Track any new tabs
  const newTabUrls: string[] = [];
  browser.on("targetcreated", async (target: any) => {
    const newPage = await target.page().catch(() => null);
    if (newPage && newPage !== page) {
      const url = await newPage.url().catch(() => target.url());
      log(`[NEW TAB] ${url}`);
      newTabUrls.push(url);
      // Wait for it to load and capture its URL chain
      await sleep(5000);
      const finalUrl = await newPage.url().catch(() => "?");
      const finalTitle = await newPage.title().catch(() => "?");
      const finalHtml = await newPage.content().catch(() => "");
      log(`[NEW TAB FINAL] url=${finalUrl} title=${finalTitle}`);
      console.log(`\n══ NEW TAB HTML (first 3000): ══\n${finalHtml.slice(0, 3000)}`);
      // Navigate through it
      let prevUrl = finalUrl;
      for (let i = 0; i < 12; i++) {
        await sleep(3000);
        const u = await newPage.url().catch(() => "?");
        if (u !== prevUrl) {
          log(`[NEW TAB REDIRECT] → ${u}`);
          prevUrl = u;
        }
      }
      const ultimateHtml = await newPage.content().catch(() => "");
      const ultimateUrl = await newPage.url().catch(() => "?");
      log(`[NEW TAB ULTIMATE] url=${ultimateUrl}`);
      console.log(`\n══ NEW TAB ULTIMATE HTML (first 3000): ══\n${ultimateHtml.slice(0, 3000)}`);
    }
  });

  // Now click the button
  const lpBtn = await page.$('button.button-primary[type="submit"]');
  if (!lpBtn) {
    log("WARN: 'Open LinkPays' button not found, searching all buttons...");
    const allBtns: string[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("button")).map((b: any) => b.outerHTML)
    );
    console.log("All buttons:\n" + allBtns.join("\n"));
  } else {
    const btnText: string = await page.evaluate((el: any) => el.innerText, lpBtn);
    const btnDisabled: boolean = await page.evaluate((el: any) => el.disabled, lpBtn);
    log(`Clicking button: "${btnText.trim()}" disabled=${btnDisabled}`);
    await lpBtn.click();
    log("Button clicked. Watching for 40s...");
  }

  // Watch for 40s
  for (let t = 0; t < 40; t += 2) {
    await sleep(2000);
    const url: string = await page.url();
    if (t % 10 === 0) log(`[t+${t+2}s] main=${url} newTabs=${newTabUrls.length}`);
  }

  // ── PRINT FULL NETWORK CAPTURE ────────────────────────────────────────────
  const SEP = "═".repeat(80);
  console.log("\n" + SEP);
  console.log(`NETWORK AFTER BUTTON CLICK — ${requests.length} requests`);
  console.log(SEP);

  for (const req of requests) {
    const res = responses.find(r => r.id === req.id);
    const body = bodies[req.id];
    const noise = ["googlesyndication", "doubleclick", "google-analytics", "googletagmanager",
      "criteo", "openx", "gravatar", "cloudflareinsights", "fundingchoices", ".png", ".jpg",
      ".gif", ".woff", ".css", "challenge-platform", "fonts.g", "applixir.app"];
    if (noise.some(n => req.url.includes(n))) continue;

    console.log("\n" + "·".repeat(60));
    console.log(`▶ ${req.method} ${req.url}`);
    console.log(`  type=${req.type} | redirect=${req.redirect ? req.redirect.url + " " + req.redirect.status : "none"}`);
    if (req.postData) console.log(`  POST: ${req.postData}`);
    console.log(`  Req headers: ${JSON.stringify(req.headers).slice(0, 500)}`);
    if (res) {
      console.log(`◀ ${res.status} ${res.mime}`);
      console.log(`  Res headers: ${JSON.stringify(res.headers).slice(0, 500)}`);
    }
    if (body && !body.includes("\x00")) {
      console.log(`  Body:\n${body.slice(0, 3000)}`);
    }
  }

  console.log("\n" + SEP);
  console.log("END OF PROBE");
  console.log(SEP);

  cleanup();
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
