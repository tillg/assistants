# The Runtime: trigger watcher + loop driver.
#
# Node 24 to match the rest of the repository's toolchain (.nvmrc).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# curl is used by the compose healthcheck's sibling probe; node does the real check.
RUN addgroup -S runtime && adduser -S runtime -G runtime
USER runtime

CMD ["node", "--enable-source-maps", "dist/src/index.js"]
