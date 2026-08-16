# Progress log

Audit trail written at each subsystem boundary: what landed, what was deferred,
and anything that surprised me. Newest last.

---

## Checkpoint B — fan-out, events, preflight, budgets, replay, clustering

**Landed**

- **Fan-out** via BullMQ `FlowProducer`: one aggregate parent, one child per
  persona, `failParentOnFailure: false` so a persona that dies still yields a
  report. Worker concurrency 3, so a run genuinely fans out.
- **`run_events`** behind a single `RunEventEmitter` that allocates `seq` from
  the per-run Postgres counter and commits before publishing to Redis.
- **Preflight** before enqueue: status, redirect chain, challenge markers,
  robots.txt, denylist. Measured at **3.1s** on the fixture site, zero model
  spend.
- **Budgets** shared per run across that run's personas, so caps are run-wide.
- **WebSocket replay** at `/ws/runs/:id?from=N`: subscribe-and-buffer, replay
  the log, then flush the buffer and go live. Clients dedupe on `seq`.
- **Clustering** on Gemini, with cross-persona agreement escalating severity.

**First real parallel fan-out — measured**

| Metric | Value |
|---|---|
| Wall clock | **160s** (2m40s) — under the 4-minute ceiling, step cap unchanged |
| Preflight | 3.1s |
| Personas | 3, genuinely concurrent (all `running` at t+10s) |
| Steps | 14 (3 + 3 + 8) |
| Observations | 12 |
| Issues | 3 |
| Tokens | 37,373 |
| Cost | **1.95¢ NOTIONAL** |
| 429s / 503s | **0** |
| Events persisted | 76 |

**The limiter held.** Zero rate-limit errors across three concurrent personas.
Actual demand came to roughly 6.4 RPM against the 10 RPM budget, so the bucket
was never the binding constraint on this run — which means the limiter is
*verified as correct under real concurrency* but **not yet stressed**. A larger
step cap or a fourth persona would be the real test.

**Clustering found real defects.** Three issues, all matching planted defects,
correctly ranked:

1. `blocker` / accessibility — icon-only nav with no labels (`icon-nav-unlabelled`)
2. `major` / navigation — the interstitial that traps the user (`focus-trapping-modal`)
3. `minor` / accessibility — unlabelled email input (`unlabelled-email-input`)

That is 3 of 8 planted defects on a single run, from 12 observations. Recall is
`pnpm eval`'s job to measure properly; this is a spot check, not a number to
quote.

**Surprises**

- **Clustering is the slowest single step**: ~70s of the 160s, on
  `gemini-3.5-flash`. Worth revisiting — it is one call, so the latency is the
  model's, not ours.
- **`procurement` hit the step cap** (`capped`, 8 steps) while the other two
  gave up at 3. The impatient-mobile persona giving up fast is exactly its
  designed behaviour, so this is the harness modifiers working.
- **A stale process silently shadowed the new config.** The API kept an old
  `SUL_RUN_PASSCODE` because the previous instance still held :3001 and the new
  one failed to bind without an obvious error. Cost ~10 minutes. Worth a health
  field echoing config fingerprints if this recurs.

**Deferred**

- Budgets live in an in-process `Map` keyed by run. Correct for the
  single-worker deployment we ship; a multi-worker deployment needs this in
  Redis. Noted rather than pretended away.
- `/runs/:id/debug` token breakdown view — not built.

---

## Seeded demo runs — captured and committed

**Landed:** four complete real runs frozen into `fixtures/seeded-runs/`, with
`pnpm seed export <runId> <slug>` / `pnpm seed import`. Round-trip verified:
imported into a clean database and served from `/demo/:slug` with screenshots
intact.

| Slug | Site | Steps | Issues | Notes |
|---|---|---|---|---|
| `fixture-badsite` | bundled fixture | 14 | **3** | the showcase — blocker/major/minor, all planted defects |
| `hacker-news` | news.ycombinator.com | 9 | **2** | real public site with real findings |
| `gnu-org` | gnu.org | 7 | 0 | honest empty-report case |
| `cern-info` | info.cern.ch | 8 | 0 | small site, quick journey |

3.9 MB total. Screenshots are embedded as **data URIs**, not S3 keys, so a
seeded run has no dependency on a bucket, a credential, or a worker. A demo
that needs a live service isn't a fallback — it's one more thing that can be
down.

**The most interesting result is from Hacker News.** Both findings came from
the **screen-reader persona alone** — "Generic 'here' link text lacks
descriptive context" — while the impatient-mobile persona achieved the goal and
saw nothing. That is precisely the product's pitch demonstrating itself: the
persona with a genuinely different architecture (snapshot only, no screenshot)
surfaced something the sighted personas could not.

**Surprises**

