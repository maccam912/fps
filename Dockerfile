# syntax=docker/dockerfile:1

# ---- Stage 1: build the client bundle (Vite -> dist/client, assets baked in) ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY assets ./assets
RUN npm run build:client

# ---- Stage 2: lean runtime that serves client + Colyseus on one port ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g tsx@4 && npm cache clean --force

# tsconfig.json is required at runtime so tsx/esbuild honors experimentalDecorators.
# Colyseus's @type is a legacy decorator; without this esbuild emits TC39-standard
# decorators and the schema crashes on startup.
COPY tsconfig.json ./
COPY src ./src
COPY --from=builder /app/dist/client ./dist/client

# The single server process serves the static client AND the WebSocket on PORT.
ENV PORT=2567
EXPOSE 2567

USER node

CMD ["tsx", "src/server/index.ts"]
