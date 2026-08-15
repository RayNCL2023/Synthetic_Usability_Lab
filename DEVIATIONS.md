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
