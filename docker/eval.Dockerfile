# `pnpm eval` runs HERE and only here.
#
# This is the answer to "how do you keep the eval harness trustworthy": every
# golden number — recall, grounding-rejection rate, schema-rejection rate, cost,
# wall clock — comes from one rendering environment. Host runs are dev-only.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY . .
ENV SUL_EVAL_CONTAINER=true
CMD ["pnpm", "eval"]
