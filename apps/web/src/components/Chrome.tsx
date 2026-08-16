import Link from "next/link";

/**
 * Instrument chrome.
 *
 * The header is a readout strip, not a nav bar: it states what is being
 * measured and what it has cost so far. Everything in it is mono and
 * tabular so the numbers stay countable from across a room.
 */
export function Masthead({
  right,
}: {
  right?: React.ReactNode;
}) {
  return (
    <header className="border-b border-hairline bg-panel/60 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
        <Link href="/" className="group flex items-baseline gap-3">
          <span className="display text-[1.35rem] text-fg">
            Synthetic Usability Lab
          </span>
          <span className="readout hidden sm:inline">diagnostic</span>
        </Link>
        <div className="ml-auto flex items-center gap-6">{right}</div>
      </div>
    </header>
  );
}

/** A labelled mono readout. The unit of measurement in this UI. */
export function Readout({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "normal" | "dim" | "alarm";
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="readout">{label}</span>
      <span
        className={[
          "readout-value text-sm",
          tone === "dim" ? "text-fg-dim" : "",
          tone === "alarm" ? "text-blocker" : "",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

export function SeverityChip({
  severity,
  count,
}: {
  severity: string;
  count?: number;
}) {
  return (
    <span
      className={`sev-${severity} sev-chip inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-[0.09em]`}
    >
      {severity}
      {count !== undefined && <span className="opacity-70">×{count}</span>}
    </span>
  );
}

/**
 * Empty and failure states get direction, not mood. Both say what happened and
 * what to do next — an empty report on this product is a real result, not a
 * malfunction, and it must not read as one.
 */
export function Callout({
  kind,
  title,
  children,
}: {
  kind: "empty" | "error" | "note";
  title: string;
  children: React.ReactNode;
}) {
  const accent =
    kind === "error"
      ? "var(--color-blocker)"
      : kind === "empty"
        ? "var(--color-minor)"
        : "var(--color-fg-mute)";
  return (
    <div
      className="border-l-2 bg-panel/50 px-5 py-4"
      style={{ borderColor: accent }}
    >
      <div className="readout mb-1.5" style={{ color: accent }}>
        {title}
      </div>
      <div className="max-w-[62ch] text-[0.94rem] leading-relaxed text-fg-dim">
        {children}
      </div>
    </div>
  );
}
