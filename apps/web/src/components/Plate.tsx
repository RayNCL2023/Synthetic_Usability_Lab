"use client";

import { AnimatePresence, motion } from "framer-motion";
import { personaMeta } from "@/lib/api";

/**
 * The evidence plate.
 *
 * Screenshots are the content, so they sit on paper white with generous margin
 * while the rest of the page stays dark instrument housing. Pins are numbered
 * rings rather than bare dots, so a finding can be cited by number in prose —
 * which is the critical-apparatus idea the whole report is built on.
 */

export interface PlatePin {
  n: number;
  severity: string;
  box: { x: number; y: number; w: number; h: number } | null;
  label: string;
}

export function Plate({
  src,
  alt,
  pins = [],
  viewport,
  caption,
  activePin,
  onPinClick,
}: {
  src: string | null;
  alt: string;
  pins?: PlatePin[];
  /** CSS-pixel viewport the boxes were measured in. */
  viewport?: { width: number; height: number };
  caption?: React.ReactNode;
  activePin?: number | null;
  onPinClick?: (n: number) => void;
}) {
  const vw = viewport?.width ?? 1280;
  const vh = viewport?.height ?? 800;

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-sm border border-plate-edge bg-plate p-2 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)]">
        {src ? (
          <div className="relative">
            <motion.img
              key={src}
              src={src}
              alt={alt}
              initial={{ opacity: 0.4 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25 }}
              className="block h-auto w-full"
            />
            <AnimatePresence>
              {pins.map((p) =>
                p.box ? (
                  <motion.button
                    key={p.n}
                    type="button"
                    onClick={() => onPinClick?.(p.n)}
                    title={p.label}
                    aria-label={`Finding ${p.n}: ${p.label}`}
                    className={`sev-${p.severity} pin absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 font-mono text-[0.7rem] font-medium text-white`}
                    style={{
                      left: `${((p.box.x + p.box.w / 2) / vw) * 100}%`,
                      top: `${((p.box.y + p.box.h / 2) / vh) * 100}%`,
                      zIndex: activePin === p.n ? 20 : 10,
                    }}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{
                      scale: activePin === p.n ? 1.25 : 1,
                      opacity: 1,
                    }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 520, damping: 22 }}
                  >
                    {p.n}
                  </motion.button>
                ) : null,
              )}
            </AnimatePresence>
          </div>
        ) : (
          /* The screen-reader persona has no screenshot BY DESIGN. Saying so
             is more honest and more interesting than a grey placeholder. */
          <div className="grid aspect-[16/10] place-items-center bg-plate px-8 text-center">
            <div>
              <p className="display text-[1.5rem] text-ink/80">No screenshot</p>
              <p className="mx-auto mt-2 max-w-[38ch] text-[0.85rem] leading-relaxed text-ink/55">
                This persona navigates by the accessibility tree alone. If the
                page is unusable without sight, it genuinely fails here.
              </p>
            </div>
          </div>
        )}
      </div>
      {caption && (
        <figcaption className="readout flex items-center gap-2 text-[0.66rem]">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * Filmstrip of prior steps. `layoutId` promotes a thumbnail into the hero, so
 * the transition reads as the same object moving rather than two images
 * cross-fading.
 */
export function Filmstrip({
  steps,
  activeIndex,
  onSelect,
}: {
  steps: Array<{
    id: string;
    index: number;
    personaKey: string;
    screenshotUrl: string | null;
    narration: string;
  }>;
  activeIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      role="tablist"
      aria-label="Steps"
    >
      {steps.map((s, i) => {
        const meta = personaMeta(s.personaKey);
        const active = i === activeIndex;
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(i)}
            title={s.narration}
            className="group relative shrink-0"
          >
            <div
              className={`h-14 w-24 overflow-hidden rounded-sm border transition-opacity ${
                active
                  ? "border-fg-dim opacity-100"
                  : "border-hairline opacity-55 group-hover:opacity-85"
              }`}
            >
              {s.screenshotUrl ? (
                <img
                  src={s.screenshotUrl}
                  alt=""
                  className="h-full w-full object-cover object-top"
                />
              ) : (
                <div className="grid h-full w-full place-items-center bg-panel-2">
                  <span className="readout text-[0.55rem]">no image</span>
                </div>
              )}
            </div>
            <span
              className="absolute inset-x-0 bottom-0 h-[2px]"
              style={{ background: meta.colour, opacity: active ? 1 : 0.4 }}
            />
            <span className="readout mt-1 block text-[0.58rem]">
              {meta.short} · {s.index}
            </span>
          </button>
        );
      })}
    </div>
  );
}
