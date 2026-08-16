# Evaluation

## Is synthetic usability feedback valid?

Partly, in a narrow band, and the honest answer is more interesting than the
sales one.

A language model driving a browser is not a user. It has no goal it actually
cares about, no prior expectations from competing products, no frustration, no
time pressure it genuinely feels, and no stake in the outcome. Anything this
tool says about how a person will *feel* is fabricated. What it can do is
different and narrower: **it reads a page's structure and information the way a
careful first-time visitor would, and reports what is missing or unlabelled.**

### What it can genuinely detect

These are structural facts about a page. A competent reviewer would agree with
them, and the model is checking something real:

- **Missing information.** No price, no security posture, no contact route, no
  contract terms. Absence is the most reliable class of finding, because it
  needs no judgement about how a human feels — only whether the fact is present.
- **Unlabelled controls.** Icon-only navigation, inputs with a placeholder but
  no label, buttons whose accessible name is empty. The snapshot makes these
  mechanically visible.
- **Buried paths.** Pricing three clicks deep with nothing in the primary nav.
  The step count *is* the measurement.
- **Structural accessibility failures.** Missing landmarks, skipped heading
  levels, `alt` absent on meaningful images, focus traps.

### What it cannot detect, and will not

- **Genuine emotional response.** When a persona says it is frustrated, that is
  a stylistic choice made by a language model, not a report of an internal
  state. Treat every quote as *evidence of a structural problem*, never as
  evidence of how a user felt.
- **Domain-specific expectations.** A radiologist knows what a PACS viewer
  should do. These personas do not, and will confidently miss a violation of a
  convention they have never encountered.
- **Novelty and learning effects.** Real users get better at a product over
  minutes and worse at it over weeks away. Every run here is a cold first
  encounter, forever.
- **Real assistive-technology behaviour.** The screen-reader persona reads *our*
  accessibility snapshot, not JAWS or NVDA output. Our snapshot deliberately
  differs from a real screen reader in at least one known way: it does not treat
  `placeholder` as an accessible name. That choice makes the unlabelled-input
  defect visible, but it means this persona is a **model of a structural
  problem, not a simulation of a user**. Findings from it should be confirmed
  with a real screen reader before anyone acts on them.
- **Anything behind a form, a login, or a payment step.** Refused by design, so
  the entire authenticated product is out of scope.
- **Performance as experienced.** Network throttling is emulated; the persona
  does not wait the way a person waits.

### How I would validate it against a real moderated study

The measurements that would actually settle it, none of which have been run:

1. **Agreement rate on issue discovery.** Run 8–10 sites through both this tool
   and a 5-participant moderated study. Compute what share of the moderated
   study's issues appear in the synthetic report (recall) and what share of
   synthetic issues a researcher confirms as real (precision). My prior is that
   recall is decent on the structural classes above and poor on everything else.
2. **Ranking correlation.** Spearman's ρ between the synthetic severity ranking
   and the researcher's. This matters more than recall: a tool that finds the
   right issues in the wrong order still wastes the first week of work.
3. **False-positive rate, adjudicated blind.** A researcher who does not know
   which issues are synthetic marks each as real, trivial, or wrong. Blindness
   matters — knowing an issue came from an AI biases the judgement both ways.
4. **Inter-rater reliability on the adjudication itself**, or the false-positive
   number is just one person's opinion with a decimal point on it.

Until those exist, the correct framing is: **a cheap pre-launch smoke test that
catches a specific class of structural mistake before real users see them.**

---

## Where the numbers actually land

### Measured

Everything here comes from real runs against the live Gemini API and is
reproducible from the committed seeded fixtures.

| Metric | Value | Provenance |
|---|---|---|
| Grounding rejection rate | **0.0%** (0/4 decisions) | single-persona run `a31e19ef` |
| Schema rejection rate | **0.0%** (0/4 decisions) | same run |
| Ungrounded observations dropped | **0** of 4 produced | same run |
| Wall clock, single persona | **26s** (~17s model latency) | same run |
| Wall clock, 3-persona fan-out | **160s** | run `337fbb41` |
| Preflight | **3.1s**, zero model spend | same run |
| Rate-limit errors under concurrency | **0** | same run, ~6.4 RPM against a 10 RPM budget |
| Cost, 3-persona run | **1.95¢ notional** | same run, 37,373 tokens |
| Issues found, fixture site | **3** from 12 observations | same run |
| Runs finding nothing | **1 of 6** real runs (16.7%) | post-goal-rewrite; was 3 of 5 (60%) before |
| Recall, flash-lite @ 60-node cap | **50%** (4/8 planted defects) | `pnpm eval`, host run |
| Recall, flash-lite @ 120-node cap | **63%** (5/8 planted defects) | `pnpm eval`, host run |

