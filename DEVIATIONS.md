# Deviations log

Running record of places the implementation departs from
`docs/superpowers/specs/2026-08-13-synthetic-usability-lab-design.md`, or where
the spec turned out to be wrong once the code existed. Reviewed at each
checkpoint.

Deviations agreed *before* the spec was written are recorded in the spec's own
§16 table and are not repeated here.

---

## Contract verification pass (pre-Checkpoint B)

### V1 — SDK was pinned 49 minor versions stale, hiding `output_config` entirely

**What happened:** `@anthropic-ai/sdk` was specified as `^0.68.0`. Caret on a
`0.x` version pins the *minor*, so it resolved to exactly 0.68.0 and never
moved. Latest is 0.117.1.

**Why it mattered:** 0.68.0 contains no `output_config`, no `OutputConfig.effort`,
and no `zodOutputFormat` — the three things the spec's model layer is built on.
The code typechecked only because the request was cast
`as Anthropic.MessageCreateParamsNonStreaming`, which silenced the very error
that would have caught this on day one.

**Fixed:** pinned to an exact `0.117.1`, and the cast removed so the request
shape is type-checked natively. `output_config: { effort, format }` and
`cache_control: { ttl }` now typecheck without assertion.

**Lesson worth keeping:** a cast on an API request object is not a convenience,
it is a suppressed contract check.

### V2 — `zodOutputFormat` demotes every `enum` to prose; local `safeParse` is the only enforcement

**Verified empirically** (not by reading docs) by running `zodOutputFormat` over
a miniature of `DecisionSchema` and dumping the emitted JSON Schema.

The SDK's `transformJSONSchema` keeps only an allowlist of keywords. `enum` is
not on it, so it is moved into the property's `description`:

```json
"type": { "type": "string", "description": "{enum: [\"click\",\"type\", ...]}" }
```

The model is therefore **told** the permitted values but generation is **not
constrained** to them. This affects every enum we rely on: action type,
severity, category, direction, outcome.

Also observed: `.nullable()` renders as `anyOf: [{type:"string"},{type:"null"}]`,
**not** the `type: ["string","null"]` form the previous hand-written schema
used; `additionalProperties` is forced to `false`; `minItems` survives only for
values 0 and 1; unsupported numeric/string constraints are likewise demoted into
`description`.

**Confirmed the safety net holds:** `DecisionSchema.safeParse` rejects both an
out-of-enum `action.type` and an out-of-enum `observations[].severity`, with
messages naming the offending path and the permitted values.

**Consequence for the design:** the parse-failure retry path is load-bearing,
not defensive. It is the only thing standing between an unconstrained enum and
a bad action reaching the browser. Documented at the definition site.

### V3 — Hand-written JSON Schema removed in favour of the single definition

The spec said one Zod definition should feed the API, the validator, and the TS
types. Checkpoint A shipped a **second**, hand-maintained JSON Schema in
`anthropic.ts` because the pinned SDK had no `zodOutputFormat` — a silent
violation of the spec's stated principle, and a copy free to drift. Now derived
from `DecisionSchema` / `ClusterResponseSchema` via `zodOutputFormat`.

Required migrating `packages/shared` from `zod` to `zod/v4` (the helper is
v4-only). 37 tests pass unchanged after the migration.

### V4 — `usage` carries two fields we were not reading

Confirmed against the shipped 0.117.1 types. Every field `computeCost` reads
exists under the assumed name — `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens` — with the latter two
typed `number | null`, which the code already handles via `?? 0`.

Two additions worth noting:

- **`cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`**
  — a per-TTL breakdown. Our cost model applies a single configured TTL
  multiplier, which is correct because we send exactly one TTL per request, but
  the breakdown is a stronger cross-check if we ever vary it.
- **`output_tokens_details.thinking_tokens`** — the docs on the type state that
  `output_tokens` "remains the inclusive, authoritative total used for billing",
  so thinking tokens are already inside the number we cost. No double-count, and
  no correction needed. `thinking_tokens` is observability only.

**Still unverified at runtime** — see the blocked checks below.

### V5 — BLOCKED: three checks need a live API key

