"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Callout, SeverityChip } from "./Chrome";
import { Plate } from "./Plate";
import { personaMeta, type RunPayload } from "@/lib/api";

/**
 * The report as a critical apparatus: a ranked claim on the left, and on the
 * right the witness that produced it — the persona, its own words, and the
 * plate with the finding pinned.
 *
 * Cross-persona agreement is the strongest signal this product has, so it is
 * stated in plain language ("2 of 3 personas") rather than left implicit in a
 * severity number.
 */
export function Report({ data }: { data: RunPayload }) {
  const [selected, setSelected] = useState(0);
  const issues = data.issues;
  const issue = issues[selected];

  const stepById = useMemo(
    () => new Map(data.steps.map((s) => [s.id, s])),
    [data.steps],
  );

  const personaCount = data.personaRuns.length || 3;

  if (issues.length === 0) {
    return <EmptyReport data={data} />;
  }

  const evidence = issue?.observations ?? [];
  const primary = evidence[0];
  const primaryStep = primary ? stepById.get(primary.stepId) : undefined;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* Ranked claims */}
      <ol className="flex flex-col divide-y divide-hairline border-t border-hairline">
        {issues.map((iss, i) => {
          const active = i === selected;
          const seen = iss.personaKeys.length;
          return (
            <li key={iss.id}>
              <button
                onClick={() => setSelected(i)}
                aria-current={active}
                className={`group relative w-full px-4 py-4 text-left transition-colors ${
                  active ? "bg-panel" : "hover:bg-panel/50"
                }`}
              >
                <span
                  className={`sev-${iss.severity} sev-rule absolute inset-y-0 left-0 w-[3px]`}
                  style={{ opacity: active ? 1 : 0.3 }}
                />
                <div className="flex items-baseline gap-3">
                  <span className="readout-value text-xs text-fg-mute">
                    {String(iss.rank).padStart(2, "0")}
                  </span>
                  <SeverityChip severity={iss.severity} />
                  <span className="readout ml-auto text-[0.6rem]">
                    {iss.category}
                  </span>
                </div>
                <h3
                  className={`mt-2 text-[0.98rem] leading-snug ${
                    active ? "text-fg" : "text-fg-dim"
                  }`}
                >
                  {iss.title}
                </h3>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex -space-x-1">
                    {iss.personaKeys.map((k) => {
                      const m = personaMeta(k);
                      return (
                        <span
                          key={k}
                          title={m.name}
                          className="grid h-4 w-4 place-items-center rounded-full border border-ink font-mono text-[0.5rem]"
                          style={{ background: m.colour, color: "#0b0e13" }}
                        >
                          {m.avatar}
                        </span>
                      );
                    })}
                  </div>
                  <span
                    className={`readout text-[0.6rem] ${
                      seen >= 2 ? "text-minor" : ""
                    }`}
                  >
                    {seen} of {personaCount} personas
                    {seen >= 2 && " · agreement"}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Evidence for the selected claim */}
      {issue && (
        <motion.div
          key={issue.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="flex flex-col gap-6"
        >
          <div>
            <div className="flex items-center gap-3">
              <SeverityChip severity={issue.severity} />
              <span className="readout">
                finding {String(issue.rank).padStart(2, "0")}
              </span>
            </div>
            <h2 className="display mt-3 text-[2rem] leading-[1.08] text-fg">
              {issue.title}
            </h2>
            <p className="mt-3 max-w-[62ch] text-[0.98rem] leading-relaxed text-fg-dim">
              {issue.description}
            </p>
          </div>

          <Plate
            src={primaryStep?.screenshotUrl ?? null}
            alt={`Screenshot showing: ${issue.title}`}
            pins={evidence
              .map((o, i) => ({
                n: i + 1,
                severity: o.severity,
                box: o.box,
                label: o.quote,
              }))
              .filter((p) => p.box)}
            caption={
              primaryStep ? (
                <>
                  <span>{primaryStep.url}</span>
                  <span className="text-fg-mute">·</span>
                  <span>step {primaryStep.index}</span>
                  <span className="text-fg-mute">·</span>
                  <span>{personaMeta(primaryStep.personaKey).short}</span>
                </>
              ) : null
            }
          />

          {/* The witnesses. */}
          <div className="flex flex-col gap-3">
            <h4 className="readout">what the personas said</h4>
            {evidence.map((o, i) => {
              const m = personaMeta(o.personaKey);
              return (
                <blockquote
                  key={o.id}
                  className={`sev-${o.severity} border-l-2 pl-4`}
                  style={{ borderColor: "var(--sev)" }}
                >
                  <p className="text-[0.98rem] italic leading-relaxed text-fg">
                    “{o.quote}”
                  </p>
                  <footer className="readout mt-1.5 flex items-center gap-2 text-[0.62rem]">
                    <span style={{ color: m.colour }}>{m.avatar}</span>
                    <span>{m.name}</span>
                    <span className="text-fg-mute">·</span>
                    <span className="normal-case tracking-normal">
                      {o.elementDescription}
                    </span>
                    <span className="text-fg-mute">·</span>
                    <span className="readout-value">{o.elementRef}</span>
                    {o.box && (
                      <>
                        <span className="text-fg-mute">·</span>
                        <span>pin {i + 1}</span>
                      </>
                    )}
                  </footer>
                </blockquote>
              );
            })}
          </div>

          <div className="border-t border-hairline pt-5">
            <h4 className="readout mb-2">recommendation</h4>
            <p className="max-w-[62ch] text-[0.98rem] leading-relaxed text-fg">
              {issue.recommendation}
            </p>
          </div>
        </motion.div>
      )}
    </div>
  );
}

/**
 * A run that found nothing is a real result, and this state has to say so
 * without sounding like a malfunction. Roughly half of real runs against
 * well-built sites land here — it is stated plainly, along with what was
 * actually exercised, so the reader can judge the strength of the negative.
 */
function EmptyReport({ data }: { data: RunPayload }) {
  const totalSteps = data.steps.length;
  const reached = data.personaRuns.filter(
    (p) => p.outcome === "goal_achieved",
  ).length;

  return (
    <div className="max-w-[70ch] pt-2">
      <h2 className="display text-[2.1rem] leading-[1.08] text-fg">
        No friction worth reporting.
      </h2>
      <p className="mt-4 text-[1rem] leading-relaxed text-fg-dim">
        Three personas pursued this goal across {totalSteps}{" "}
        {totalSteps === 1 ? "step" : "steps"} and none of them reported a problem
        they could point at.{" "}
        {reached > 0 && (
          <>
            {reached} of {data.personaRuns.length} reached the goal.{" "}
          </>
        )}
        The personas are instructed not to invent findings, so an empty report
        means they had nothing — not that the run failed.
      </p>

      <div className="mt-6">
        <Callout kind="empty" title="how much weight this carries">
          A clean result over a short journey is weak evidence, not proof. These
          personas test what a first-time visitor hits in the first few minutes:
          missing information, unlabelled controls, buried paths, structural
          accessibility failures. They do not test your checkout, your logged-in
          product, or anything behind a form — and they never will, by design.
        </Callout>
      </div>

      <div className="mt-6 border-t border-hairline pt-5">
        <h4 className="readout mb-3">what each persona did</h4>
        <ul className="flex flex-col gap-2">
          {data.personaRuns.map((p) => {
            const m = personaMeta(p.personaKey);
            return (
              <li key={p.personaKey} className="flex items-baseline gap-3 text-sm">
                <span style={{ color: m.colour }} className="font-mono">
                  {m.avatar}
                </span>
                <span className="text-fg">{m.name}</span>
                <span className="readout-value ml-auto text-xs text-fg-mute">
                  {p.stepCount} steps · {p.outcome ?? "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
