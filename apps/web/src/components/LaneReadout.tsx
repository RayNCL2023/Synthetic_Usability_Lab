"use client";

import { AnimatePresence, motion } from "framer-motion";
import { personaMeta } from "@/lib/api";
import type { LaneFrame } from "@/lib/steps";
import { outcomeWord } from "@/lib/outcome";

/**
 * The signature element: three persona lanes plotted against ONE shared
 * elapsed-time axis.
 *
 * Three independent chat columns would show three transcripts. A shared axis
 * shows the thing that actually matters — that they are running at the same
 * time, that one persona stalls while another races ahead, and that a lane
 * sitting idle is waiting for a rate-limit slot rather than broken.
 *
 * That last point is why the two-minute wait is handled here rather than with a
 * spinner: queueing is rendered as a labelled state on the axis with a countdown,
 * so the delay reads as pacing you can watch rather than lag you endure.
 */

export interface LaneEvent {
  kind: "step" | "observation" | "status" | "finished";
  personaKey: string;
  at: number;
  stepIndex?: number;
  label?: string;
  narration?: string;
  severity?: string;
  description?: string;
  outcome?: string;
}

export interface LaneState {
  personaKey: string;
  status: "queued" | "waiting" | "running" | "finished" | "failed";
  label: string;
  stepCount: number;
  outcome: string | null;
  /** Seconds until this lane expects a rate-limit slot; null when not waiting. */
  slotInSeconds: number | null;
  /** This lane's own latest frame. Null for a persona that gets no screenshot. */
  frame: LaneFrame | null;
  events: LaneEvent[];
}

function statusWord(l: LaneState): string {
  // The vocabulary is shared with the plate and the timeline so the same
  // result is never described three different ways.
  if (l.status === "finished") return outcomeWord(l.outcome) ?? "finished";
  if (l.status === "waiting")
    return l.slotInSeconds !== null
      ? `waiting for a model slot — ${l.slotInSeconds}s`
      : "waiting for a model slot";
  if (l.status === "queued") return "queued";
  return l.label || "working";
}

