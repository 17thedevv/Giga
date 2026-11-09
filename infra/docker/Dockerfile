# Immutable multi-architecture digest resolved from the official Node 22 image.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS api-build
WORKDIR /app
COPY apps/api/package*.json apps/api/
RUN npm ci --prefix apps/api --include=dev --no-audit --no-fund
COPY packages/contracts/ packages/contracts/
COPY apps/api/tsconfig*.json apps/api/
COPY apps/api/src/ apps/api/src/
RUN npm run build --prefix apps/api

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS web-build
WORKDIR /app
COPY apps/web/package*.json apps/web/
RUN npm ci --prefix apps/web --include=dev --no-audit --no-fund
COPY packages/contracts/ packages/contracts/
COPY apps/web/ apps/web/
RUN npm run build --prefix apps/web

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS api-dependencies
WORKDIR /app
COPY apps/api/package*.json apps/api/
RUN npm ci --prefix apps/api --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production PORT=3000 SERVE_WEB=true CHAT_ENABLED=false
WORKDIR /app
COPY --from=api-dependencies --chown=node:node /app/apps/api/node_modules/ apps/api/node_modules/
COPY --from=api-build --chown=node:node /app/apps/api/dist/ apps/api/dist/
COPY --from=api-build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=api-build --chown=node:node /app/packages/contracts/agent.js /app/packages/contracts/package.json packages/contracts/
COPY --from=web-build --chown=node:node /app/apps/web/dist/ apps/web/dist/
COPY --chown=node:node infra/docker/start.mjs infra/docker/migrate.mjs infra/docker/
USER node
EXPOSE 3000
CMD ["node", "infra/docker/start.mjs"]
