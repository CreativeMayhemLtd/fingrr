# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./
RUN npm install --frozen-lockfile

# ── dev: hot-reload via tsx watch (source mounted as volume) ──────────────
FROM base AS dev
RUN npm install -g tsx
CMD ["tsx", "watch", "src/index.ts"]

# ── build: compile TypeScript ─────────────────────────────────────────────
FROM base AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── prod: minimal runtime, no dev deps ───────────────────────────────────
FROM node:22-alpine AS prod
WORKDIR /app
COPY package.json ./
RUN npm install --frozen-lockfile --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
