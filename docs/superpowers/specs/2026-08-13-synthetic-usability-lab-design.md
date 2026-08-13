# Synthetic Usability Lab — Design

**Date:** 2026-08-13
**Status:** Awaiting review

---

## 1. What we are building

A user submits a URL and a goal. Three AI personas browse the live site headlessly in
parallel, narrating confusion as they go. The UI streams their progress. The output is a
ranked, deduplicated list of usability issues, each pinned to the exact screenshot and
quoted persona reaction that produced it.

The product claim is a directional read in ninety seconds, against a real alternative
(moderated user testing) that costs thousands and takes weeks. Vague advice is a product
failure, not a minor quality issue — every design decision below serves specificity and
groundedness over breadth.

**This is a pre-launch smoke test, not a replacement for user research.** That framing is
load-bearing and appears in the UI, the README, and EVALUATION.md.

---

## 2. Constraints that shape the architecture

These are not requirements to satisfy late; each one changes a structural decision.

| # | Constraint | Structural consequence |
|---|---|---|
| C1 | Every claim must be grounded in the current snapshot | Ref stamping + a validator that runs before any action executes (§6) |
| C2 | Hard budget per run: steps, model calls, wall-clock, dollars | A `RunBudget` object threaded through the loop; abort returns partial results (§11) |
| C3 | Consent and ethics | Preflight gate before enqueue; no form fill, no login, no payment (§10) |
| C4 | Degrade gracefully on blocked sites | Bot-wall detection is a first-class outcome, not an error path (§10) |
| C5 | Deterministic replay | `run_events` as an append-only log; every view re-renders from it (§12) |

---

## 3. Architecture

```
                      ┌─────────────┐
   browser  ◄────WS───┤  apps/api   │──REST──► Postgres (Drizzle)
      │               │  (Fastify)  │◄─sub──┐
      │ POST /runs    └──────┬──────┘       │
      └──────────────────────┘              │ Redis pub/sub  `run:<id>`
                             │ BullMQ       │
                             ▼              │
                   ┌──────────────────┐     │
                   │  apps/worker     ├─────┘
                   │  FlowProducer    │
                   │   ├─ persona A ──┼──► Playwright ctx ──► S3/MinIO (screenshots)
                   │   ├─ persona B ──┤
                   │   ├─ persona C ──┤
                   │   └─ aggregate ──┼──► clustering → issues
                   └──────────────────┘
```

`packages/shared` holds Zod schemas, derived TS types, the event contract, persona
definitions, and the pricing table. API, worker, and web all import it. There is exactly
one definition of every shared shape.

### Repo layout

```
apps/web        Next.js App Router, Tailwind, Framer Motion, Zustand
apps/api        Fastify — REST + WebSocket
apps/worker     BullMQ consumers, Playwright driver, agent loop, clustering
packages/shared Zod schemas, types, events, personas, pricing, cost accounting
fixtures/badsite Static site with planted defects; CI target and eval ground truth
```

### Process boundaries

The worker owns the browser and the model calls. The API owns the socket and never
touches Playwright. They communicate only through Postgres (durable) and Redis pub/sub
(live) — never direct RPC. This is what lets the worker crash without taking live
viewers' sockets down, and what makes `/demo/[slug]` possible with no worker running.

---

## 4. Data model

Drizzle + Postgres. All tables defined as Zod schemas in `packages/shared` with types
derived via `z.infer`.

```
runs              id, url, goal, status, created_at, finished_at,
                  total_cost_cents, total_tokens, abort_reason,
                  model_config_json      -- which models/effort produced this run
persona_runs      id, run_id, persona_key, status, current_action_label,
                  step_count, outcome
steps             id, persona_run_id, index, url, screenshot_key, snapshot_json,
                  action_json, narration, reasoning, latency_ms,
                  tokens_in, tokens_out, cache_write_tokens, cache_read_tokens,
                  stop_reason, model_id
observations      id, step_id, persona_run_id, severity, category, element_ref,
                  element_description, quote, viewport_box (x/y/w/h)
issues            id, run_id, title, description, severity, category, rank,
                  recommendation
issue_observations  issue_id, observation_id      -- join
run_events        id, run_id, seq, type, payload_json, ts        -- §12
```

`outcome` ∈ `goal_achieved | gave_up | blocked | capped | error`.

Two additions to the brief's sketch, both load-bearing:

- **`run_events`** — required by catch-up replay (§12) and deterministic re-render (C5).
- **Per-step cache token columns and `model_id`** — cost accounting is wrong without
  them (§7), and `model_id` per step is what makes the eval matrix sweep analysable.