`ANTHROPIC_API_KEY` is empty in `.env` (line 29), unset in the process
environment, and there is no `ant` profile. The following are implemented in
`pnpm verify` and will run the moment a key exists:

1. A real single-persona run against `fixtures/badsite`, non-mock, 5 steps.
2. The raw `usage` block dumped verbatim from a live response.
3. `effort` accepted at runtime, and whether `output_tokens_details` is
   populated in practice.
4. A deliberate `max_tokens: 16` truncation proving `stop_reason` fires.

No cost or wall-clock figure is reported for a real run, because none has
occurred.

---

## Checkpoint A

### A1 — `sharp` dropped; screenshots downscaled via `deviceScaleFactor`

**Spec said:** screenshots capped at 1024px wide, implying a resize step.

**Built instead:** a fractional `deviceScaleFactor` on the browser context
(`1024 / viewportWidth`), so Chromium rasterises at the target size directly.

**Why:** it removes a native image dependency, and — more importantly — keeps
every bounding box in CSS pixels. Pin placement in the report is drawn from
those boxes, so a resize step would have introduced a scale factor between what
the snapshot records and what the screenshot shows. It also removes one more
thing that could behave differently between the Windows dev loop and the Linux
eval container.

**Cost:** none identified.

### A2 — `__name` shim injected into every browser context

**Spec said:** nothing; this is an implementation detail.

**Built:** `context.addInitScript` defining `globalThis.__name` as an identity
function, passed as raw source rather than a function.

**Why:** the snapshot walker is a named function serialised into the page. Under
tsx/esbuild, `keepNames` rewrites named functions to call a `__name` helper that
exists in the bundle but not in the page, so the walker threw `ReferenceError`
on arrival and produced an empty snapshot. Passing the shim as a string keeps it
immune to the same transform.

### A3 — Accessible name does **not** fall back to `placeholder`

**Spec said:** "role, accessible name, visibility, ..." without specifying the
name algorithm.

**Built:** a practical subset of accname that deliberately omits the
`placeholder` fallback, reporting the placeholder in the node's `detail` field
instead.

**Why:** real screen readers do announce a placeholder, so this is a genuine
departure from browser behaviour. But treating it as a name would give the
planted `unlabelled-email-input` defect an accessible name and hide it
completely. Reporting `textbox "" [visible] placeholder="Work email"` lets the
persona say "this field has no label, only placeholder text" — which is both
true and more actionable than either alternative.

**Cost:** the snapshot is not a faithful screen-reader transcript. Documented in
EVALUATION.md when that is written.

### A4 — Landmarks and containers do not take their name from content

**Spec said:** nothing specific.

**Built:** `textContent` is used as a name source only for roles whose name
legitimately comes from content (link, button, heading, cell, …).

**Why:** applying it to landmarks made `main`'s accessible name the entire page
text. That both misrepresents what a screen reader announces and burned a large
share of the snapshot's token budget on duplicated prose.

### A5 — Sibling collapsing keyed on role **and name**, not role alone

**Spec said:** "collapse repeated list items".

**Built:** collapse only when consecutive siblings share role *and* accessible
name.

**Why:** the first implementation collapsed four distinct nav links into three
plus a count, silently hiding the Contact link — the persona would have been
unable to reach a page that exists. Keying on the name collapses a 20-logo strip
(all unnamed) while leaving distinct navigation intact.

### A6 — Offscreen images are exempt from decorative-content dropping

**Spec said:** "drop offscreen decorative content".

**Built:** images are kept regardless of viewport position.

**Why:** a missing-alt image below the fold is exactly where that defect lives,
and the planted `carousel-no-alt` defect was undetectable with the original rule
no matter how good the model was.

### A7 — Actionability timeout capped at 8s, separate from the step timeout

**Spec said:** "timeouts everywhere: per-navigation, per-step, per-persona,
per-run."

**Built:** clicks and fills get `min(stepTimeout, 8s)` rather than the full step
timeout.

