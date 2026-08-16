# The worker needs a real browser, so it starts from the Playwright image whose
# tag is PINNED to the same version as package.json. Host Chromium (Windows) and
# container Chromium (Linux) render differently — font stacks especially — which
# moves bounding boxes and therefore pin coordinates. Anything producing numbers
# or screenshots must come from this image.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/worker apps/worker
COPY fixtures fixtures
COPY tsconfig.base.json ./

CMD ["pnpm", "--filter", "@sul/worker", "start"]
