"use client";

import { useEffect, useRef } from "react";
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { personaMeta } from "@/lib/api";
import type { HeroNode, HeroTrack } from "@/lib/hero-reel";

/**
 * The hero reel.
 *
 * A recorded run, abstracted to its shape: three persona lanes on one shared
 * clock, a playhead crossing them, a mark blooming at every step and a ring
 * opening at every finding. Nothing here is invented — every mark sits at the
 * time it actually happened, distilled from a committed fixture.
 *
 * It is drawn in the instrument language the rest of the product uses rather
 * than as a generic gradient abstract, because the lanes-on-a-shared-axis
 * diagram IS the product's argument: three personas, at once, on one clock,
 * finishing at different times.
 *
 * The whole loop runs on motion values driven by one animation-frame callback,
 * so forty marks animate without React re-rendering once.
 */

/** One pass of the reel. Slow enough to read, short enough to loop. */
const LOOP_MS = 16_000;

const LANE_Y = [0.3, 0.52, 0.74];

/** Marks are inset so nothing sits on the panel's edge. */
const X0 = 0.08;
const X1 = 0.95;
const place = (t: number) => X0 + t * (X1 - X0);

type PlacedNode = HeroNode & { t: number };

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function severityColour(severity: string | undefined): string {
  switch (severity) {
    case "blocker":
      return "var(--color-blocker)";
    case "major":
      return "var(--color-major)";
    case "minor":
      return "var(--color-minor)";
    default:
      return "var(--color-nitpick)";
  }
}

/**
 * One mark, with its own transforms so the parent never re-renders to animate
 * it — `progress` is a motion value, not state.
 */
function Mark({
  node,
  progress,
  colour,
  still,
}: {
  node: PlacedNode;
  progress: MotionValue<number>;
  colour: string;
  still: boolean;
}) {
  const x = place(node.t);
  const y = LANE_Y[node.lane] ?? 0.5;
  const isFinding = node.kind === "finding";
  const tint = isFinding ? severityColour(node.severity) : colour;

  // Blooms as the playhead reaches it, then stays lit: by the end of a pass
  // the panel holds the whole run rather than a single travelling dot.
  const opacity = useTransform(
    progress,
    [x - 0.02, x, x + 0.06],
    still ? [1, 1, 1] : [0, 1, 0.92],
  );
  const scale = useTransform(
    progress,
    [x - 0.02, x, x + 0.07],
    still ? [1, 1, 1] : [0.15, 1.7, 1],
  );

  // A finding opens a ring and lets it go. Muted rather than removed when
  // motion is off: the server renders without knowing the preference, so a
  // branch here would change the element tree between server and client.
  const ringScale = useTransform(progress, [x, x + 0.11], [0.5, 5.5]);
  const ringOpacity = useTransform(
    progress,
    [x, x + 0.025, x + 0.11],
    still ? [0, 0, 0] : [0, 0.55, 0],
  );

  return (
    <div
      className="absolute"
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
      aria-hidden
    >
      {isFinding && (
        <motion.span
          className="absolute block rounded-full border"
          style={{
            width: 22,
            height: 22,
            marginLeft: -11,
            marginTop: -11,
            borderColor: tint,
            scale: ringScale,
            opacity: ringOpacity,
          }}
        />
      )}
      <motion.span
        className="absolute block rounded-full"
        style={{
          width: isFinding ? 9 : 6,
          height: isFinding ? 9 : 6,
          marginLeft: isFinding ? -4.5 : -3,
          marginTop: isFinding ? -4.5 : -3,
          background: tint,
          boxShadow: `0 0 16px ${tint}`,
          opacity,
          scale,
        }}
      />
    </div>
  );
}

/**
 * One lane: its label, its track, and a trail that brightens behind the
 * playhead and stops where that persona actually stopped. The three lanes run
 * out at different points, which is the true shape of the run and the most
 * interesting thing this animation has to say.
 */
