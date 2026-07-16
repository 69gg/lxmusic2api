FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    LXMUSIC2API_CONFIG=/app/config.toml
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node LICENSE NOTICE ./
COPY --chown=node:node LICENSES ./LICENSES

RUN mkdir -p /app/data /app/downloads /app/.private \
  && chown -R node:node /app/data /app/downloads /app/.private

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
