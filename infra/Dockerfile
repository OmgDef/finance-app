FROM node:26.13.1-bookworm-slim AS workspace
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund
COPY apps/admin apps/admin
COPY apps/api apps/api
COPY apps/mobile/assets/theta.png apps/mobile/assets/
COPY apps/mobile/assets/app-icon/wallet/splash-logo.png apps/mobile/assets/app-icon/wallet/
COPY packages/contracts packages/contracts
RUN npm run build

FROM workspace AS api
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@teta/api"]

FROM node:26.13.1-bookworm-slim AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund --omit=dev --workspace @teta/api --workspace @teta/contracts
COPY apps/api apps/api
COPY apps/mobile/assets/theta.png apps/mobile/assets/
COPY apps/mobile/assets/app-icon/wallet/splash-logo.png apps/mobile/assets/app-icon/wallet/
COPY packages/contracts packages/contracts
USER node
CMD ["node", "apps/api/src/server.ts"]

FROM workspace AS admin-release
RUN npm run build -w @teta/admin -- --base /admin/

FROM scratch AS admin-static
COPY --from=admin-release /app/apps/admin/dist/ /

FROM caddy:2-alpine@sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9 AS gateway
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=workspace /app/apps/admin/dist /srv