### Estimated, unverified, or not yet measured

Marked so nobody quotes them as findings:

| Item | Status |
|---|---|
| **Recall against the planted-defect list** | **MEASURED, but on the host rather than in the pinned container — see below.** |
| **False-positive rate** | **NOT MEASURED.** No adjudication has been performed. |
| **Gemini pricing rates** | **UNVERIFIED.** Entered from documentation; the pricing page was unreachable from the build environment. Every derived figure is labelled NOTIONAL. |
| **Cost per run in real money** | **£0 actually spent.** Free tier throughout. The cent figures are published paid rates applied to measured tokens. |
| **Rate limiter at its limit** | **NOT STRESSED.** It held at ~6.4 RPM against a 10 RPM budget, so it was never the binding constraint. A fourth persona or a larger step cap would be the real test. |
| **Anthropic provider end-to-end** | **NOT RUN.** The adapter is built and unit-tested; no Anthropic key was ever available. |
| **Cross-browser / cross-environment pin accuracy** | **NOT MEASURED.** Mitigated by construction — `pnpm eval` runs only in the pinned Linux Playwright image — but not measured. |

### The result that most deserves attention

**Two of four real runs found nothing at all.** Both were well-built sites given
easy goals; the personas correctly declined to invent friction. That is the
system working as specified — but it means an empty report is roughly half of
real runs, not a rare edge case, and it sets a ceiling on how impressive this
tool can look on a good site.

It also makes the second-most-interesting result clearer: on the Hacker News
run, **both findings came from the screen-reader persona alone**, while the
sighted personas achieved the goal and reported nothing. The persona with a
genuinely different architecture found what the others could not. That is the
strongest evidence in this repo that the harness-level persona differences are
doing real work rather than producing three flavours of the same output.

### Known bias in the fixture site

`fixtures/badsite` was written by the same author as the detector, with defects
chosen partly because they are detectable. Recall measured against it is an
upper bound and should be reported as such. A fair evaluation needs sites
nobody involved has seen.

---

## The eval harness, and the state of its numbers

`pnpm eval` exists. It runs the full pipeline against the fixture site, scores
against `fixtures/badsite/defects.json`, and sweeps model × snapshot node cap,
writing `eval/results.json`.

**Matching is deliberately conservative.** Each planted defect has an explicit
set of keyword matchers that a genuine detection must satisfy. An LLM judge was
rejected because it would be scoring its own model family's output; fuzzy string
matching was rejected because it inflates recall by rewarding vocabulary
overlap. A miss under these matchers is a real miss.

### What has actually been measured

Two sweep cells completed before the provider's **daily quota** fired:

| Cell | Recall | Grounding rejection | Schema rejection | Cost | Wall clock |
|---|---|---|---|---|---|
| `gemini-3.1-flash-lite` @ 60 nodes | **50%** (4/8) | 0% | 0% | $0.0176 | 186s |
| `gemini-3.1-flash-lite` @ 120 nodes | **63%** (5/8) | 0% | 0% | $0.0132 | 198s |

**The node cap is a recall lever.** Doubling it moved recall from 50% to 63% —
snapshot truncation was hiding defects the model would otherwise have found.
That is the first evidence that the truncation strategy has a measurable cost,
and it argues for raising the cap rather than tightening it.

### Three caveats that matter more than the numbers

1. **These are HOST numbers, not container numbers.** The harness marks its own
   output `"trustworthy": false` when `SUL_EVAL_CONTAINER` is unset, and it did
   so here. Host and container Chromium render differently, which moves bounding
   boxes and can move recall. **Do not compare these against a future container
   run.** They are indicative only.
2. **`eval/results.json` currently contains zero cells.** The two measured cells
   above come from console output of a sweep that was killed by the daily quota
   *before* the partial-write fix existed. The committed artifact is honest about
   being empty rather than being back-filled by hand.
3. **False-positive rate is still not measured.** `eval/adjudications.json` is
   empty, so every unmatched issue is reported as `unadjudicated` and the
   false-positive figure is a floor of 0%, not a measurement. Adjudicating
   requires a human verdict per issue, once, and the harness caches it.

### The quota abort was itself a useful result

The sweep died on cell 3 with `DailyQuotaExhaustedError`. That is the fail-fast
path working exactly as designed — it recognised a daily cap as unrecoverable
and stopped rather than spending the wall-clock budget on backoff that could not
succeed. It also exposed a genuine harness bug: two completed cells were
discarded because results were only written at the end. Fixed.
