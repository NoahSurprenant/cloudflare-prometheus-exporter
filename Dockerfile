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

# Expose the default wrangler dev port
EXPOSE 8787

# Create an entrypoint that passes only supported Worker variables into Wrangler. Keeping an
# explicit allowlist avoids leaking Kubernetes' injected service variables into .dev.vars.
RUN printf '#!/bin/sh\n\
    : > .dev.vars\n\
    env | grep -E "^(CLOUDFLARE_API_TOKEN|QUERY_LIMIT|SCRAPE_DELAY_SECONDS|TIME_WINDOW_SECONDS|METRIC_REFRESH_INTERVAL_SECONDS|ACCOUNT_LIST_CACHE_TTL_SECONDS|ZONE_LIST_CACHE_TTL_SECONDS|SSL_CERTS_CACHE_TTL_SECONDS|HEALTH_CHECK_CACHE_TTL_SECONDS|LOG_FORMAT|LOG_LEVEL|CF_ACCOUNTS|CF_ZONES|CF_FREE_TIER_ACCOUNTS|METRICS_DENYLIST|EXCLUDE_HOST|CF_HTTP_STATUS_GROUP|COLO_METRICS_PACKED_STORAGE|HOST_METRICS_ALLOWLIST|HOST_METRICS_DELAY_SECONDS|METRICS_PATH|DISABLE_UI|DISABLE_CONFIG_API|BASIC_AUTH_USER|BASIC_AUTH_PASSWORD)=" | while read -r line; do\n\
    echo "$line" >> .dev.vars\n\
    done\n\
    exec ./node_modules/.bin/wrangler dev --local --ip 0.0.0.0 "$@"\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh \
    && chown node:node /app/entrypoint.sh /app

USER node

ENTRYPOINT ["/app/entrypoint.sh"]
