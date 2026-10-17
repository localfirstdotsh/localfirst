# syntax=docker/dockerfile:1
# One image, three units (docs/RUNBOOK.md "Deployment shape"):
#   API             node dist/server.js        (the default command)
#   Metadata worker node dist/jobs/worker.js
#   Migration job   node dist/db/migrate.js    (reads MIGRATION_DATABASE_URL)
# Build from the repository root:  docker build -f backend/Dockerfile .

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install --global pnpm@12.4.1
WORKDIR /repo
# Manifests first, so dependency layers are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY runner/package.json runner/
RUN pnpm install --frozen-lockfile --filter @localfirst/backend...
COPY packages/contracts packages/contracts
COPY backend backend
RUN pnpm --filter @localfirst/contracts build && pnpm --filter @localfirst/backend build
# A self-contained backend with production dependencies only.
RUN pnpm --filter @localfirst/backend deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/backend/dist ./dist
COPY --from=build --chown=node:node /repo/backend/drizzle ./drizzle
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
