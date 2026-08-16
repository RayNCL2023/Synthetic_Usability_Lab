import Link from "next/link";
import { formatCents, displayHost } from "@/lib/api";
import { Masthead, SeverityChip } from "@/components/Chrome";
import { RunForm } from "@/components/RunForm";
import { loadSeededIndex } from "@/lib/seeded";
import { LIVE_RUNS_ENABLED } from "@/lib/flags";

/**
 * Landing page.
 *
 * The recorded runs are the front door, not a fallback — they render from
 * committed fixtures with no backend at all, so this page works on a bare
 * deployment with zero environment variables. The live-run form appears only
 * when a backend is actually configured.
 */
export default async function Home() {
  const demos = await loadSeededIndex();

  return (
    <>
      <Masthead />

      <section className="border-b border-hairline">
        <div className="mx-auto max-w-[1600px] px-6 py-14 lg:py-20">
          <div
            className={
              LIVE_RUNS_ENABLED
                ? "grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-20"
                : "max-w-[62rem]"
            }
          >
            <div>
              <p className="readout mb-5">pre-launch smoke test</p>
              <h1 className="display max-w-[18ch] text-[clamp(2.6rem,6vw,4.6rem)] leading-[0.98] text-fg">
                Three personas browse your site and tell you where they got
                stuck.
              </h1>
              <p className="mt-7 max-w-[58ch] text-[1.05rem] leading-relaxed text-fg-dim">
                An impatient phone user on a slow connection. Someone navigating
                by screen reader, who never receives a screenshot. A procurement
                manager hunting for prices and security posture. They run in
                parallel against the live site, and every finding is pinned to
                the screenshot and the sentence that produced it.
              </p>
              <p className="mt-4 max-w-[58ch] text-[0.92rem] leading-relaxed text-fg-mute">
                It reads a site the way a first-time visitor does, in about two
                minutes. It is not a replacement for user research, and the
                report says so where it matters.
              </p>

              {!LIVE_RUNS_ENABLED && (
                <p className="mt-8 max-w-[58ch] border-l-2 border-minor/50 pl-4 text-[0.92rem] leading-relaxed text-fg-dim">
                  This deployment serves recorded runs only. Every run below is
                  a real one — captured against the live site named, replayed
                  from its own event log at 3×.
                </p>
              )}
            </div>

            {LIVE_RUNS_ENABLED && <RunForm />}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] px-6 py-14">
        <div className="mb-6 flex flex-wrap items-baseline gap-4 border-b border-hairline pb-3">
          <h2 className="display text-[1.7rem] text-fg">Recorded runs</h2>
          <p className="readout">complete · replayed from the event log</p>
        </div>

        <ul className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
          {demos.map((d) => (
            <li key={d.slug}>
              <Link
                href={`/demo/${d.slug}`}
                className="group flex h-full flex-col gap-3 bg-ink p-5 transition-colors hover:bg-panel"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="readout-value text-sm text-fg group-hover:text-minor">
                    {displayHost(d.url)}
                  </span>
                  <span className="readout text-[0.6rem]">
                    {formatCents(d.totalCostCents)}
                  </span>
                </div>

                <p className="text-[0.92rem] leading-snug text-fg-dim">
                  “{d.goal}”
                </p>

                {/* State the outcome honestly on the card. A run that found
                    nothing is a real result and saying so up front is more
                    trustworthy than making the visitor discover it. */}
                <div className="mt-auto flex items-center gap-2 pt-1">
                  {d.issueCount > 0 ? (
                    <span className="readout text-[0.6rem] text-fg-dim">
                      {d.issueCount} {d.issueCount === 1 ? "finding" : "findings"}
                    </span>
                  ) : (
                    <span className="readout text-[0.6rem]">no findings</span>
                  )}
                  <span className="readout text-[0.6rem] text-fg-mute">
                    · {d.stepCount} steps
                  </span>
                  <span className="readout ml-auto text-[0.6rem] group-hover:text-fg-dim">
                    replay →
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-[1600px] flex-wrap gap-x-10 gap-y-3 px-6 py-8">
          <p className="readout">
            respects robots.txt · never fills forms · never logs in · never
            passes a payment step
          </p>
          <p className="readout ml-auto">
            costs are notional — free-tier provider at published rates
          </p>
        </div>
      </footer>
    </>
  );
}
