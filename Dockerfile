# syntax=docker/dockerfile:1

# MailCheap as a standalone Next.js server: no dev dependencies, running as a non-root user.
# Build: docker build -t mailcheap .   Run: docker-compose.yml, or the README's "Docker" section.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
	NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No secrets needed: instrumentation.js checks the config when the server starts. The public pages, the docs and
# next/image's CDN host read MAILCHEAP_CLOUD, APP_URL and IMAGES_CDN_URL at build time, so pass those as build args.
ARG MAILCHEAP_CLOUD APP_URL IMAGES_CDN_URL
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0

# The standalone server serves public/ and .next/static once they sit next to it. Share images read the fonts in
# assets/ and the logos in public/ from disk at runtime.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/assets ./assets

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.js"]
