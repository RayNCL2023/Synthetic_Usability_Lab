# Synthetic Usability Lab

Three AI personas browse a live site in parallel, narrating confusion as they
go. The output is a ranked, deduplicated list of usability issues, each one
pinned to the exact screenshot and quoted persona reaction that produced it.

Real moderated user testing costs thousands and takes weeks. This gives a
directional read in about two minutes. **It is a pre-launch smoke test, not a
replacement for user research** — see [EVALUATION.md](EVALUATION.md), which is
honest about what it cannot do.

---

## The 60-second quickstart

```bash
corepack enable pnpm
pnpm install
pnpm --filter @sul/worker exec playwright install chromium

docker compose up -d          # Postgres, Redis, MinIO
cp .env.example .env          # then add GEMINI_API_KEY

pnpm db:generate && pnpm db:migrate
pnpm seed import              # loads the four committed demo runs

pnpm dev                      # web :3000, api :3001, worker
```

Open <http://localhost:3000>. The recorded runs work immediately — **no API key
required**. To start a live run you also need `GEMINI_API_KEY` and a
`SUL_RUN_PASSCODE` in `.env`.

Run one persona from the CLI without any of the above:

```bash
pnpm run:cli -- --mock --persona=procurement    # offline, no key
pnpm run:cli -- --persona=procurement           # real, needs a key
```

---

## What it actually does

Per persona, per step: capture a viewport screenshot and build a compact
accessibility snapshot → send both to the model with a structured response
schema → **validate every element reference against the snapshot before the
action reaches the browser** → execute → persist → emit an event.

The three personas are not prompt variations. Each one changes the harness:

| Persona | Harness difference |
|---|---|
| Impatient mobile user | 390×844, touch, throttled network, low step budget |
| Screen-reader user | **Receives only the snapshot — never a screenshot** |
| Sceptical procurement manager | Desktop, high patience, hunting price/security/terms |

The screen-reader persona's architectural difference is what makes it credible
rather than cosmetic: if the accessibility tree is unnavigable, it genuinely
fails. On the committed Hacker News run, **both findings came from that persona
alone** while the sighted personas saw nothing.

## Grounding

The claim the whole product rests on is that no finding is invented. That is
enforced in code, not in the prompt:

- Every snapshot node is stamped with a **step-namespaced ref** (`s3e12`) and
  all prior stamps are cleared. A ref quoted from an earlier step therefore
  resolves to nothing instead of silently resolving to a *different* element.
- The model may only reference refs in the current snapshot. Unknown ref →
  retry once with the error surfaced → force a give-up. Every rejection
  increments `grounding_rejection_rate`.
- `schema_rejection_rate` is tracked separately, because the two providers
  differ structurally in whether enums are enforced.

## Documents

| File | What is in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Diagram, agent loop, grounding, event contract |
| [EVALUATION.md](EVALUATION.md) | Whether synthetic feedback is valid, and where the numbers land |
| [COSTS.md](COSTS.md) | Measured cost and latency, and the levers |
| [DEVIATIONS.md](DEVIATIONS.md) | Every departure from the spec, and why |
| [PROGRESS.md](PROGRESS.md) | Build log by subsystem |

## Environment

Every variable is documented in [`.env.example`](.env.example). Each service
validates its own slice at boot and **exits naming the missing variable** —
there are no silent defaults for anything that costs money or touches a live
site.

The ones that matter:

| Variable | Why |
|---|---|
| `GEMINI_API_KEY` | Live runs only. Demo replay never needs it. |
| `SUL_PROVIDER` | `gemini` (default) or `anthropic` |
| `SUL_GEMINI_RPM` | **Shared across all three persona workers**, not per worker |
| `SUL_RUN_PASSCODE` | Unset disables live runs entirely — fails closed |
| `SUL_GLOBAL_DAILY_RUN_CAP` | Fails closed; visitors are sent to the demo |
| `SUL_MAX_*` | Per-run caps on steps, model calls, wall clock, and cost |

## Safety

Respects `robots.txt` by default. Honours a domain denylist. Rate-limits per
domain. Sets an identifiable User-Agent. **Never** fills forms with real data,
attempts a login, or proceeds past a payment step. Bot walls and CAPTCHAs are
detected and reported as `blocked` — never solved.

Preflight runs before a job is queued: ~3s, zero model spend, and it turns the
most common failure into a legible message instead of three personas
independently discovering a bot wall a minute later.

## Testing

```bash
pnpm test        # unit + integration (Postgres/Redis tests self-skip if down)
pnpm typecheck
pnpm eval        # golden eval — see below
```

`pnpm eval` runs **inside the pinned Linux Playwright image** and nowhere else.
Host Chromium and container Chromium render differently — font stacks
especially — which moves bounding boxes and therefore pin coordinates. For a
product whose output *is* annotated screenshots, that is not cosmetic. Host runs
are dev-only.

## Deploying the demo to Vercel

The demo is standalone. `/demo/[slug]` reads the committed JSON fixtures and is
prerendered at build time — **no API, worker, Postgres, Redis, or S3 at
runtime**, and **no environment variables at all**.

### Click by click

1. Push this repo to GitHub.
2. Go to <https://vercel.com/new> and click **Import** next to the repository.
3. On the configure screen, **change nothing**:
   - Framework Preset → `Next.js` (detected)
   - Root Directory → `./` (leave it — `vercel.json` at the repo root points the
     build at `apps/web`)
   - Build and Output Settings → leave collapsed; `vercel.json` supplies them
   - Environment Variables → **add none**
4. Click **Deploy**.

That is the whole procedure. The build runs
`pnpm install --frozen-lockfile && pnpm --filter @sul/web build`, and you get
the landing page plus four prerendered replays. Hacker News is first.

Verify it worked: the deployment's `/` should list four recorded runs, and
`/demo/hacker-news` should replay with screenshots. If the landing page shows a
run form, live runs were switched on by accident — see below.

### Turning live runs on later

Live runs are off unless **both** of these are set in Vercel → Settings →
Environment Variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_ENABLE_LIVE_RUNS` | `true` |
| `NEXT_PUBLIC_API_URL` | your deployed API's URL |

With either missing, the form is not rendered at all rather than posting into
the void. Redeploy after adding them.

### The backend, when you want it

Fly.io for `api` and `worker` — both need Chromium and real memory, so
serverless is a poor fit — plus Neon or Fly Postgres, Upstash Redis, and
Cloudflare R2.

```bash
fly deploy -c fly.api.toml
fly deploy -c fly.worker.toml
```

`auto_stop_machines` is deliberately off on the worker: a queued job with no
worker awake would sit until something else woke it.
