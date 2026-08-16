import { notFound } from "next/navigation";
import Link from "next/link";
import { API, type RunPayload } from "@/lib/api";
import { Masthead } from "@/components/Chrome";
import { LiveRunView } from "@/components/LiveRunView";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await fetch(`${API}/runs/${id}`, { cache: "no-store" });
  if (!res.ok) notFound();
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
