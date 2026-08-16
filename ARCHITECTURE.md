# Architecture

## Shape

```
                       ┌──────────────┐
   browser  ◄────WS────┤  apps/api    │──REST──►  Postgres
      │                │  (Fastify)   │◄──sub──┐
      │  POST /runs    └──────┬───────┘        │
      └───────────────────────┘                │  Redis pub/sub  run:<id>
                              │ BullMQ flow    │
                              ▼                │
                    ┌───────────────────┐      │
                    │   apps/worker     ├──────┘
                    │   parent job      │
                    │    ├─ persona A ──┼──► Playwright ctx ──► S3 / MinIO
                    │    ├─ persona B ──┤
                    │    ├─ persona C ──┤
                    │    └─ aggregate ──┼──► clustering ──► issues
                    └───────────────────┘
```

`packages/shared` holds the Zod schemas, derived types, the event contract, the
persona definitions, and the pricing table. API, worker, and web all import it.
There is exactly one definition of every shared shape.

**Process boundaries.** The worker owns the browser and the model calls. The API
owns the socket and never touches Playwright — except preflight, which needs a
browser and runs before anything is queued. They communicate only through
Postgres (durable) and Redis pub/sub (live), never direct RPC. That is what lets
the worker crash without taking live viewers' sockets down, and what makes
`/demo/[slug]` work with no worker running at all.

---

## The agent loop

Per persona, per step:

1. **Observe** — viewport screenshot (JPEG, ≤1024px wide, q70) and a compact
   accessibility snapshot.
2. **Decide** — persona system prompt + goal + history summary + snapshot
   (+ screenshot, unless the persona is snapshot-only) → structured response.
3. **Validate** — refs checked against *this step's* snapshot; `stop_reason`
   branched on.
4. **Act** — execute via a locator resolved from the stamped ref.
5. **Record** — persist the step, append an event, publish.

Validation sits between decide and act deliberately. Nothing the model says
reaches the browser or the report until its references have been checked.

### The stop_reason branch

Three outcomes look similar and need opposite responses. Conflating them is the
most likely way to build a runaway loop, which is why `stop_reason` is persisted
on every step:

| Signal | Meaning | Response |
|---|---|---|
| `max_tokens` / `MAX_TOKENS` | Object truncated | **Raise the budget.** Do not re-prompt — the model was not wrong. |
| Unknown ref, parses fine | Hallucinated an element | **Re-prompt once** with the error surfaced. A bigger budget changes nothing. |
| `refusal` / `SAFETY` | Provider declined | Stop this persona. Never retry as-is. |

A fourth case is separated too: budget exhaustion inside the decision path
reports `capped`, not `gave_up`. Reporting a cost-capped run as "the persona
gave up" would tell the user the site confused it when in fact we stopped
spending.

---

## Grounding

The most important engineering in the project.

### Step-namespaced refs

Refs are `s3e12` — step index and element index — not bare `e12`, and every
snapshot **clears all prior stamps** before stamping.

Without namespacing, a ref quoted in step 2's history resolves cleanly against
step 5's DOM to a *different element*. No error, no rejection: a confident
critique pinned to the wrong thing. That single failure would corrupt exactly
the artifact this product sells. Namespacing converts it into a loud rejection.

### Resolution

Stamped as `data-sul-ref`, resolved at action time through
`page.locator('[data-sul-ref="s3e12"]')` — never a held `ElementHandle`. Handles
go stale on navigation and re-render, and this loop navigates constantly; a
stale handle fails in ways indistinguishable from a hallucinated ref.

**Frame identity is stored with every ref.** Playwright's CSS engine pierces
open shadow roots but *not* iframes, so a ref inside an iframe is resolved
against its own frame. Cookie banners and embedded widgets are routinely
iframed — the common case, not an edge case.

### Snapshot decisions worth knowing

Three choices depart from a naive accessibility dump, each because the naive
version hid a real defect:

- **Accessible names never fall back to `placeholder`.** Real screen readers
  announce it, but treating it as a name gives an unlabelled input a name and
  hides the defect. The placeholder is reported in `detail` instead.
- **Landmarks never take their name from content**, or `main`'s name becomes the
  whole page text — misleading *and* a large share of the token budget.
