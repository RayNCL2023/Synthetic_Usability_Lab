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