function Lane({
  personaKey,
  y,
  endT,
  progress,
  still,
}: {
  personaKey: string;
  y: number;
  endT: number;
  progress: MotionValue<number>;
  still: boolean;
}) {
  const meta = personaMeta(personaKey);
  const end = place(endT);
  const trailWidth = useTransform(
    progress,
    (p) => `${Math.max(0, Math.min(p, end) - X0) * 100}%`,
  );

  return (
    <div className="absolute inset-x-0" style={{ top: `${y * 100}%` }}>
      <div
        className="readout absolute -translate-y-[1.45rem] text-[0.58rem]"
        style={{ left: `${X0 * 100}%` }}
      >
        <span
          className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
          style={{ background: meta.colour }}
          aria-hidden
        />
        <span className="text-fg-mute">{meta.short}</span>
      </div>

      {/* The full track, barely there. */}
      <div
        className="absolute h-px"
        style={{
          left: `${X0 * 100}%`,
          right: `${(1 - X1) * 100}%`,
          background: `${meta.colour}22`,
        }}
        aria-hidden
      />
      {/* What has been traversed. */}
      <motion.div
        className="absolute h-px"
        style={{
          left: `${X0 * 100}%`,
          width: still ? `${(end - X0) * 100}%` : trailWidth,
          background: `linear-gradient(90deg, ${meta.colour}00, ${meta.colour}aa)`,
        }}
        aria-hidden
      />
      {/* Where this persona stopped. */}
      <div
        className="absolute h-2 w-px -translate-y-1/2"
        style={{ left: `${end * 100}%`, background: `${meta.colour}55` }}
        aria-hidden
      />
    </div>
  );
}

