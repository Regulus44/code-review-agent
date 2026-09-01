FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter @coding-agent/api --prod /out

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3210

COPY --from=build /out/ ./

RUN mkdir -p /app/.data /workspaces \
    && useradd --system --uid 10001 --home-dir /app app \
    && chown -R app:app /app /workspaces

USER app

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3210/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]