**Why:** an element under a modal overlay never becomes actionable, so the
original code waited the full 45s step timeout on every blocked click. On any
site with a newsletter popup that would exhaust the run's wall-clock budget in
four steps. Failing fast lets the persona react to the modal — which is the
finding we want — instead of stalling on it. Observed live against the fixture
site's planted focus-trapping modal.

### A8 — Budget exhaustion reports `capped`, not `gave_up`

**Spec said:** outcomes include both, but did not say which wins when the budget
runs out mid-decision.

**Built:** a `cappedBy` field distinguishes budget exhaustion from a model
give-up inside the decision path.

**Why:** the first implementation reported a cost-capped run as `gave_up`, which
tells the user the site confused the persona when in fact we stopped spending —
and left `abort_reason` null. Caught by the budget test.

### A9 — Offline `HeuristicModelClient` added (`--mock`)

**Spec said:** nothing; the spec assumed an API key.

**Built:** a deterministic keyword walker implementing `ModelClient`, selected by
`--mock` on the run CLI.

**Why:** no Anthropic credentials were available in the build environment, so the
live model call is the one segment of the pipeline that could not be exercised.
The mock runs everything else for real — snapshot, grounding validation, action
execution, persistence, and cost accounting through the real pricing table — so
Checkpoint A's acceptance is genuinely demonstrated rather than asserted.

**Caveat:** this is **not** a persona and its observations are canned. It exists
to prove plumbing, and it will also back the seeded demo run in Checkpoint C.
Recall and grounding-rejection numbers from a `--mock` run mean nothing; only
`pnpm eval` against the real API produces figures worth quoting.

### A10 — `RecordedModelClient` defaults to a real model id

**Spec said:** nothing.

**Built:** the test double reports `claude-sonnet-5` rather than
`recorded-model`.

**Why:** cost accounting throws `UnknownModelPricingError` on an unrecognised
model — deliberately, so a run is never silently reported as free. A fake id in
the double would have forced either a test fixture into the production pricing
table or every loop test around the cost path entirely. Using a real id means
cost accounting is exercised on every pass through the loop.

---

## Task 1 — Gemini provider (contract findings)

### G1 — Gemini KEEPS enums as a real constraint; Anthropic demotes them

Verified the same way as DEVIATIONS V2 — by emitting the schema and asserting on
it, not by reading documentation. Covered by `gemini-schema.test.ts`.

Gemini's `Schema` type has a first-class `enum` field, documented as "restrict a
value to a fixed set of values", set alongside `format: "enum"`. Our converter
preserves it, so the emitted `responseSchema` contains:

```json
"type": { "type": "STRING", "format": "enum",
          "enum": ["click","type","scroll","go_back","wait","finish"] }
```

Contrast with the Anthropic path, where `zodOutputFormat` strips `enum` and
narrates it in the description. **The two providers differ structurally here**,
which is exactly why `schema_rejection_rate` is now tracked separately from
`grounding_rejection_rate` — one number could not have made them comparable.

Whether the service *grammar-constrains* generation or merely validates after
the fact cannot be established without live calls. Local `safeParse` therefore
remains the enforcement of record on both providers, and the enum values are
restated verbatim in every persona prompt regardless.

### G2 — Gemini EXCLUDES thinking tokens from `candidatesTokenCount`

The opposite of Anthropic, and a silent undercount if missed.

The shipped SDK documents `totalTokenCount` as the **sum** of
`promptTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount` and
`thoughtsTokenCount` — so thinking is a separate addend. Anthropic's
`output_tokens`, by contrast, is explicitly "the inclusive, authoritative total
used for billing".

Mapping `candidatesTokenCount` straight onto our `outputTokens` would have
undercounted billable output on every thinking-enabled call. `usageFrom` returns
`candidatesTokenCount + thoughtsTokenCount`. Test pins it.

### G3 — Gemini's `promptTokenCount` already includes cached tokens

Documented as: "When `cached_content` is set, this also includes the number of
tokens in the cached content."

So reporting `promptTokenCount` as input **and** `cachedContentTokenCount` as a
cache read would bill the cached prefix twice — once at full rate and once at
the cache-read rate. `usageFrom` subtracts, and a test asserts the two fields
reconstruct the original prompt count exactly once.

