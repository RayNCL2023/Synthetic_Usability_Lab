"use client";

import { useEffect, useMemo, useState } from "react";
import { MotionConfig } from "framer-motion";
import { Plate } from "./Plate";
import { PersonaFilter, Timeline } from "./Timeline";
import { LaneReadout, type LaneState } from "./LaneReadout";
import { Report } from "./Report";
import { Readout, SeverityChip } from "./Chrome";
import { personaMeta, formatCents, displayHost, type RunPayload } from "@/lib/api";
import { heroStep, laneFrames, mergeSteps, orderEvents, pendingSegue } from "@/lib/steps";
import { buildTimeline } from "@/lib/timeline";
import { elapsedMsFromEvents } from "@/lib/run-clock";
import { outcomeWord, reachedGoal, runOutcomeSummary } from "@/lib/outcome";
import { eventDwellMs } from "@/lib/replay";

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
  /** null = follow the run; a step id = the reader has pinned that frame. */
  const [pinnedStepId, setPinnedStepId] = useState<string | null>(null);
  /** null = all three lanes; a persona key = read that journey alone. */
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);

  // Ordered by seq, not by arrival: seq is the log's ordering authority and
  // the committed fixtures are stored unsorted.
  const log = useMemo(() => orderEvents(events ?? []), [events]);

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
      return;
    }
    // Weighted by what was just revealed, not a flat tick: the event holding
    // the screen right now is the one at cursor - 1.
    const t = setTimeout(
      () => setCursor((c) => c + 1),
      eventDwellMs(cursor === 0 ? null : (log[cursor - 1] ?? null), replaySpeed),
    );
    return () => clearTimeout(t);
  }, [cursor, log, replaySpeed]);

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
        frame: null,
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
  //
  // The event log reveals a step and carries its screenshot; the payload
  // enriches it once /runs/:id has caught up. Filtering the payload alone —
  // which is what this used to do — renders an empty plate for the entire
  // duration of a live run, because the payload is still empty when the page
  // loads and is not refetched until the run finishes.
  const revealedSteps = useMemo(
    () => mergeSteps(data.steps, visible),
    [visible, data.steps],
  );

  // Elapsed is read off the log, not off a clock: it advances with the events
  // being revealed, lands on the run's true duration, and stops on its own
  // because there is no interval to forget to clear.
  const elapsed = useMemo(() => elapsedMsFromEvents(visible), [visible]);

  const timelineRows = useMemo(
    () => buildTimeline(revealedSteps, visible),
    [revealedSteps, visible],
  );
  const visibleRows = useMemo(
    () =>
      selectedPersona
        ? timelineRows.filter((r) => r.personaKey === selectedPersona)
        : timelineRows,
    [timelineRows, selectedPersona],
  );

  // Follow the run unless the reader has pinned a frame. heroStep skips steps
  // with no image, so the plate lingers rather than blanking every time the
  // screen-reader persona takes a turn.
  const followed = useMemo(
    () => heroStep(revealedSteps, selectedPersona),
    [revealedSteps, selectedPersona],
  );
  const pinned = pinnedStepId
    ? (revealedSteps.find((s) => s.id === pinnedStepId) ?? null)
    : null;
  const hero = pinned ?? followed;

  // Who is working past the plate without an image to contribute.
  const segue = useMemo(
    () => (pinned ? null : pendingSegue(revealedSteps, hero)),
    [pinned, revealedSteps, hero],
  );

  const outcomeSummary = runOutcomeSummary(data.personaRuns);

  // The outcome belongs on the plate only when the plate is showing that
  // persona's last frame — otherwise it would label a mid-journey step as the
  // end of the story.
  const heroOutcome = (() => {
    if (!hero) return null;
    const lane = lanes.find((l) => l.personaKey === hero.personaKey);
    if (!lane?.outcome) return null;
    const theirLast = revealedSteps.filter((s) => s.personaKey === hero.personaKey).at(-1);
    return theirLast?.id === hero.id ? lane.outcome : null;
  })();

  // Each lane carries its own latest frame, so the three personas are watchable
  // simultaneously instead of competing for the single hero plate.
  const lanesWithFrames = useMemo(() => {
    const frames = laneFrames(revealedSteps);
    return lanes.map((lane) => ({
      ...lane,
      frame: frames.get(lane.personaKey) ?? null,
    }));
  }, [lanes, revealedSteps]);

  const replayDone = log.length > 0 && cursor >= log.length;
  const issueCount = data.issues.length;

  return (
    /* Layout animations move real distance across the page, so the OS setting
       governs them rather than only the replay clock below. */
    <MotionConfig reducedMotion="user">
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
        {/* Its own row on a phone. min-w-0 lets a flex item shrink below its
            content, so sharing a line here squeezed the goal to one word per
            line and spilled it over the readouts. */}
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <div className="readout mb-1">goal</div>
          <p className="display text-[1.35rem] leading-tight text-fg">
            “{data.run.goal}”
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
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
          {/* min-w-0: a grid item defaults to min-width:auto, so one nowrap
              child (a truncated URL) widens the whole column past the page. */}
          <div className="flex min-w-0 flex-col gap-4">
            <Plate
              src={hero?.screenshotUrl ?? null}
              alt={hero ? `Step ${hero.index}: ${hero.narration}` : "Waiting"}
              personaKey={hero?.personaKey ?? null}
              runFinished={finished}
              /* Sets the plate's aspect, so a 390-wide phone frame and a
                 1440-wide desktop one are shown at honestly different sizes. */
              viewport={hero ? personaMeta(hero.personaKey).viewport : undefined}
              frameId={hero ? `frame-${hero.id}` : undefined}
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
                    <span className="min-w-0 break-all normal-case tracking-normal">{hero.url}</span>
                    {heroOutcome && (
                      <span
                        className={`ml-auto border px-1.5 py-0.5 text-[0.6rem] ${
                          reachedGoal(heroOutcome)
                            ? "border-minor/50 bg-minor/10 text-minor"
                            : "border-hairline text-fg-mute"
                        }`}
                      >
                        {outcomeWord(heroOutcome)}
                      </span>
                    )}
                  </>
                ) : (
                  <span>waiting for the first screenshot</span>
                )
              }
            />
            {/* Lingering on the last frame would hide a persona that is mid-step
                with nothing to show, so the plate says who is working and what
                they just said instead of going quiet. */}
            {segue && (
              <p className="flex flex-wrap items-baseline gap-2 border-l-2 pl-3 text-[0.82rem] text-fg-dim"
                 style={{ borderColor: personaMeta(segue.personaKey).colour }}>
                <span className="readout text-[0.6rem]">
                  {personaMeta(segue.personaKey).short} · step {segue.index} · no screenshot
                </span>
                {segue.narration && (
                  <span className="italic text-fg-mute">“{segue.narration}”</span>
                )}
              </p>
            )}

            {outcomeSummary && (
              <p className="border-l-2 border-minor/60 pl-3 text-[0.95rem] text-fg">
                {outcomeSummary}
              </p>
            )}

            <PersonaFilter
              personaKeys={data.personaRuns.map((p) => p.personaKey)}
              selected={selectedPersona}
              onSelect={(key) => {
                setSelectedPersona(key);
                // Switching journeys hands the plate back to the run rather
                // than stranding it on a frame from the persona you just left.
                setPinnedStepId(null);
              }}
            />

            <Timeline
              rows={visibleRows}
              activeId={hero ? `${hero.personaKey}:${hero.index}` : null}
              onSelect={(row) => {
                // Selecting the newest frame resumes following the run.
                const newest = visibleRows.filter((r) => r.kind === "step").at(-1);
                setPinnedStepId(
                  row.id === newest?.id ? null : (row.step?.id ?? null),
                );
              }}
            />
          </div>

          <LaneReadout
            lanes={lanesWithFrames}
            selected={selectedPersona}
            onSelect={(key) => {
              setSelectedPersona(key);
              setPinnedStepId(null);
            }}
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
    </MotionConfig>
  );
}