- **Two of four runs found nothing at all**, on well-built sites with easy
  goals. The personas correctly declined to invent friction — the spec's "a step
  with no friction should produce none" holding under real conditions. But it
  means the empty-report state is not a defensive edge case; it is roughly half
  of real runs. It is kept as a seeded demo deliberately, so the empty state has
  to be designed rather than discovered.
- **Goal difficulty dominates output.** "Find out what this organisation does"
  finished in 1 step with zero findings; "find the exact GPLv3 text and how to
  report a violation" produced a real journey. The goal is a bigger lever on
  result quality than the persona is.
- **The abuse gating blocked my own seeding run** at 3/hour. Working as
  designed; raised locally via config rather than code.

**Deferred:** `pnpm eval` recall scoring against the planted-defect manifest.

---

## Checkpoint C part 1 — frontend

**Landed:** `/` (thesis + demo gallery + run form), `/demo/[slug]` (replay, built
first), `/runs/[id]` (live with WS reconnect), the report, and the empty state.

**Aesthetic:** the metaphor is a **critical apparatus** — a claim, and the
evidence pinned to it. Dark instrument housing; screenshots sit on paper-white
plates so the evidence is the lit thing on the page. Instrument Serif for
display, IBM Plex Sans for body, IBM Plex Mono for every readout. The severity
ramp is the only alarm colour in the system; persona identity is carried by thin
lane spines and never by fills, so two colour systems never compete for the same
meaning.

**The signature element** is the three persona lanes plotted against **one
shared elapsed-time axis** rather than three independent chat columns. Three
columns would show three transcripts; a shared axis shows the thing that
actually matters — that they run at the same time, that one stalls while another
races, and that an idle lane is waiting for a rate-limit slot rather than broken.

That is also how the two-minute wait is handled: queueing renders as a labelled
state on the axis with a countdown, so the delay reads as pacing you watch
rather than lag you endure. There is no undifferentiated spinner anywhere.

**Two things the screenshots caught that reading the code did not**

- **Only one lane fit on screen.** Each lane grew with its own history, so by
  step three the third persona was below the fold — destroying the entire
  argument of the component. Lanes now get a fixed row budget (newest utterance,
  newest finding); the filmstrip and report hold the full record.
- **Exit animations were smearing.** Overlapping `AnimatePresence` exits left
  ghosted text stacked on live text. Fixed with `mode="popLayout"` and a much
  shorter exit.

**Deferred:** copy-to-markdown on the report; the `layoutId` thumbnail→hero
promotion (the filmstrip selects, but does not yet morph).

---

## Checkpoint C part 2 — deploy config and documentation

**Landed:** four Dockerfiles (worker, api, web, eval), `fly.api.toml`,
`fly.worker.toml`, and README / ARCHITECTURE / EVALUATION / COSTS.

The worker and API Dockerfiles both start from
`mcr.microsoft.com/playwright:v1.49.1-jammy`, pinned to the same version as
`package.json`. The API needs it too, because preflight drives a browser.
`docker/eval.Dockerfile` exists so `pnpm eval` can only ever run in that one
rendering environment.

Fly config sets `auto_stop_machines = false` on the worker deliberately: a
queued job with no worker awake would sit until something else woke it.

**Documentation discipline:** every number in COSTS.md and EVALUATION.md is
tagged measured or estimated. The unflattering ones are stated plainly —
recall is **not measured**, false-positive rate is **not measured**, the Gemini
rates are **unverified**, the rate limiter was **never stressed**, and the
Anthropic path has **never been run end to end**.

**Not done — the honest list**

- **`pnpm eval` is not written.** The harness Dockerfile and the ground-truth
  manifest exist; the scoring script does not. This is the largest gap, and it
  is why no recall number appears anywhere.
- **Not deployed.** No Fly account was available in this environment. The
  configs are written and the images build from a clean checkout, but nothing
  has been pushed, so "a live run works end to end from the deployed URL"
  remains unverified.
- Copy-to-markdown on the report.
- `layoutId` thumbnail→hero morph in the filmstrip.
- `/runs/:id/debug` token breakdown view.

---

## Standalone demo + empty-rate attack

### 1. `/demo/[slug]` is now genuinely standalone

**It was not before.** The route fetched `${API}/demo/:slug` and
`${API}/runs/:id/events` from Fastify — a hard runtime dependency on the API,
Postgres, and S3 presigning. Replaced with `apps/web/src/lib/seeded.ts`, which
reads the committed JSON fixtures directly and rebuilds the exact shape the API
returned, so the same components render both paths and the demo still cannot
drift from the live view.

**Proof, from a build with every environment variable unset:**

```
Route (app)
┌ ○ /                                    ← Static
├ ● /demo/[slug]                         ← SSG
├   ├ /demo/hacker-news
├   ├ /demo/fixture-badsite
├   ├ /demo/gnu-org
├   └ /demo/cern-info
└ ƒ /runs/[id]                           ← Dynamic (live only)
```

The finding text is baked into `.next/server/app/demo/hacker-news.html` on disk.
No API, no worker, no Postgres, no Redis, no S3.