- **`stop_reason` per step** — the validator branches on it (§5.4).

---

## 5. Model layer

### 5.1 The seam

```ts
interface ModelClient {
  decide(input: DecideInput): Promise<DecideResult>;   // agent loop
  cluster(input: ClusterInput): Promise<ClusterResult>; // aggregation
}
```

One real implementation (`AnthropicModelClient`) and one test double
(`RecordedModelClient`, replaying committed fixtures). The interface exists for two
concrete reasons, not for provider-agnosticism: a single choke point for cost accounting,
and a seam for deterministic tests. Three call sites exist on day one — agent loop,
clustering, tests — which clears the "no abstraction until three call sites" bar.

### 5.2 Model selection — split by call site

The two calls are different kinds of work, so they get different models:

| Call site | Model | Effort | Why |
|---|---|---|---|
| Agent loop (per step) | `claude-sonnet-5` | `low` / `medium` | Selection against a six-way action enum plus short narration. This is classification against a bounded set, not reasoning. |
| Clustering (once per run) | `claude-opus-5` | `high` | Cross-persona semantic dedup and severity judgement over the full observation set — genuinely a reasoning task, and it runs once. |

Both env-configurable (`SUL_LOOP_MODEL`, `SUL_LOOP_EFFORT`, `SUL_CLUSTER_MODEL`,
`SUL_CLUSTER_EFFORT`). **`pnpm eval` sweeps the matrix** and writes per-cell
grounding-rejection-rate, fixture recall, cost, and wall-clock into the committed results
file. Opus earns the loop only if the measured numbers justify it; the default is a
starting hypothesis, not a conclusion.

### 5.3 Effort and thinking

Both Opus 5 and Sonnet 5 run **adaptive thinking by default** and default to
`effort: "high"`. Omitting the parameter is not "off" — it is the most expensive setting.
The loop therefore sets `output_config: { effort }` **explicitly on every request**.

`max_tokens` caps thinking and visible output **together**. A generous `max_tokens` is
required so a thinking-heavy step doesn't truncate the action object mid-object.

### 5.4 Structured output and the validator's stop_reason branch

Decisions use `client.messages.parse()` with `zodOutputFormat(ActionSchema)`, where
`ActionSchema` is the same Zod schema `packages/shared` exports to the validator and the
TS types. One definition, three consumers.

*Recorded for future reference:* forcing `tool_choice` alongside enabled thinking is
rejected **on Amazon Bedrock only** — the first-party Claude API permits it. This does not
affect the choice above (single-schema reuse is the actual reason) but becomes live if we
ever route through Bedrock.

The response handler branches on `stop_reason` before anything else, because two failure
modes look similar and need opposite responses:

| `stop_reason` | Meaning | Response |
|---|---|---|
| `max_tokens` | Object truncated — thinking consumed the budget | Retry with a larger `max_tokens`. **Do not** re-prompt; the model wasn't wrong. |
| `end_turn` + unknown ref | Model hallucinated an element | Re-prompt once with the error surfaced (§6.4). **Do not** raise `max_tokens`. |
| `refusal` | Safety classifier declined | Terminate that persona with `outcome: error`, record the category. Never retry the same prompt. |

Conflating the first two is the single most likely source of a runaway retry loop, which
is why `stop_reason` is persisted per step.

### 5.5 Pricing and cost accounting

`PRICING` is a table of **date-effective entries**, because Sonnet 5's introductory rate
expires:

```ts
// $ per million tokens
{ model: 'claude-sonnet-5', from: null,         to: '2026-08-31',
  input: 2.00, output: 10.00 },
{ model: 'claude-sonnet-5', from: '2026-09-01', to: null,
  input: 3.00, output: 15.00 },
{ model: 'claude-opus-5',   from: null,         to: null,
  input: 5.00, output: 25.00 },
{ model: 'claude-haiku-4-5', from: null,        to: null,
  input: 1.00, output: 5.00 },
```

Cache tokens are **multipliers on base input, keyed by TTL**:

| Token class | Multiplier |
|---|---|
| `cache_creation_input_tokens`, 5-minute TTL | 1.25 × input |
| `cache_creation_input_tokens`, 1-hour TTL | 2.00 × input |
| `cache_read_input_tokens` | 0.10 × input |

`computeCostCents(usage, modelId, ttl, at: Date)` takes the run timestamp and selects the
effective row. Unit-tested per §14, including a test that pins behaviour across the
2026-09-01 boundary.

