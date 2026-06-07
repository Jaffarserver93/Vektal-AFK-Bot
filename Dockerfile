FROM node:24-slim

# ── System packages: Chromium + Xvfb + all required shared libraries ──────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── pnpm ──────────────────────────────────────────────────────────────────────
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# ── Workspace manifests (copied first so dependency install is layer-cached) ──
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.base.json ./

# scripts (the package we actually run)
COPY scripts/package.json ./scripts/
COPY scripts/tsconfig.json ./scripts/

# Other workspace packages — only their package.json is needed for pnpm install
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json         ./lib/api-spec/
COPY lib/api-zod/package.json          ./lib/api-zod/
COPY lib/db/package.json               ./lib/db/
COPY artifacts/api-server/package.json    ./artifacts/api-server/
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/

# ── Install all workspace dependencies ────────────────────────────────────────
# PUPPETEER_SKIP_DOWNLOAD prevents puppeteer from downloading its own Chromium
# since we use the system one installed above.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN pnpm install --frozen-lockfile

# ── Runner source ─────────────────────────────────────────────────────────────
COPY scripts/src ./scripts/src

# ── Runtime configuration ─────────────────────────────────────────────────────
# Override the Nix-store paths hardcoded in the runner with standard system paths.
ENV CHROMIUM_PATH=/usr/bin/chromium \
    XVFB_PATH=/usr/bin/Xvfb \
    NODE_ENV=production

# Required secrets — set these in Render's Environment tab:
#   VEKTAL_EMAIL      your vektalnodes.in login email
#   VEKTAL_PASSWORD   your vektalnodes.in login password
#   DATABASE_URL      (optional) Postgres connection string

CMD ["pnpm", "--filter", "@workspace/scripts", "run", "linkpays-runner"]