export function LaneReadout({
  lanes,
  elapsedMs,
  totalSteps,
  selected = null,
  onSelect,
}: {
  lanes: LaneState[];
  elapsedMs: number;
  totalSteps: number;
  /** Persona currently being read alone, if any. */
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const axisMax = Math.max(120, Math.ceil(seconds / 30) * 30);
  const ticks = Array.from({ length: axisMax / 30 + 1 }, (_, i) => i * 30);

  return (
    <section aria-label="Persona progress" className="flex min-w-0 flex-col">
      {/* Shared time axis. The whole point of the component. */}
      <div className="relative mb-1 h-5 border-b border-hairline">
        {ticks.map((t) => (
          <div
            key={t}
            /* The transform belongs on the positioned box, not on the text
               inside it: the first and last labels sit flush rather than
               centred so neither hangs off the axis and past the page edge. */
            className={`absolute top-0 flex h-full items-end ${
              t === 0 ? "" : t === axisMax ? "-translate-x-full" : "-translate-x-1/2"
            }`}
            style={{ left: `${(t / axisMax) * 100}%` }}
          >
            <span className="readout pb-0.5 text-[0.62rem]">
              {t === 0 ? "0:00" : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`}
            </span>
          </div>
        ))}
        <motion.div
          className="absolute bottom-0 top-0 w-px bg-minor"
          animate={{ left: `${Math.min(100, (seconds / axisMax) * 100)}%` }}
          transition={{ ease: "linear", duration: 0.5 }}
        />
      </div>

      <div className="flex flex-col divide-y divide-hairline">
        {lanes.map((lane) => {
          const meta = personaMeta(lane.personaKey);
          const progress = totalSteps > 0 ? lane.stepCount / totalSteps : 0;
          const done = lane.status === "finished" || lane.status === "failed";

          const isSelected = selected === lane.personaKey;
          return (
            <article
              key={lane.personaKey}
              className={`flex gap-3 py-3 transition-colors ${
                isSelected ? "bg-panel" : ""
              }`}
            >
              {/* Lane spine: the ONLY place persona colour is used. */}
              <div
                className="w-[3px] shrink-0 rounded-full"
                style={{
                  background: meta.colour,
                  opacity: done ? 0.35 : 1,
                }}
                aria-hidden
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className="font-mono text-sm"
                    style={{ color: meta.colour }}
                    aria-hidden
                  >
                    {meta.avatar}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelect?.(isSelected ? null : lane.personaKey)}
                    aria-pressed={isSelected}
                    title={
                      isSelected
                        ? "Show all three journeys"
                        : `Read ${meta.name}'s journey on its own`
                    }
                    className="text-left text-sm font-medium text-fg underline-offset-4 hover:underline"
                  >
                    {meta.name}
                  </button>
                  {!meta.sighted && (
                    <span
                      className="readout text-[0.6rem]"
                      title="This persona receives only the accessibility snapshot — no screenshot."
                    >
                      snapshot only
                    </span>
                  )}
                  <span className="readout-value ml-auto text-xs text-fg-mute">
                    {lane.stepCount} {lane.stepCount === 1 ? "step" : "steps"}
                  </span>
                </div>

                {/* Progress bar doubles as the waiting indicator. */}
                <div className="relative mt-2 h-1 overflow-hidden rounded-full bg-panel-2">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ background: meta.colour, opacity: done ? 0.4 : 0.85 }}
                    animate={{ width: `${Math.min(100, progress * 100)}%` }}
                    transition={{ type: "spring", stiffness: 120, damping: 20 }}
                  />
                  {lane.status === "waiting" && (
                    <div className="lane-waiting absolute inset-0" aria-hidden />
                  )}
                </div>

                {/* Always something specific — never a bare spinner. */}
                <p
                  className="mt-1.5 truncate text-[0.82rem] text-fg-dim"
                  aria-live="polite"
                >
                  {statusWord(lane)}
                </p>

                {/* This lane's own view. Three personas running at once is the
                    claim; three frames updating at once is the evidence for it.
                    The screen-reader lane has none and says so in its header
                    instead, rather than showing an apologetic grey box. */}
                {lane.frame?.screenshotUrl && (
                  <figure className="mt-2">
                    <div className="overflow-hidden rounded-sm border border-plate-edge bg-plate">
                      <motion.img
                        key={lane.frame.screenshotUrl}
                        src={lane.frame.screenshotUrl}
                        alt=""
                        initial={{ opacity: 0.3 }}
                        animate={{ opacity: done ? 0.5 : 1 }}
                        transition={{ duration: 0.3 }}
                        className="block h-20 w-full object-cover object-top"
                      />
                    </div>
                    <figcaption className="readout mt-1 text-[0.56rem]">
                      step {lane.frame.screenshotStepIndex}
                      {/* An image lagging its step is normal mid-run, and
                          saying so beats letting the frame look current. */}
                      {lane.frame.screenshotStepIndex !== lane.frame.step.index &&
                        " · holding while the next frame uploads"}
                    </figcaption>
                  </figure>
                )}

                {/* Newest utterance and newest finding only.
                    Three lanes have to be visible SIMULTANEOUSLY — that is the
                    entire argument of this component — so each lane gets a
                    fixed budget of rows rather than growing with its history.
                    The filmstrip and the report hold the full record. */}
                <div className="mt-2 flex min-h-[3.6rem] flex-col gap-1.5">
                  <AnimatePresence initial={false} mode="popLayout">
                    {lane.events
                      .slice()
                      .reverse()
                      .filter(
                        (e, _i, all) =>
                          e === all.find((x) => x.kind === "observation") ||
                          e === all.find((x) => x.kind === "step"),
                      )
                      .slice(0, 2)
                      .map((e) => (
                        <motion.div
                          key={`${e.kind}-${e.at}`}
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, transition: { duration: 0.1 } }}
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        >
                          {e.kind === "observation" ? (
                            <div
                              className={`sev-${e.severity} flex gap-2 border-l-2 pl-2`}
                              style={{ borderColor: "var(--sev)" }}
                            >
                              <span
                                className="readout shrink-0 text-[0.58rem]"
                                style={{ color: "var(--sev)" }}
                              >
                                {e.severity}
                              </span>
                              <span className="line-clamp-2 text-[0.78rem] leading-snug text-fg-dim">
                                {e.description}
                              </span>
                            </div>
                          ) : (
                            <p className="line-clamp-2 pl-2 text-[0.78rem] italic leading-snug text-fg-mute">
                              “{e.narration}”
                            </p>
                          )}
                        </motion.div>
                      ))}
                  </AnimatePresence>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