**Caching strategy.** The persona system prompt and snapshot-format instructions are
byte-stable across every step of every run — a 1-hour TTL candidate. But 1h writes cost
2× against 0.1× reads, so it needs ~3 reads to break even. A single run's 5 steps clear
that easily; the decision is whether traffic is continuous enough to keep the entry warm.
**Start at 5-minute TTL and let `pnpm eval` measure the hit rate** before switching. The
volatile parts (screenshot, snapshot, history) sit after the last cache breakpoint.

### 5.6 Retries

The SDK auto-retries 429 and 5xx with exponential backoff (`maxRetries`, default 2). We
raise it to 4 and set an explicit request timeout — note the TypeScript SDK takes
**milliseconds**. Retries count against the run's model-call budget so a retry storm
cannot outrun the cap (C2).

---

## 6. Grounding — the core mechanism

This is the most important engineering in the project. Everything else is plumbing.

### 6.1 Snapshot construction

A DOM walk in page context collects interactive and semantically meaningful nodes: links,
buttons, inputs, headings, landmarks, images with alt text, and explicit ARIA roles. Per
node we record role, accessible name, visibility, in-viewport flag, bounding box, and
frame identity.

Emitted as a compact indented tree:

```
e1  banner
  e2  link "Home" [visible, in-viewport]
  e3  button "Start free trial" [visible, in-viewport]
e7  main
  e8  heading level=1 "Pricing" [visible, in-viewport]
```

Truncation is aggressive and deliberate: a hard node cap, offscreen decorative content
dropped, repeated list items collapsed to a representative plus a count. Token bounds are
a correctness property here, not just a cost one — an unbounded snapshot pushes the
screenshot out of the useful context.

### 6.2 Refs are step-namespaced

Refs are **`s3e12`** — step index and element index — not bare `e12`.

Without namespacing, a ref quoted in step 2's history summary resolves cleanly against
step 5's DOM to a *different element*. That is a silent grounding failure: no error, no
rejection, a confident critique pinned to the wrong thing. It would corrupt exactly the
artifact the product sells. Namespacing turns it into a loud rejection.

Each snapshot **clears all prior stamps** before stamping the current step. A ref from an
earlier step therefore resolves to nothing and is rejected by name.

### 6.3 Resolution and frame identity

Stamped as `data-sul-ref`, resolved at action time via
`page.locator('[data-sul-ref="s3e12"]')` rather than a held `ElementHandle`. Handles go
stale on navigation and re-render; this loop navigates constantly. Locators re-resolve,
and fail loudly with "ref no longer present" — which is the signal the validator wants.

**Frame identity is stored alongside every ref.** Playwright's CSS engine pierces open
shadow roots but *not* iframes, so a ref inside an iframe must be resolved against that
frame, not the page. Cookie banners and embedded checkout widgets are frequently
iframed — this is the common case, not an edge case.

### 6.4 Validation

Before any action executes, the referenced ref must exist in the *current* snapshot.

- **Unknown ref, first occurrence:** retry once, surfacing the error to the model.
- **Unknown ref, second occurrence:** force a `give_up` step with the reason recorded.
- Every rejection increments `grounding_rejection_rate`, reported per run and tracked
  across runs in the eval results file.

Enforced in code, never in the prompt. The prompt asks; the validator decides.

---

## 7. Agent loop

Per persona, per step:

1. **Observe** — viewport screenshot (JPEG, max 1024px wide, quality ~70) and snapshot.
2. **Decide** — persona system prompt + goal + history summary + snapshot + screenshot →
   structured response.
3. **Validate** — ref check (§6.4) and `stop_reason` branch (§5.4).
4. **Act** — execute via the resolved locator.
5. **Record** — persist the step, append a `run_events` row, publish.

Action schema per the brief: `click | type | scroll | go_back | wait | finish`, with
`narration`, `reasoning`, and optional `observations[]`.

**Observations are optional and must stay optional.** A step with no friction produces
none. The prompt says so explicitly, and §14 tests for it — a model that invents problems
to seem useful destroys the product's credibility faster than one that misses some.

---

## 8. Personas

Data in `packages/shared/personas.ts`, not hardcoded prompts. Adding a fourth is a
one-file change. Each carries key, display name, avatar, colour, system prompt, and
**behavioural modifiers that change the harness, not just the text**.

| Persona | Harness difference |
|---|---|
| Impatient mobile user | 390×844 viewport, touch emulation, throttled network, low step budget biased toward `give_up` |
| Screen-reader user | **Receives only the snapshot — no screenshot.** Genuinely fails when the snapshot is unnavigable. |
| Sceptical procurement manager | Desktop viewport, high patience, hunting pricing/security/contract/contact |

