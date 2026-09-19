import { notFound } from "next/navigation";
import Link from "next/link";
import { API, runEndpoint, type RunPayload } from "@/lib/api";
import { Masthead } from "@/components/Chrome";
import { LiveRunView } from "@/components/LiveRunView";

export const dynamic = "force-dynamic";

/**
 * The honest answer when this deployment cannot serve live runs: what this URL
 * would have shown, why it cannot, and the way to the runs that do work.
 */
function LiveRunsDisabled() {
  return (
    <>
      <Masthead
        right={
          <Link href="/" className="readout hover:text-fg">
            all runs
          </Link>
        }
      />
      <div className="mx-auto max-w-[62rem] px-6 py-20">
        <p className="readout mb-5">live runs are off</p>
        <h1 className="display max-w-[24ch] text-[clamp(2rem,4vw,3.2rem)] leading-[1.02] text-fg">
          This deployment serves recorded runs only.
        </h1>
        <p className="mt-6 max-w-[58ch] text-[1rem] leading-relaxed text-fg-dim">
          Live runs browse a site on demand, so they need an API, a worker and a
          browser behind them. None is configured here — this is the static
          demo, and it runs with no backend at all.
        </p>
        <p className="mt-4 max-w-[58ch] text-[0.92rem] leading-relaxed text-fg-mute">
          The recorded runs are complete real runs, replayed from their own
          event logs. They show the same view this page would have.
        </p>
        <Link
          href="/"
          className="readout mt-8 inline-block border border-hairline px-4 py-2 text-[0.66rem] text-fg-dim transition-colors hover:border-fg-dim hover:text-fg"
        >
          see the recorded runs →
        </Link>
      </div>
    </>
  );
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // A deployment serving only recorded runs has no API to ask. Say so, rather
  // than throwing on an unresolvable relative fetch — this route is one URL
  // guess away from any visitor, and a stack trace is a poor answer.
  const endpoint = runEndpoint(API, id);
  if (!endpoint) return <LiveRunsDisabled />;

  const res = await fetch(endpoint, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) notFound();
  const data = (await res.json()) as RunPayload;

  return (
    <>
      <Masthead
        right={
          <>
            <span className="readout flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blocker" />
              live
            </span>
            <Link href="/" className="readout hover:text-fg">
              all runs
            </Link>
          </>
        }
      />
      <LiveRunView initial={data} runId={id} />
    </>
  );
}
