"use client";

import { motion } from "framer-motion";
import { personaMeta } from "@/lib/api";
import { outcomeWord, reachedGoal } from "@/lib/outcome";
import type { TimelineRow } from "@/lib/timeline";

/**
 * The run, readable.
 *
 * This replaces the filmstrip rather than sitting beside it. A strip of
 * thumbnails could show that steps happened but never what a persona was
 * thinking, and the lane cards — which were the only place the reasoning
 * appeared — show the newest two entries clamped to two lines each. Most of
 * what the personas actually said could not be read at all.
 *
 * So the unit here is the thought, with its frame beside it and the findings it
 * produced underneath. The frame is secondary, which is why it is small and to
 * the left: you read this column, you do not scan it.
 */

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Timeline({
  rows,
  activeId,
  onSelect,
}: {
  rows: TimelineRow[];
  activeId: string | null;
  onSelect: (row: TimelineRow) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <ol
      className="flex max-h-[32rem] flex-col divide-y divide-hairline overflow-y-auto border-t border-hairline pr-1"
      aria-label="Run timeline"
    >
      {rows.map((row) => {
        const meta = personaMeta(row.personaKey);
        const active = row.id === activeId;

        if (row.kind === "outcome") {
          const won = reachedGoal(row.outcome ?? null);
          return (
            <li key={row.id} className="flex gap-3 py-3">
              <span className="readout w-10 shrink-0 pt-0.5 text-right text-[0.6rem]">
                {clock(row.atMs)}
              </span>
              <span
                className="w-[3px] shrink-0 rounded-full opacity-40"
                style={{ background: meta.colour }}
                aria-hidden
              />
              <p className="flex flex-wrap items-baseline gap-2 text-[0.85rem]">
                <span className="text-fg-dim">{meta.short}</span>
                <span
                  className={`readout border px-1.5 py-0.5 text-[0.6rem] ${
                    won
                      ? "border-minor/50 bg-minor/10 text-minor"
                      : "border-hairline text-fg-mute"
                  }`}
                >
                  {outcomeWord(row.outcome ?? null) ?? "finished"}
                </span>
              </p>
            </li>
          );
        }

        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(row)}
              aria-current={active}
              className={`flex w-full gap-3 py-3 text-left transition-colors ${
                active ? "bg-panel" : "hover:bg-panel/50"
              }`}
            >
              <span className="readout w-10 shrink-0 pt-0.5 text-right text-[0.6rem]">
                {clock(row.atMs)}
              </span>
              <span
                className="w-[3px] shrink-0 rounded-full"
                style={{ background: meta.colour, opacity: active ? 1 : 0.5 }}
                aria-hidden
              />

              {/* The frame, small and secondary. Empty for the persona that
                  navigates by the accessibility tree — which is stated rather
                  than left as a grey gap. */}
              <span className="w-24 shrink-0">
                <span className="block aspect-[3/2] overflow-hidden rounded-sm border border-hairline">
                  {row.step?.screenshotUrl ? (
                    active ? (
                      <span className="grid h-full w-full place-items-center bg-panel-2">
                        <span className="readout text-[0.5rem]">in the plate</span>
                      </span>
                    ) : (
                      <motion.img
                        layoutId={`frame-${row.step.id}`}
                        src={row.step.screenshotUrl}
                        alt=""
                        className="h-full w-full object-cover object-top"
                      />
                    )
                  ) : (
                    <span className="grid h-full w-full place-items-center bg-panel-2 px-1 text-center">
                      <span className="readout text-[0.5rem] leading-tight">
                        snapshot only
                      </span>
                    </span>
                  )}
                </span>
              </span>

              <span className="min-w-0 flex-1">
                <span className="readout flex flex-wrap items-baseline gap-2 text-[0.58rem]">
                  <span style={{ color: meta.colour }}>{meta.short}</span>
                  <span>step {row.step?.index ?? 0}</span>
                  {row.step?.url && (
                    <span className="min-w-0 break-all normal-case tracking-normal text-fg-mute">
                      {row.step.url}
                    </span>
                  )}
                </span>

                {/* Whole, never clamped. */}
                {row.narration && (
                  <span className="mt-1 block text-[0.85rem] italic leading-relaxed text-fg-dim">
                    “{row.narration}”
                  </span>
                )}

                {row.findings.map((f, i) => (
                  <span
                    key={i}
                    className={`sev-${f.severity} mt-1.5 flex gap-2 border-l-2 pl-2`}
                    style={{ borderColor: "var(--sev)" }}
                  >
                    <span
                      className="readout shrink-0 text-[0.55rem]"
                      style={{ color: "var(--sev)" }}
                    >
                      {f.severity}
                    </span>
                    <span className="text-[0.8rem] leading-snug text-fg-dim">
                      {f.description}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Persona filter. "all" is the default because the parallelism is the point;
 * selecting one is for reading a single journey end to end.
 */
export function PersonaFilter({
  personaKeys,
  selected,
  onSelect,
}: {
  personaKeys: string[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by persona">
      {[null, ...personaKeys].map((key) => {
        const active = key === selected;
        const meta = key ? personaMeta(key) : null;
        return (
          <button
            key={key ?? "all"}
            type="button"
            onClick={() => onSelect(key)}
            aria-pressed={active}
            className={`readout flex items-center gap-1.5 border px-2.5 py-1 text-[0.62rem] transition-colors ${
              active
                ? "border-fg-dim bg-panel text-fg"
                : "border-hairline text-fg-mute hover:text-fg-dim"
            }`}
          >
            {meta && (
              <span aria-hidden style={{ color: meta.colour }}>
                {meta.avatar}
              </span>
            )}
            {meta ? meta.short : "all three"}
          </button>
        );
      })}
    </div>
  );
}
