# The TA System, built once and run as a small image.
#
# Built in three stages so the image that runs carries neither the source nor
# the build tools: install, build, then copy only Next's standalone output.
# Nothing here holds a secret — every value comes from the environment at run
# time (see docs/HOSTING.md), so the image can be rebuilt by anyone.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Clerk's publishable key is public and is baked into the browser bundle.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# Next salts every server action's id with this key, and generates a random one
# per build when it is not set — so each deploy renamed every button's action,
# and a page left open from before the deploy did nothing when clicked ("Failed
# to find Server Action"). A fixed key keeps the ids of unchanged actions stable.
# Build stage only: the image that runs reads the same value from its env file.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
# Which commit this image is — shown on the sign-in page and in the user menu,
# so anyone can tell which release is live. The pipeline passes the commit.
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
# The standalone server, its traced dependencies, and the static files.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The Claude Code CLI, for research and suggestions on the owner's Claude
# subscription (src/lib/claudeSub.ts). Idle unless CLAUDE_CODE_OAUTH_TOKEN and
# C141_CLAUDE_SUB_TASKS are set; the app falls back to OpenRouter without it.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
# LibreOffice (Writer only, no GUI), so a Word CV opens in the app's PDF viewer
# instead of only downloading (src/lib/wordToPdf.ts, 25 Sep). Carlito and
# Caladea are metric twins of Calibri and Cambria, so a CV written in those
# keeps its line and page breaks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea \
  && rm -rf /var/lib/apt/lists/*
USER node
EXPOSE 3100
# Next writes its own server.js into the standalone output.
CMD ["node", "server.js"]