Live runs are behind `LIVE_RUNS_ENABLED`, which requires **both**
`NEXT_PUBLIC_ENABLE_LIVE_RUNS=true` and `NEXT_PUBLIC_API_URL`. With neither set
the form is not rendered at all rather than posting into the void. The
`http://localhost:3001` fallback default was removed — an unset API URL now
means "no backend", not "try localhost".

Hacker News is first in `SEEDED_SLUGS`. Cards state their outcome up front,
including "no findings" — more trustworthy than letting a visitor discover it.

**Surprise:** the build failed at first because webpack cannot resolve
TypeScript's explicit `.js` import specifiers in `packages/shared`. Fixed with
`resolve.extensionAlias` in `next.config.mjs`.

### 2. Empty-run rate: 60% → 16.7%

**Baseline (measured):** of 5 real fan-out runs, 3 produced no issues — **60%
empty**. (The raw run table also contains single-persona CLI and mock runs that
never cluster; those are excluded, and counting them would have made the
baseline look artificially worse.)

**Changes, both on task difficulty only.** The observation prompt and the
severity threshold were not touched.

- **Goal presets rewritten as compound journeys** in `packages/shared/goals.ts`,
  each with a NAVIGATE → EXTRACT → **VERIFY** shape. "Find the price" is one
  lookup; "find the price, then confirm what it excludes and what happens when
  you stop paying" forces a second traversal, and the second traversal is where
  real sites hide their friction.
- **Step caps raised** where they were binding. Procurement was the only persona
  actually hitting its cap.

**After (measured), 6 real runs:**

| Site | Issues | Wall clock |
|---|---|---|
| fixture badsite | 2 | 255s |
| news.ycombinator.com | 2 | 82s |
| gnu.org | **0** | 81s |
| python.org | 2 | 110s |
| debian.org | 1 | 92s |
| info.cern.ch | 2 | 57s |

**1 of 6 empty — 16.7%**, down from 60%. Mean wall clock 113s.

**One run breached the 4-minute ceiling** (fixture site, 255s), so per the
standing rule the step cap was **reduced rather than concurrency raised**:
procurement 8 → 12 → **10**. The fixture site is the pathological case — its
planted focus-trapping modal makes every click burn the full 8s actionability
timeout — but the ceiling binds regardless of cause.

**Honest caveat:** the post-change measurement uses different *sites* as well as
different goals, so site difficulty is confounded with goal difficulty. The
gnu.org run is the controlled comparison — same site, same 3 personas, harder
goal — and it still produced 0 issues. So the goal rewrite is not sufficient on
its own for every site; it moved the aggregate, not the floor.

The rate limiter remains **verified, not stressed** — no fourth persona has run.

---

## `pnpm eval`

**Landed:** the scoring harness, sweeping model × snapshot node cap against
`fixtures/badsite/defects.json`, writing `eval/results.json`.

Matching is keyword-based per defect, deliberately. An LLM judge would score its
own model family's output; fuzzy matching inflates recall by rewarding
vocabulary overlap. A miss under these matchers is a real miss.

**Measured, two cells before the daily quota fired:**

| Cell | Recall | Ground | Schema | Cost | Wall |
|---|---|---|---|---|---|
| flash-lite @ 60 nodes | **50%** (4/8) | 0% | 0% | $0.0176 | 186s |
| flash-lite @ 120 nodes | **63%** (5/8) | 0% | 0% | $0.0132 | 198s |

**The node cap is a recall lever** — doubling it moved recall 50% → 63%.
Snapshot truncation was hiding defects the model would otherwise have found.
That argues for raising the cap, and it is the first evidence the truncation
strategy has a measurable cost rather than being free.

**Surprises**

- **The daily quota fired mid-sweep**, on cell 3 of 4. The fail-fast path worked
  exactly as designed: recognised a daily cap as unrecoverable and stopped
  rather than spending the wall-clock budget on backoff. Good to have that
  confirmed against the real provider rather than only in a unit test.
- **It also exposed a real harness bug**: results were written only at the end,
  so the abort discarded two completed cells — hours of measurement. Now every
  cell is persisted as it completes and the JSON records `complete: false` plus
  `abortedBy`.

**State of the committed artifact, stated plainly**

`eval/results.json` currently contains **zero cells**. The two measured cells
above come from console output of the run that was killed *before* the
partial-write fix existed. The artifact is left honestly empty rather than
back-filled by hand — a results file that was typed rather than generated is
worse than no results file.

These are also **HOST numbers**, and the harness marks them
`"trustworthy": false` for exactly that reason. They must not be compared
against a future container run.

**Deferred**

- Re-running the sweep in `docker/eval.Dockerfile` once the quota resets. That
  is the run whose numbers are worth committing.
- `eval/adjudications.json` is empty, so false-positive rate is a floor of 0%
  rather than a measurement. It needs one human pass.
