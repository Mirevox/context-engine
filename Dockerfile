# syntax=docker/dockerfile:1.7
# Multi-stage build: compile TypeScript, run Node 22 + git with a non-root user.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.4-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 mirevox \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/mirevox --shell /usr/sbin/nologin mirevox \
  && mkdir -p /data /repos \
  && chown -R mirevox:mirevox /data /repos

WORKDIR /app
ENV NODE_ENV=production \
    MIREVOX_CONTEXT_DIR=/data \
    CONTEXT_ENGINE_HOST=0.0.0.0 \
    CONTEXT_ENGINE_PORT=7437

COPY --from=build --chown=mirevox:mirevox /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mirevox:mirevox /app/node_modules ./node_modules
COPY --from=build --chown=mirevox:mirevox /app/dist ./dist

USER mirevox
# Host-mounted clones are owned by the host UID; allow git reads under /repos.
RUN git config --global --add safe.directory '*'
EXPOSE 7437
VOLUME ["/data", "/repos"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=8s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONTEXT_ENGINE_PORT||7437)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "serve-http"]