The screen-reader persona's architectural difference is what makes it credible rather
than cosmetic. It is also materially cheaper (no image tokens), which the cost breakdown
should show rather than hide.

Every persona prompt states plainly: you may only refer to elements in the snapshot; if
something you expect is absent, say it is absent rather than describing it.

---

## 9. Clustering

One aggregation job after all persona runs finish (including failed ones — partial input
is normal).

1. Collect every observation with persona attribution, element description, and quote.
2. One `claude-opus-5` call with a structured cluster schema.
3. Each cluster becomes an issue with title, neutral description, recommendation, and a
   severity computed from its observations — **boosted when distinct personas agree**.
4. Rank by severity, then persona count, then earliest journey position.
5. Observation links preserved so the report can show the exact screenshot and quote.

Cross-persona agreement is the strongest signal the product has. The UI surfaces it
directly ("2 of 3 personas hit this").

---

## 10. Preflight, safety, and abuse

### 10.1 Preflight (on submit, before enqueue)

A ~3-second, zero-model-spend check that fails with a clear message rather than burning a
run:

- HTTP status and full redirect chain
- Challenge markers (Cloudflare / hCaptcha / Turnstile selectors, 403, near-empty body)
- `robots.txt` fetch and evaluation
- Domain denylist

This is a correctness feature, not an optimisation: it converts the most common failure
mode into a legible message at submit time instead of three personas independently
discovering a bot wall sixty seconds later.

### 10.2 In-run safety

- Respect `robots.txt` by default; honour the denylist; per-domain rate limiting
- Identifiable User-Agent
- **Never** fill or submit forms with real data, attempt login, or proceed past payment
- Consent modals: one dismissal attempt choosing the most privacy-preserving option,
  logged as a step. If dismissal fails, continue — a blocking consent wall is legitimate
  usability feedback.
- Bot walls: stop that persona with `outcome: blocked` and a clear message. Never attempt
  to solve a challenge.

All surfaced in the UI before the first run, with the authorisation checkbox.

### 10.3 Abuse gating on live runs

This service fetches arbitrary URLs on demand, which makes it attractive to misuse and
capable of running up a bill. Three layers:

- **Per-IP rate limit** on run creation
- **Global daily run cap that fails closed** — when exhausted, live runs are refused and
  the UI directs visitors to `/demo/[slug]`
- **Passcode** required for live runs

The demo route (§13.2) is unauthenticated and free, so gating live runs costs nothing in
demonstrability.

---

## 11. Budgets and abort

`RunBudget` caps total steps, total model calls, wall-clock, and estimated dollars.
Exceeding any cap aborts **cleanly with partial results** and a recorded `abort_reason` —
never a hard failure. Timeouts at every level: per-navigation, per-step, per-persona,
per-run. Playwright navigation retries once on timeout.

A capped run still clusters whatever observations exist and still produces a report. A
partial answer is the product working as designed under its own constraints.

---

## 12. Events and streaming

### 12.1 Contract

A discriminated union in `packages/shared`, every event carrying `runId`, `personaKey`,
`seq`, `ts`:

`run.started`, `persona.status`, `persona.step`, `persona.observation`,
`persona.finished`, `run.issues`, `run.finished`, `run.error`

### 12.2 Ordering and delivery

- **`seq` comes from a single authority** — a per-run Postgres sequence — so ordering is
  never ambiguous across concurrent persona workers.
- **DB commit precedes Redis publish**, always. A subscriber can therefore never see an
  event that isn't durably replayable. The reverse order allows a live viewer to observe
  something a page refresh would lose.
- **Clients dedupe by `seq`** across the replay→subscribe handover, since the window
  between "replay finished" and "subscription live" can legitimately deliver overlap.

On connect: replay persisted events from `seq 0`, then subscribe. Never assume the socket
was open the whole time.

---

## 13. Frontend

### 13.1 Run setup, live view, report

**Setup:** URL, goal (three presets), persona toggles, authorisation checkbox, passcode,
estimated cost and time.

**Live view (split):** left, screenshot filmstrip — latest large, priors as thumbnails,
animated cursor tweening to the clicked bounding box, Framer Motion `layoutId` for
thumbnail→hero promotion. Right, three vertical persona lanes with avatar, status pill,
and chat-style narration; observations drop in as coloured pins with a spring. Top:
progress, elapsed, live cost counter.

