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
const DISPLAY_NUM = ":99";

if (!EMAIL || !PASSWORD) {
  console.error("[AFK Bot] VEKTAL_EMAIL and VEKTAL_PASSWORD must be set");
  process.exit(1);
}

function log(msg: string) {
  console.log(`[AFK Bot ${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startXvfb(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    log(`Starting Xvfb on display ${DISPLAY_NUM}...`);
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x800x24"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });

    xvfb.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) log(`[Xvfb] ${line}`);
    });

    xvfb.on("error", (err) => reject(err));

    setTimeout(() => {
      log("Xvfb started.");
      resolve(xvfb);
    }, 1500);
  });
}

async function waitForCloudflare(page: any, timeoutMs = 45_000) {
  log("Waiting for Cloudflare challenge to clear...");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url: string = page.url();
    const title: string = await page.title().catch(() => "");
    if (
      !title.toLowerCase().includes("just a moment") &&
      !url.includes("challenge") &&
      !url.includes("cf-")
    ) {
      log(`Cloudflare cleared. Current page: "${title}"`);
      return;
    }
    log(`Still on Cloudflare challenge — "${title}" — waiting...`);
    await sleep(2000);
  }
  log("Warning: Cloudflare may not have cleared within timeout.");
}

async function login(page: any) {
  log(`Navigating to ${SITE}/login`);
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCloudflare(page);

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

  await waitForCloudflare(page);
  log(`After login — current URL: ${page.url()}`);
}

async function ensureOnEarnPage(page: any) {
  const url: string = page.url();
  if (!url.includes("/earn")) {
    log(`Not on /earn (at ${url}), navigating...`);
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCloudflare(page);
    log(`Now at: ${page.url()}`);
  } else {
    log(`On earn page: ${url}`);
  }
}

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
        /* runs in browser context — DOM APIs available */
        const evt = new (globalThis as any).MouseEvent("mousemove", { bubbles: true, clientX: 640, clientY: 400 });
        (globalThis as any).document?.dispatchEvent(evt);
      });

      const cookies = await page.cookies().catch(() => [] as any[]);
      log(`[tick ${tick}] session cookies: ${cookies.length}`);
    } catch (err: any) {
      log(`[tick ${tick}] Error during keep-alive: ${err.message}`);
    }

    await sleep(30_000);
  }
}

async function main() {
  log("Starting AFK bot with puppeteer-real-browser...");

  const xvfb = await startXvfb();
  process.env.DISPLAY = DISPLAY_NUM;

  const cleanup = async (signal: string) => {
    log(`${signal} received — shutting down...`);
    try {
      await browser?.close();
    } catch {}
    xvfb.kill("SIGTERM");
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  let browser: any;

  try {
    const result = await connect({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,800",
        `--display=${DISPLAY_NUM}`,
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
    await keepAlive(page);
  } catch (err: any) {
    log(`Fatal error: ${err.message}`);
    try {
      await browser?.close();
    } catch {}
    xvfb.kill("SIGTERM");
    process.exit(1);
  }
}

main();
