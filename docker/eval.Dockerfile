# `pnpm eval` runs HERE and only here.
#
# This is the answer to "how do you keep the eval harness trustworthy": every
# golden number — recall, grounding-rejection rate, schema-rejection rate, cost,
# wall clock — comes from one rendering environment. Host runs are dev-only.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# pnpm is installed at the exact pinned version rather than through corepack.
# The corepack bundled in this Playwright image predates npm's current signing
# keys, so it dies resolving "latest stable" with `Cannot find matching keyid`
# before it ever reads packageManager. Pinning here also keeps the image
# reproducible, which is the entire reason the eval runs in it.
RUN npm install -g pnpm@10.34.5
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# Every workspace manifest, not just the two this image runs: the lockfile
# describes all of them, and --frozen-lockfile fails on any mismatch.
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ENV SUL_EVAL_CONTAINER=true
CMD ["pnpm", "eval"]
