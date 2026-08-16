import { notFound } from "next/navigation";
import Link from "next/link";
import { Masthead } from "@/components/Chrome";
import { RunView } from "@/components/RunView";
import { SEEDED_SLUGS, isSeededSlug, loadSeededRun } from "@/lib/seeded";

/**
 * Seeded replay.
 *
 * Statically generated from the committed fixtures — no API, no worker, no
 * database, no object store. This route works on a bare Vercel deployment with
 * no environment variables set at all.
 */
export function generateStaticParams() {
  return SEEDED_SLUGS.map((slug) => ({ slug }));
}

export default async function DemoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isSeededSlug(slug)) notFound();

  const { data, events } = await loadSeededRun(slug);

  return (
    <>
      <Masthead
        right={
          <>
            <span className="readout border border-minor/40 bg-minor/10 px-2 py-0.5 text-[0.62rem] text-minor">
              recorded run
            </span>
            <Link href="/" className="readout hover:text-fg">
              all runs
            </Link>
          </>
        }
      />
      <RunView data={data} events={events} replaySpeed={3} />
    </>
  );
}
