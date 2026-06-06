/**
 * linkpays-probe.ts
 * Logs in, goes to /earn, intercepts ALL network traffic,
 * clicks "Open LinkPays", then prints every request/response
 * including redirects, tokens in URLs, and response bodies.
 */

import { connect } from "puppeteer-real-browser";
import { spawn, type ChildProcess } from "child_process";

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.VEKTAL_EMAIL ?? "";
const PASSWORD = process.env.VEKTAL_PASSWORD ?? "";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
const XVFB_PATH =
  process.env.XVFB_PATH ??
  "/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin/Xvfb";
const DISPLAY_NUM = ":98";

if (!EMAIL || !PASSWORD) {
  console.error("VEKTAL_EMAIL and VEKTAL_PASSWORD must be set");
  process.exit(1);
}

const SEP = "═".repeat(80);

function log(msg: string) {
  console.log(`[probe ${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x800x24"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
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

  await page
    .waitForSelector('input[type="email"], input[name="email"], input[id="email"]', { timeout: 30_000 })
    .catch(() => {});

  await sleep(600);

  const emailEl = await page.$('input[type="email"], input[name="email"], input[id="email"]');
  if (!emailEl) throw new Error("email input not found");
  await emailEl.click({ clickCount: 3 });
  await emailEl.type(EMAIL, { delay: 55 });

  const passEl = await page.$('input[type="password"], input[name="password"], input[id="password"]');
  if (!passEl) throw new Error("password input not found");
  await passEl.click({ clickCount: 3 });
  await passEl.type(PASSWORD, { delay: 55 });

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);

  await waitForCloudflare(page);
  log(`Logged in. URL: ${page.url()}`);
}

async function main() {
  log("Starting LinkPays network probe...");

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
      "--window-size=1280,800",
    ],
    customConfig: { chromePath: CHROMIUM_PATH },
    turnstile: true,
    connectOption: { defaultViewport: { width: 1280, height: 800 } },
  } as any);
  browser = b;

  log("Browser launched.");

  // ── CDP session to capture responses ──────────────────────────────────────
  const client = await page.createCDPSession();
  await client.send("Network.enable");

  const capturedRequests: Record<string, any> = {};
  const capturedResponses: Record<string, any> = {};
  const capturedBodies: Record<string, string> = {};

  client.on("Network.requestWillBeSent", (evt: any) => {
    capturedRequests[evt.requestId] = {
      requestId: evt.requestId,
      url: evt.request.url,
      method: evt.request.method,
      headers: evt.request.headers,
      postData: evt.request.postData,
      type: evt.type,
      initiator: evt.initiator?.type,
      redirectResponse: evt.redirectResponse
        ? {
            url: evt.redirectResponse.url,
            status: evt.redirectResponse.status,
            headers: evt.redirectResponse.headers,
          }
        : undefined,
      timestamp: new Date().toISOString(),
    };
  });

  client.on("Network.responseReceived", (evt: any) => {
    capturedResponses[evt.requestId] = {
      requestId: evt.requestId,
      url: evt.response.url,
      status: evt.response.status,
      statusText: evt.response.statusText,
      headers: evt.response.headers,
      mimeType: evt.response.mimeType,
      timestamp: new Date().toISOString(),
    };
  });

  client.on("Network.loadingFinished", async (evt: any) => {
    try {
      const body = await client.send("Network.getResponseBody", { requestId: evt.requestId });
      capturedBodies[evt.requestId] = body.body;
    } catch {
      // binary or unavailable
    }
  });

  // ── Track new tabs/windows opened by the button ───────────────────────────
  const newPages: any[] = [];
  browser.on("targetcreated", async (target: any) => {
    const p = await target.page().catch(() => null);
    if (p && p !== page) {
      log(`[NEW TAB] ${target.url()}`);
      newPages.push(p);
      const nc = await p.createCDPSession().catch(() => null);
      if (nc) {
        await nc.send("Network.enable").catch(() => {});
        nc.on("Network.requestWillBeSent", (evt: any) => {
          log(`[NEW TAB REQ] ${evt.request.method} ${evt.request.url}`);
          capturedRequests[`tab2_${evt.requestId}`] = {
            tab: "new",
            url: evt.request.url,
            method: evt.request.method,
            headers: evt.request.headers,
            postData: evt.request.postData,
            redirectResponse: evt.redirectResponse
              ? { url: evt.redirectResponse.url, status: evt.redirectResponse.status, headers: evt.redirectResponse.headers }
              : undefined,
          };
        });
        nc.on("Network.responseReceived", (evt: any) => {
          log(`[NEW TAB RES] ${evt.response.status} ${evt.response.url}`);
          capturedResponses[`tab2_${evt.requestId}`] = {
            tab: "new",
            url: evt.response.url,
            status: evt.response.status,
            headers: evt.response.headers,
          };
        });
      }
    }
  });

  // ── Login & navigate ───────────────────────────────────────────────────────
  await login(page);

  if (!page.url().includes("/earn")) {
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCloudflare(page);
  }

  log(`On earn page: ${page.url()}`);
  await sleep(2000);

  // ── Snapshot earn page HTML ────────────────────────────────────────────────
  const earnHtml = await page.content().catch(() => "");
  log(`Earn page HTML snippet:\n${earnHtml.slice(0, 3000)}`);

  // ── Find the button ────────────────────────────────────────────────────────
  const btn = await page.$(
    'button[type="submit"].button-primary, button.button.button-primary'
  );

  if (!btn) {
    log("WARNING: 'Open LinkPays' button not found by CSS. Trying text match...");
    const allBtns: string[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("button")).map(
        (b: any) => b.outerHTML
      )
    );
    log("All buttons found on page:\n" + allBtns.join("\n"));
  } else {
    log("Found 'Open LinkPays' button — clearing captured data and clicking...");
    Object.keys(capturedRequests).forEach((k) => delete capturedRequests[k]);
    Object.keys(capturedResponses).forEach((k) => delete capturedResponses[k]);
    Object.keys(capturedBodies).forEach((k) => delete capturedBodies[k]);

    await btn.click();
    log("Button clicked. Waiting 10s for network activity...");
    await sleep(10_000);
  }

  // ── Print full network report ──────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log("NETWORK CAPTURE REPORT — Open LinkPays");
  console.log(SEP);

  const requestIds = Object.keys(capturedRequests);
  log(`Total requests captured: ${requestIds.length}`);

  for (const id of requestIds) {
    const req = capturedRequests[id];
    const res = capturedResponses[id];
    const body = capturedBodies[id];

    console.log("\n" + "─".repeat(60));
    console.log(`▶ REQUEST [${id}]`);
    console.log(`  Method : ${req.method}`);
    console.log(`  URL    : ${req.url}`);
    console.log(`  Type   : ${req.type ?? "?"} | Initiator: ${req.initiator ?? "?"}`);
    if (req.postData) {
      console.log(`  Body   : ${req.postData}`);
    }
    if (req.redirectResponse) {
      console.log(`  ↪ REDIRECT FROM : ${req.redirectResponse.url}`);
      console.log(`    Status        : ${req.redirectResponse.status}`);
      console.log(`    Headers       : ${JSON.stringify(req.redirectResponse.headers, null, 4)}`);
    }
    console.log(`  Req Headers:\n${JSON.stringify(req.headers, null, 4)}`);
    if (res) {
      console.log(`◀ RESPONSE`);
      console.log(`  Status : ${res.status} ${res.statusText}`);
      console.log(`  URL    : ${res.url}`);
      console.log(`  Mime   : ${res.mimeType}`);
      console.log(`  Res Headers:\n${JSON.stringify(res.headers, null, 4)}`);
    }
    if (body) {
      const preview = body.length > 2000 ? body.slice(0, 2000) + "\n...[truncated]" : body;
      console.log(`  Body:\n${preview}`);
    }
  }

  // ── Current state of all pages ─────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log("FINAL PAGE URLS");
  console.log(SEP);
  console.log(`Main tab : ${page.url()}`);
  for (const p of newPages) {
    const u = await p.url().catch(() => "unknown");
    console.log(`New tab  : ${u}`);
    const h = await p.content().catch(() => "");
    if (h) console.log(`New tab HTML (first 2000):\n${h.slice(0, 2000)}`);
  }

  // ── Cookies ────────────────────────────────────────────────────────────────
  const cookies = await page.cookies().catch(() => [] as any[]);
  console.log("\n" + SEP);
  console.log("COOKIES");
  console.log(SEP);
  console.log(JSON.stringify(cookies, null, 2));

  log("Probe complete.");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
