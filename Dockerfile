# ColdGuard: one long-lived Node process serving the API, Socket.IO and the built SPA.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY simulator/package.json simulator/
COPY loadtest/package.json loadtest/
RUN npm ci
COPY . .
RUN npm run build -w web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production STATIC_DIR=/app/web/dist PORT=4000
COPY --from=build /app /app
RUN npm prune --omit=dev --workspaces --include-workspace-root || true
EXPOSE 4000
USER node
CMD ["node", "--import", "tsx", "server/src/index.ts"]
