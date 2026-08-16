# Costs and latency

Every number is marked **measured** or **estimated**. Nothing here is modelled
where it could have been counted.

> **Actual money spent building and running this: £0.** Everything ran on
> Gemini's free tier. Cost figures are **notional** — measured token counts
> priced at published paid rates so the numbers are comparable to a paid
> deployment. The UI labels them NOTIONAL wherever they appear.
>
> ⚠️ The Gemini rates themselves are **unverified** — entered from documentation
> because the pricing page was unreachable from the build environment. Confirm
> before quoting any figure below as money.

---

## Measured: a single-persona run

Run `a31e19ef`, procurement persona, fixture site, `gemini-3.1-flash-lite`.

| | Value |
|---|---|
| Steps | 4 |
| Model calls | 4 |
| Tokens in / out | 8,177 / 990 |
| Wall clock | **26s** (~17s model latency, ~9s browser + navigation) |
| Cost | **$0.0012** notional |

## Measured: a three-persona fan-out

Run `337fbb41`, all three personas, fixture site.

| | Value |
|---|---|
| Wall clock | **160s** (2m40s) |
| Preflight | 3.1s, zero model spend |
| Steps | 14 (3 + 3 + 8) |
| Tokens | 37,373 |
| Cost | **1.95¢** notional |
| Clustering | **~70s of the 160s** — one call, on `gemini-3.5-flash` |
| Rate-limit errors | 0 |

**Clustering is the single largest latency item**, at roughly 44% of the run for
one model call. That latency is the provider's, not the pipeline's.

## Measured: the seeded runs

| Run | Steps | Tokens | Cost (notional) |
|---|---|---|---|
| `fixture-badsite` | 14 | 37,373 | 1.95¢ |
| `hacker-news` | 9 | 58,896 | 1.26¢ |
| `gnu-org` | 7 | 33,003 | 0.36¢ |
| `cern-info` | 8 | — | 0.34¢ |

Hacker News used **more** tokens than the fixture site but cost less: token
volume is driven by page complexity, while cost is driven by which model served
the clustering call.

---

## The levers, in order of measured impact

### 1. Model choice — up to 98× on output tokens

The largest single lever, and it is not obvious. A probe against
`gemini-flash-latest` returned, verbatim:

```json
{"promptTokenCount":6,"candidatesTokenCount":1,
 "thoughtsTokenCount":93,"totalTokenCount":100}
```

**93 thinking tokens to produce 1 output token.** `gemini-3.1-flash-lite`
returned `totalTokenCount: 7` for the same prompt — no thinking at all.

Per the spec's own reasoning, the per-step decision is bounded selection against
a six-way enum, not reasoning, so the thinking-free model is both cheaper and
more appropriate. Clustering is genuinely reasoning and keeps a larger model.

**This is also a correctness lever, not only a cost one.** Gemini reports
thinking tokens *outside* `candidatesTokenCount`, unlike Anthropic where
`output_tokens` is inclusive. Mapping `candidatesTokenCount` straight onto
billable output would have undercounted by 98% on that call.

### 2. Snapshot size — estimated 30–50% of input tokens

Snapshots are capped at 120 nodes, offscreen decorative content is dropped, and
repeated siblings collapse to a representative plus a count. Measured snapshots
on the fixture site emit 9–18 nodes from 22 discovered.

Not separately measured; the ceiling is what is controlled.

### 3. Screenshot size — estimated

JPEG, ≤1024px wide, quality 70, viewport only. Downscaling uses a fractional
`deviceScaleFactor` so bounding boxes stay in CSS pixels for pin placement.

**The screen-reader persona receives no screenshot at all**, which makes it
materially the cheapest of the three. That is an architectural consequence, not
an optimisation.

### 4. Prompt caching — measured on Anthropic, unmeasured on Gemini

The persona prefix is byte-stable across every step of every run, deliberately:
the run's goal lives in the user turn, not the system block, so the cached
prefix is shared across *all* runs of a persona rather than one.

Anthropic measurements from the mock harness showed cache reads accumulating
from step 1 onward. On Gemini, caching is implicit and `cachedContentTokenCount`
was **0 across all measured runs** — the prefix may be below the implicit-cache
threshold. Unmeasured, and a real opportunity.

Cost accounting handles the arithmetic correctly regardless: cache writes bill
at 1.25× base input at 5-minute TTL and **2× at 1-hour**, reads at 0.1×
(Anthropic) or 0.25× (Gemini). Getting the TTL multiplier wrong is the easiest
way to make this document quietly false, so it is unit-tested including the
pricing-cutover boundary.

### 5. Step and persona caps — direct and linear

`SUL_MAX_STEPS_PER_PERSONA` (default 8) and persona selection are the bluntest
levers. Dropping to two personas removes roughly a third of the cost and about
a third of the wall clock.

---

## Latency budget, measured

| Phase | Time | Note |
|---|---|---|
| Preflight | 3.1s | before anything is queued |
| Browser launch + first navigation | ~6s | per persona, parallel |
| Per step | ~2.6–8.6s | model latency dominates |
| Clustering | ~70s | one call |
| **Total, 3 personas** | **160s** | under the 4-minute ceiling |

The two-minute wait is treated as a design problem rather than a loading state:
first screenshot on screen within ~8s, per-persona status always saying
something specific, and rate-limit queueing rendered as visible pacing on a
shared time axis rather than a spinner.

## What would change these numbers

- **Verifying the Gemini rates.** Every cost figure inherits that uncertainty.
- **Measuring implicit caching on Gemini.** Cache reads were 0 throughout; if
  the prefix can be made cacheable, input cost drops materially.
- **A faster clustering model.** 44% of wall clock for one call is the obvious
  target.
- **Stressing the rate limiter.** At ~6.4 RPM against a 10 RPM budget it was
  never binding. A fourth persona would change the wall-clock profile.