export function HeroReel({
  track,
  caption,
}: {
  track: HeroTrack;
  caption: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  /** 0 → 1 across one pass of the run. */
  const progress = useMotionValue(reduced ? 1 : 0);
  const started = useRef<number | null>(null);

  useAnimationFrame((now) => {
    if (reduced) return;
    if (started.current === null) started.current = now;
    progress.set(((now - started.current) % LOOP_MS) / LOOP_MS);
  });

  // Fade the marks at both ends of a pass so the restart has no seam.
  const layerOpacity = useTransform(
    progress,
    [0, 0.05, 0.9, 1],
    reduced ? [1, 1, 1, 1] : [0, 1, 1, 0],
  );

  // Gentle parallax: the wash trails the marks as the page moves.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const washY = useSpring(
    useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [0, 48]),
    { stiffness: 60, damping: 24 },
  );
  const markY = useSpring(
    useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [0, 16]),
    { stiffness: 60, damping: 24 },
  );

  // The elapsed readout ticks with the playhead. Written straight to the DOM
  // node so a clock updating sixty times a second costs no React renders.
  const clockRef = useRef<HTMLSpanElement>(null);
  useMotionValueEvent(progress, "change", (p) => {
    if (clockRef.current) clockRef.current.textContent = clock(p * track.durationMs);
  });
  // The server cannot know the motion preference, so the markup always starts
  // at 0:00 and the still variant settles to the full duration after mount.
  useEffect(() => {
    if (reduced && clockRef.current) {
      clockRef.current.textContent = clock(track.durationMs);
    }
  }, [reduced, track.durationMs]);

  const playheadLeft = useTransform(progress, (p) => `${p * 100}%`);
  const playheadOpacity = useTransform(
    progress,
    [0, 0.04, 0.92, 1],
    reduced ? [0, 0, 0, 0] : [0, 1, 1, 0],
  );

  const nodes: PlacedNode[] = track.nodes.map((n) => ({
    ...n,
    t: track.durationMs > 0 ? n.at / track.durationMs : 0,
  }));

  // Where each persona's last mark falls, so its trail ends there.
  const laneEnd = track.lanes.map((_, lane) =>
    nodes.reduce((max, n) => (n.lane === lane && n.t > max ? n.t : max), 0),
  );

  const gridAt = [0, 0.25, 0.5, 0.75, 1];

  /**
   * Where browsing stops and the clustering call begins. On a real run that
   * tail can be half the wall clock; naming it turns an unexplained gap into
   * the part of the run where the findings are actually ranked.
   */
  const splitT =
    track.durationMs > 0 ? track.browsingEndsAt / track.durationMs : 1;
  const splitX = place(splitT);
  const showSplit = splitT > 0.05 && splitT < 0.95;

  return (
    <figure ref={ref} className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-sm border border-hairline bg-panel/30 sm:aspect-[16/10]">
        {/* Atmosphere. Persona-keyed, and far too faint to compete. */}
        <motion.div
          className="absolute inset-0"
          style={{ y: washY }}
          aria-hidden
        >
          {track.lanes.slice(0, 3).map((key, i) => (
            <div
              key={key}
              className={`hero-wash hero-wash-${["a", "b", "c"][i]}`}
              style={{
                background: `radial-gradient(circle at ${[28, 66, 48][i]}% ${
                  [30, 46, 76][i]
                }%, ${personaMeta(key).colour} 0%, transparent 60%)`,
                opacity: 0.2,
              }}
            />
          ))}
        </motion.div>

        <motion.div className="absolute inset-0" style={{ y: markY }}>
          {/* Header band: what this is, and where the playhead has reached. */}
          <div
            className="readout absolute flex items-baseline justify-between text-[0.58rem]"
            style={{ left: `${X0 * 100}%`, right: `${(1 - X1) * 100}%`, top: "8%" }}
          >
            <span className="text-fg-mute">three personas · one clock</span>
            <span className="readout-value text-fg-dim">
              <span ref={clockRef}>0:00</span>
            </span>
          </div>

          {/* The clock the three lanes share. */}
          {gridAt.map((g) => (
            <div
              key={g}
              className="absolute bottom-[16%] top-[19%] w-px bg-hairline/60"
              style={{ left: `${place(g) * 100}%` }}
              aria-hidden
            />
          ))}

          {/* The aggregation phase. */}
          {showSplit && (
            <>
              <div
                className="absolute bottom-[16%] top-[19%]"
                style={{
                  left: `${splitX * 100}%`,
                  right: `${(1 - X1) * 100}%`,
                  background:
                    "linear-gradient(90deg, rgba(255,255,255,0.028), transparent)",
                  borderLeft: "1px dashed var(--color-hairline)",
                }}
                aria-hidden
              />
              <div
                className="readout absolute hidden text-[0.55rem] text-fg-mute sm:block"
                style={{ left: `${(splitX + 0.015) * 100}%`, top: "19%" }}
                aria-hidden
              >
                clustering findings
              </div>
            </>
          )}

          {track.lanes.slice(0, 3).map((key, i) => (
            <Lane
              key={key}
              personaKey={key}
              y={LANE_Y[i] ?? 0.5}
              endT={laneEnd[i] ?? 1}
              progress={progress}
              still={Boolean(reduced)}
            />
          ))}

          <motion.div className="absolute inset-0" style={{ opacity: layerOpacity }}>
            {nodes.map((node, i) => (
              <Mark
                key={i}
                node={node}
                progress={progress}
                colour={personaMeta(track.lanes[node.lane] ?? "").colour}
                still={Boolean(reduced)}
              />
            ))}
          </motion.div>

          {/* Playhead: one clock, three lanes. */}
          <motion.div
            className="absolute bottom-[16%] top-[19%] w-px"
            style={{
              left: playheadLeft,
              opacity: playheadOpacity,
              background:
                "linear-gradient(180deg, transparent, var(--color-fg-dim), transparent)",
            }}
            aria-hidden
          />

          {/* Axis ends, so the abstraction stays anchored to a real duration. */}
          <div
            className="readout absolute bottom-[6%] text-[0.55rem]"
            style={{ left: `${X0 * 100}%` }}
            aria-hidden
          >
            0:00
          </div>
          <div
            className="readout absolute bottom-[6%] -translate-x-full text-[0.55rem]"
            style={{ left: `${X1 * 100}%` }}
            aria-hidden
          >
            {clock(track.durationMs)}
          </div>
        </motion.div>
      </div>

      <figcaption className="readout text-[0.6rem] text-fg-mute">{caption}</figcaption>
    </figure>
  );
}
