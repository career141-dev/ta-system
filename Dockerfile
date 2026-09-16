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
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
# The standalone server, its traced dependencies, and the static files.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3100
# Next writes its own server.js into the standalone output.
CMD ["node", "server.js"]
