# Agent Console: one container with the framework, API server and built UI.
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.0 --activate

# Framework (git submodule) first, so its build is cached between app changes.
COPY vendor/agents-framework ./vendor/agents-framework
RUN cd vendor/agents-framework && pnpm install --frozen-lockfile --config.strict-dep-builds=false && pnpm build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/console.db
EXPOSE 3000
USER node
# Fail the build (not the running container) if the app or framework is unreadable
# for the runtime user, e.g. when the build context came from a umask-077 checkout.
RUN node --import tsx -e "await import('./server/app.ts'); await import('unpdf'); console.log('module check: ok')"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