**Report:** ranked issues; selecting one opens the annotated screenshot with numbered
pins from stored bounding boxes, the persona quote, the recommendation, and a "seen by"
row. Copy-to-markdown and a shareable read-only run URL.

`prefers-reduced-motion` respected throughout. Legible on a projector.

### 13.2 `/demo/[slug]` — the primary front door

A route that replays a pre-computed run from the persisted event log at 2–4× speed, with
**no API key, no worker, and no live browsing**. Because §12 makes the event log the
single source of truth for the live view, the demo route runs the *same* rendering path —
it is not a screenshot reel or a parallel implementation that can drift.

This is the default landing experience, not a bad-wifi fallback. Most visitors should see
a complete, fast, credible run before deciding whether to spend a live one.

### 13.3 Empty and near-empty reports

A defined state for sites that produce few or no findings, worded so it reads as a
**valid result rather than a broken tool**: what was tested, what the personas achieved,
and an explicit statement that few findings on a five-step journey is a real outcome and
not proof of a flawless site. Without this, a good site makes the product look broken.

---

## 14. Testing and evaluation

### 14.1 Fixture site

`fixtures/badsite/` — static, served locally, with planted defects: pricing buried three
clicks deep, icon-only nav with no labels, low-contrast CTA, unlabelled form input,
focus-trapping modal, alt-less carousel. CI target, demo fallback, and eval ground truth.

### 14.2 Golden eval — and where it runs

`pnpm eval` runs the full pipeline against the fixture site and scores recall against the
planted-defect list, false-positive rate (adjudicated once, then cached),
grounding-rejection-rate, mean cost, and mean wall-clock. Results committed as JSON so
regressions show up in diffs. It sweeps the model/effort matrix (§5.2).

**`pnpm eval` runs inside the Linux Playwright image, always.** Host Chromium on Windows
and container Chromium on Linux render differently — font stacks especially — which
shifts bounding boxes and therefore pin coordinates and screenshot diffs. For a product
whose output *is* annotated screenshots, that is not cosmetic. The exact Playwright
version is pinned in both `package.json` and the Dockerfile. Host runs are dev-only.

This is also the answer to "how do you keep the eval harness trustworthy": every golden
number comes from one environment.

### 14.3 Unit and integration

Unit: snapshot builder (HTML fixture → expected node tree), ref validator including the
step-namespacing collision case, clustering merge logic, cost accounting including the
pricing-date boundary and all three cache-token classes.

Integration: a queue run that fans out, has one persona fail, and still completes
aggregation.

Model mocked from recorded fixtures everywhere except `pnpm eval`.

---

## 15. Deployment and configuration

**Local:** Docker Compose for Postgres, Redis, MinIO. `pnpm dev` runs web, api, and
worker natively on the host so the browser dev loop keeps `headless: false`, the Playwright
Inspector, and the trace viewer one flag away.

**Prod:** Fly.io for api and worker (the worker needs a real container with Chromium and
RAM; serverless is a poor fit), Neon or Fly Postgres, Upstash Redis, Cloudflare R2 for
screenshots via presigned URLs. Web on Vercel or Fly.

**Config:** `.env.example` documents every variable. Boot fails loudly and names the
missing variable. No secrets committed, ever. The `/demo/[slug]` path must work with no
model credentials present at all.

---

## 16. Deviations from the brief

| # | Brief says | We do | Why |
|---|---|---|---|
| D1 | ref → live `ElementHandle` map | `data-sul-ref` stamping + locator resolution | Handles go stale on navigation/re-render; locators fail loudly instead of silently |
| D2 | Data model has no events table | Added `run_events` | Catch-up replay and deterministic re-render both need a durable ordered log |
| D3 | "No abstractions until three call sites" | `ModelClient` interface in phase 1 | Three call sites exist on day one; cost accounting needs one choke point |
| D4 | One model for the product | Split by call site: Sonnet 5 loop, Opus 5 clustering | Per-step work is bounded selection; clustering is reasoning. Measured by the eval sweep. |
| D5 | Demo run is a phase-8 fallback | `/demo/[slug]` is core scope and the primary front door | Shares the live rendering path via the event log, so it cannot drift |
| D6 | Preflight not specified | Preflight gate before enqueue | Converts the most common failure into a legible message at zero model spend |

---

## 17. Out of scope for this spec

Stretch items (§13 of the brief) are explicitly deferred until phase 8 is genuinely
finished: axe-core fusion with `verified`/`inferred` marking, before/after diff runs,
competitor side-by-side, and the GitHub Action. They are noted here only so the schema
choices above don't foreclose them — `issues` can take a `provenance` column later
without migration pain.
