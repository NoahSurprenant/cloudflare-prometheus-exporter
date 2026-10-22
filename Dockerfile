# Stage 1: Install dependencies with bun
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies using bun
RUN bun install --frozen-lockfile

# Stage 2: Runtime with Node.js LTS
FROM node:24-slim AS runtime

WORKDIR /app

# Install CA certificates for Cloudflare API calls. Wrangler is installed from the lockfile and
# invoked from node_modules so the runtime cannot drift independently of the application.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies from bun stage
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy application source
COPY --chown=node:node package.json wrangler.jsonc tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node run.mjs ./

# Bundle the Worker once at build time (no Cloudflare account needed for a dry run); run.mjs serves
# dist/worker.js.
RUN ./node_modules/.bin/wrangler deploy --dry-run --outdir dist \
    && rm -rf .wrangler

# The Worker's port
EXPOSE 8787

# run.mjs passes only an allowlist of Worker variables from the environment, so Kubernetes' injected
# service variables never reach the Worker.
RUN chown node:node /app

USER node

ENTRYPOINT ["node", "run.mjs"]
