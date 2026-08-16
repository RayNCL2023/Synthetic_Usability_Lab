import { notFound } from "next/navigation";
import { API, type RunPayload } from "@/lib/api";
import { Masthead } from "@/components/Chrome";
import { RunView } from "@/components/RunView";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  const [runRes] = await Promise.all([
    fetch(`${API}/demo/${slug}`, { cache: "no-store" }),
  ]);
  if (!runRes.ok) return null;
  const data = (await runRes.json()) as RunPayload;
  const evRes = await fetch(`${API}/runs/${data.run.id}/events`, {
    cache: "no-store",
  });
  const events = evRes.ok ? await evRes.json() : [];
  return { data, events };
}

export default async function DemoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loaded = await load(slug);
  if (!loaded) notFound();

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
      <RunView data={loaded.data} events={loaded.events} replaySpeed={3} />
    </>
  );
}
