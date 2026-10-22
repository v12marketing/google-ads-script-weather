# syntax=docker/dockerfile:1
#
# HomeDeliveryClaims.com service image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t hdc-app .
# (deploy/docker-compose.yml does this for you.)
#
# Only the files the build needs are copied, so a local .env, data/ or
# node_modules never ends up in an image layer.

ARG NODE_IMAGE=node:22-bookworm-slim

# Toolchain for native modules: better-sqlite3 downloads a prebuilt binary when
# one exists for this Node/platform and compiles from source otherwise.
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

# Production dependencies only; copied into the final image as-is.
FROM toolchain AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Full install and TypeScript build. The build compiles the setup scripts too, so
# they can run in the final image (which has no tsx): node dist/scripts/<name>.js
FROM toolchain AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    BOARD_CONFIG_PATH=/app/config/board.json
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# config/board.json is mounted read-only at run time. /data holds the SQLite
# database and cached claim files, and must be writable by the app user, who
# also runs the backups (dist/scripts/backup.js, which uses the image's tar).
RUN mkdir -p /app/config /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/server.js"]
