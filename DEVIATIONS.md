# Deviations log

Running record of places the implementation departs from
`docs/superpowers/specs/2026-08-13-synthetic-usability-lab-design.md`, or where
the spec turned out to be wrong once the code existed. Reviewed at each
checkpoint.

Deviations agreed *before* the spec was written are recorded in the spec's own
§16 table and are not repeated here.

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
