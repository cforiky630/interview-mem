FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=true
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm run build && node deploy/check-build.mjs

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 UV_THREADPOOL_SIZE=8
COPY --from=build --chown=node:node /app/.next-build/standalone ./
COPY --from=build --chown=node:node /app/.next-build/static ./.next-build/static
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/deploy/migrate.mjs ./deploy/migrate.mjs
COPY --from=build --chown=node:node /app/src/db/postgres.mjs ./src/db/postgres.mjs
COPY --from=build --chown=node:node /app/src/server/config.mjs ./src/server/config.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node deploy/migrate.mjs && exec node server.js"]
