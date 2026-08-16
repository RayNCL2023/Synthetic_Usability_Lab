"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Filmstrip, Plate } from "./Plate";
import { LaneReadout, type LaneState } from "./LaneReadout";
import { Report } from "./Report";
import { Readout, SeverityChip } from "./Chrome";
import { personaMeta, formatCents, displayHost, type RunPayload } from "@/lib/api";

type Phase = "journey" | "report";

/**
 * The run view, shared by live runs and seeded replays.
 *
 * Both modes render from the same event log, which is why the demo cannot
 * drift from the real thing: identical data, identical renderer, only the
 * clock differs.
 */
export function RunView({
  data,
  events,
  replaySpeed = 3,
  live = false,
}: {
  data: RunPayload;
  /** Persisted event log. Replayed at speed for demos, live for real runs. */
  events?: Array<Record<string, unknown>>;
  replaySpeed?: number;
  live?: boolean;
}) {
  const finished = data.run.status === "finished";
  const [phase, setPhase] = useState<Phase>(
    finished && !events ? "report" : "journey",
  );
  const [cursor, setCursor] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const startedRef = useRef<number>(Date.now());

  const log = useMemo(() => events ?? [], [events]);

  // Replay clock. Seeded runs advance through the persisted log at 2–4×; the
  // pacing is what makes three parallel personas legible rather than a blur.
  useEffect(() => {
    if (log.length === 0) return;
    if (cursor >= log.length) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setCursor(log.length);
      setElapsed(120_000);
      return;
    }
    const t = setTimeout(() => setCursor((c) => c + 1), 900 / replaySpeed);
    return () => clearTimeout(t);
  }, [cursor, log.length, replaySpeed]);

  useEffect(() => {
    if (!live && log.length === 0) return;
    const id = setInterval(
      () => setElapsed(Date.now() - startedRef.current),
      500,
    );
    return () => clearInterval(id);
  }, [live, log.length]);

  const visible = log.slice(0, cursor);

  // Derive lane state from the events seen so far.
  const lanes: LaneState[] = useMemo(() => {
    const byKey = new Map<string, LaneState>();
    for (const p of data.personaRuns) {
      byKey.set(p.personaKey, {
        personaKey: p.personaKey,
        status: "queued",
        label: "queued",
        stepCount: 0,
        outcome: null,
        slotInSeconds: null,
        events: [],
      });
    }
    for (const raw of visible) {
      const e = raw as Record<string, string & number>;
      const key = e["personaKey"] as unknown as string;
      if (!key) continue;
      const lane = byKey.get(key);
      if (!lane) continue;
      const type = e["type"] as unknown as string;
      if (type === "persona.status") {
        lane.status = "running";
        lane.label = e["label"] as unknown as string;
      } else if (type === "persona.step") {
        lane.status = "running";
        lane.stepCount = (e["stepIndex"] as unknown as number) + 1;
        lane.events.push({
          kind: "step",
          personaKey: key,
          at: e["ts"] as unknown as number,
          narration: e["narration"] as unknown as string,
        });
      } else if (type === "persona.observation") {
        lane.events.push({
          kind: "observation",
          personaKey: key,
          at: e["ts"] as unknown as number,
          severity: e["severity"] as unknown as string,
          description: e["description"] as unknown as string,
        });
      } else if (type === "persona.finished") {
        lane.status = "finished";
        lane.outcome = e["outcome"] as unknown as string;
      }
    }
    return [...byKey.values()];
  }, [visible, data.personaRuns]);

  // Steps revealed so far, newest last.
  const revealedSteps = useMemo(() => {
    if (log.length === 0) return data.steps;
    const seen = new Set<string>();
    for (const raw of visible) {
      const e = raw as Record<string, unknown>;
      if (e["type"] === "persona.step") {
        seen.add(`${e["personaKey"]}:${e["stepIndex"]}`);
      }
    }
    return data.steps.filter((s) => seen.has(`${s.personaKey}:${s.index}`));
  }, [visible, data.steps, log.length]);

  useEffect(() => {
    if (revealedSteps.length > 0) setActiveStep(revealedSteps.length - 1);
  }, [revealedSteps.length]);

  const replayDone = log.length > 0 && cursor >= log.length;
  const hero = revealedSteps[activeStep] ?? revealedSteps[revealedSteps.length - 1];
  const issueCount = data.issues.length;

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      {/* Subject strip — what is being measured. */}
      <div className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-hairline pb-5">
        <div className="min-w-0">
          <div className="readout mb-1">target</div>
          <a
            href={data.run.url}
            target="_blank"
            rel="noreferrer noopener"
            className="readout-value block truncate text-sm text-fg hover:text-minor"
          >
            {displayHost(data.run.url)}
          </a>
        </div>
        <div className="min-w-0 flex-1">
          <div className="readout mb-1">goal</div>
          <p className="display text-[1.35rem] leading-tight text-fg">
            “{data.run.goal}”
          </p>
        </div>
        <div className="flex items-end gap-7">
          <Readout
            label="elapsed"
            value={`${Math.floor(elapsed / 60000)}:${String(
              Math.floor(elapsed / 1000) % 60,
            ).padStart(2, "0")}`}
          />
          <Readout
            label="cost"
            value={formatCents(data.run.totalCostCents)}
            tone="dim"
            title="Notional — this run used a free-tier provider, costed at published paid rates."
          />
          <Readout label="findings" value={issueCount} />
        </div>
      </div>

      {/* Phase switch appears only once there is a report to switch to. */}
      {(finished || replayDone) && (
        <div className="mb-6 flex gap-1" role="tablist">
          {(["journey", "report"] as Phase[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={phase === p}
              onClick={() => setPhase(p)}
              className={`readout border px-3 py-1.5 text-[0.66rem] transition-colors ${
                phase === p
                  ? "border-fg-dim bg-panel text-fg"
                  : "border-hairline text-fg-mute hover:text-fg-dim"
              }`}
            >
              {p === "journey" ? "the journey" : `the report · ${issueCount}`}
            </button>
          ))}
        </div>
      )}

      {phase === "journey" ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex flex-col gap-4">
            <Plate
              src={hero?.screenshotUrl ?? null}
              alt={hero ? `Step ${hero.index}: ${hero.narration}` : "Waiting"}
              caption={
                hero ? (
                  <>
                    <span style={{ color: personaMeta(hero.personaKey).colour }}>
                      {personaMeta(hero.personaKey).avatar}
                    </span>
                    <span>{personaMeta(hero.personaKey).short}</span>
                    <span className="text-fg-mute">·</span>
                    <span>step {hero.index}</span>
                    <span className="text-fg-mute">·</span>
                    <span className="normal-case tracking-normal">{hero.url}</span>
                  </>
                ) : (
                  <span>waiting for the first screenshot</span>
                )
              }
            />
            {revealedSteps.length > 0 && (
              <Filmstrip
                steps={revealedSteps}
                activeIndex={activeStep}
                onSelect={setActiveStep}
              />
            )}
          </div>

          <LaneReadout
            lanes={lanes}
            elapsedMs={elapsed}
            totalSteps={Math.max(
              5,
              ...data.personaRuns.map((p) => p.stepCount || 5),
            )}
          />
        </div>
      ) : (
        <Report data={data} />
      )}
    </div>
  );
}
