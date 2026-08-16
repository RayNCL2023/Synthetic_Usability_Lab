import Link from "next/link";
import { API, formatCents, displayHost } from "@/lib/api";
import { Masthead } from "@/components/Chrome";
import { RunForm } from "@/components/RunForm";

export const dynamic = "force-dynamic";

interface DemoRow {
  slug: string;
  url: string;
  goal: string;
  totalCostCents: number;
  createdAt: string;
}

async function loadDemos(): Promise<DemoRow[]> {
  try {
    const res = await fetch(`${API}/demo`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as DemoRow[];
  } catch {
    return [];
  }
}

export default async function Home() {
  const demos = await loadDemos();

  return (
    <>
      <Masthead />

      {/* The thesis: what this is, stated as the claim it makes. */}
      <section className="border-b border-hairline">
        <div className="mx-auto max-w-[1600px] px-6 py-16 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-20">
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
            </div>

            <RunForm />
          </div>
        </div>
      </section>

      {/* Recorded runs — the front door. */}
      <section className="mx-auto max-w-[1600px] px-6 py-14">
        <div className="mb-6 flex items-baseline gap-4 border-b border-hairline pb-3">
          <h2 className="display text-[1.7rem] text-fg">Recorded runs</h2>
          <p className="readout">complete · no key required</p>
        </div>

        {demos.length === 0 ? (
          <p className="max-w-[60ch] text-sm leading-relaxed text-fg-dim">
            No recorded runs are loaded. Run{" "}
            <code className="readout-value text-fg">pnpm seed import</code> to
            load the committed fixtures.
          </p>
        ) : (
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
                  <span className="readout mt-auto text-[0.6rem] group-hover:text-fg-dim">
                    watch the replay →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-[1600px] flex-wrap gap-x-10 gap-y-3 px-6 py-8">
          <p className="readout">
            respects robots.txt · never fills forms · never logs in · never
            passes a payment step
          </p>
          <p className="readout ml-auto">
            costs shown are notional — free-tier provider at published rates
          </p>
        </div>
      </footer>
    </>
  );
}