- **Sibling collapsing keys on role *and* name.** Keying on role alone collapsed
  four distinct nav links into three, hiding a page the persona needed.

### Two rejection metrics, not one

`grounding_rejection_rate` counts well-formed responses citing elements that are
not on the page. `schema_rejection_rate` counts responses that failed to parse
at all.

They are tracked separately because they say different things about a provider —
and because the providers differ *structurally*: Gemini's `responseSchema` keeps
`enum` as a real constraint, while Anthropic's `zodOutputFormat` demotes it into
the description as prose. One number could not have made them comparable. On
both providers, local `safeParse` is the enforcement of record.

---

## Event contract

A discriminated union in `packages/shared`, emitted over `/ws/runs/:id` and
persisted to `run_events`:

`run.started` · `persona.status` · `persona.step` · `persona.observation` ·
`persona.finished` · `run.issues` · `run.finished` · `run.error`

Every event carries `runId`, `personaKey`, `seq`, `ts`.

### Three ordering rules the replay story depends on

1. **`seq` comes from a single authority** — a per-run Postgres counter,
   allocated by an atomic `UPDATE … RETURNING`. Three persona workers emit
   concurrently; any in-process counter yields duplicate or out-of-order values
   and silently corrupts replay. A unique index on `(run_id, seq)` turns a
   sequencing bug into a constraint violation instead.
2. **DB commit precedes Redis publish, always**, and the published bytes are
   exactly what was persisted. A subscriber can never observe an event that a
   page refresh would lose. The reverse order looks fine in dev and produces a
   live view that disagrees with the report.
3. **Clients dedupe by `seq`** across the replay→subscribe handover. The window
   between "replay finished" and "subscription live" can legitimately deliver
   the same event twice, and the server deliberately errs that way — seeing an
   event twice is far better than dropping one.

On connect the API subscribes first and *buffers*, replays the persisted log
from `?from=N`, then flushes the buffer and goes live. Reconnection resumes from
the highest seq seen, so a dropped socket costs a few events rather than the run.

This log is also the single source of truth for `/demo/[slug]`, which is why the
demo cannot drift from the live view: identical events, identical renderer, only
the clock differs.

---

## Clustering

One aggregate job runs after every persona child settles — succeeded *or*
failed, via `failParentOnFailure: false`, so a persona that dies still yields a
report from what the others found.

Observations across all personas go to the model in one structured call. Each
cluster becomes an issue; severity is the worst among its observations,
**escalated one level when two or more distinct personas hit it**. Cross-persona
agreement is the strongest signal available, so it changes the ranking rather
than only being displayed. Ranking is severity, then persona count, then
earliest appearance in the journey.

Observation ids the model invents are dropped — the report's citations must
resolve, or the "exact screenshot and quote" promise breaks.

---

## Rate limiting

Free-tier Gemini, three concurrent personas. One **shared token bucket** is
constructed once in the provider factory and handed to every worker; three
workers each building their own would enforce three times the intended rate.

The distinction that matters: a **per-minute** 429 is transient and backoff
fixes it; a **daily-quota** 429 is not. Retrying a daily cap spends the run's
entire wall-clock budget and fails anyway, so it throws
`DailyQuotaExhaustedError` and aborts immediately with a reason the user can act
on. Transient 5xx (Gemini's free tier returns `503 UNAVAILABLE` readily) retries
on the same jittered backoff but stays outside the quota classifier.

Backoff is full-jitter, and a penalty is applied to the *whole bucket* — the
other personas are about to fire into a provider we already know is refusing.

---

## Data model

```
runs              id, url, goal, status, cost, tokens, abort_reason,
                  model_config, slug, is_demo
persona_runs      run_id, persona_key, status, current_action_label,
                  step_count, outcome, blocked_reason
steps             persona_run_id, index, url, screenshot_key, snapshot_json,
                  action_json, narration, reasoning, latency,
                  tokens_in/out, cache_write/read, stop_reason, model_id
observations      step_id, persona_run_id, severity, category, element_ref,
                  element_description, quote, viewport_box
issues            run_id, title, description, severity, category, rank,
                  recommendation
issue_observations   join
run_events        run_id, seq, type, payload_json, ts     ← added; see DEVIATIONS D2
run_seq_counters  run_id, value                           ← the seq authority
```
