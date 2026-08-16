# The API runs preflight, which drives a browser, so it needs the same pinned
# image as the worker rather than a bare node base.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/worker apps/worker
COPY apps/api apps/api
COPY fixtures fixtures
COPY tsconfig.base.json ./

EXPOSE 3001
CMD ["pnpm", "--filter", "@sul/api", "start"]