### G4 — Cache multipliers moved onto the pricing row

`CACHE_WRITE_MULTIPLIER` / `CACHE_READ_MULTIPLIER` were global Anthropic
constants (1.25x/2.0x write, 0.1x read). Gemini prices cached input differently,
so the multipliers are now optional per-row overrides with the Anthropic values
as defaults. Gemini rows carry `cacheReadMultiplier: 0.25` and no cache-write
charge.

### G5 — ⚠️ Gemini pricing rows are UNVERIFIED

The Gemini rows were entered from documentation and **have not been checked
against the live pricing page from this environment**. They are marked
`notional: true`, and the CLI labels any figure derived from them
"(NOTIONAL — free tier, at published paid rates)". Confirm the rates before any
number derived from them reaches COSTS.md.

### G6 — BLOCKED: Task 2 cannot run, no `GEMINI_API_KEY`

`.env` line 32 is `GEMINI_API_KEY=` (empty); nothing in the process environment.
Boot fails loudly and names the variable, as designed.

Everything up to the HTTP boundary is built and tested: provider switch, schema
conversion, finishReason mapping, usage mapping, shared token bucket, 429
classification, backoff. **No real numbers exist for this project yet.**

---

## Task 2 — first real run

### G7 — `gemini-2.5-flash` is retired for new keys; model pinned to a working one

`generateContent` on `gemini-2.5-flash` returns 404: "no longer available to new
users". It still appears in `models.list()`, so the list is not a reliable
availability signal — it must be probed. `gemini-3.7-flash` was pinned first,
then changed again (below). Loop now runs `gemini-3.1-flash-lite`, clustering
`gemini-3.5-flash`.

### G8 — Only 429 was retried; a 503 killed the first real run at step 1

The retry wrapper classified 429s carefully and let everything else through.
Gemini's free tier returns `503 UNAVAILABLE` ("high demand") readily, and it is
exactly as transient as a per-minute 429. The first real run produced two good
grounded observations and then died on one.

Transient 5xx now retries with the same jittered backoff and bucket penalty,
while staying outside the quota classifier — a 503 is not a quota signal and
must not be mistaken for a daily cap.

### G9 — `gemini-3.7-flash` was too overloaded to complete a run

Even with 5xx retries, 3.7-flash exhausted all five attempts on 503s (79s of
backoff). Switched the loop to `gemini-3.1-flash-lite`, which completed first
try.

This is not purely a workaround. The probe showed flash-lite reports **no
thinking tokens at all**, where `gemini-flash-latest` spent 93 thinking tokens to
produce 1 output token. Per the spec's own reasoning — per-step work is bounded
selection against a six-way enum, not reasoning — flash-lite is arguably the
correct choice for the loop regardless of load.

### G2 CONFIRMED LIVE — thinking tokens are excluded from `candidatesTokenCount`

The probe returned, verbatim:

```json
{"promptTokenCount":6,"candidatesTokenCount":1,"totalTokenCount":100,
 "thoughtsTokenCount":93}
```

`6 + 1 + 93 = 100`. Thinking is a separate addend, exactly as the SDK types
documented. Had `candidatesTokenCount` been mapped straight onto `outputTokens`,
output would have been undercounted by 98% on that call.

### First real numbers

Run `a31e19ef-a4ad-490b-a5f3-e56be69f23c8`, procurement persona,
`fixtures/badsite`, goal "Find pricing and start a trial":

| Metric | Value |
|---|---|
| Steps | 4 |
| Model calls | 4 |
| Grounding rejection rate | **0.0%** (0/4) |
| Schema rejection rate | **0.0%** (0/4) |
| Observations | 4 produced, 0 dropped as ungrounded |
| Tokens | 8,177 in / 990 out |
| Cost | **$0.0012 NOTIONAL** (free tier, unverified published rates) |
| Wall clock | **26s** total, ~17s of it model latency |
| Outcome | `gave_up` |

Caveats worth keeping in view: this is ONE run of ONE persona. A 0% rejection
rate over four decisions is encouraging but not yet evidence. Recall against the
planted-defect list is not measured here — that is `pnpm eval`'s job.
