# syntax=docker/dockerfile:1
# The public website (docs/operations/RUNBOOK.md "Staging on Render"). A self-contained Next.js server built
# with `output: 'standalone'`. Build from the repository root:  docker build -f apps/web/Dockerfile .
#
# Everything the site reads is set at run time (LOCALFIRST_*, see apps/web/.env.example); nothing about
# an environment is baked into the image, so one image serves staging and production.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.4.1
WORKDIR /repo
# Manifests first, so dependency layers are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @localfirst/web...
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @localfirst/contracts build \
 && NEXT_OUTPUT=standalone pnpm --filter @localfirst/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# The standalone tree mirrors the repository layout (the tracing root), so the server is apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
