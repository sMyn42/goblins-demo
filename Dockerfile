FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS tools
COPY . .

FROM tools AS builder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:worker

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /app/.data/images && chown -R node:node /app/.data
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
