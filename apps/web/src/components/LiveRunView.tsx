"use client";

import { useEffect, useRef, useState } from "react";
import { API, type RunPayload } from "@/lib/api";
import { RunView } from "./RunView";

/**
 * Live run: connect, replay the persisted log from seq 0, then stream.
 *
 * The client dedupes on `seq` because the handover between replay and live
 * subscription can legitimately deliver the same event twice — and seeing an
 * event twice is far better than dropping one, so the server deliberately
 * errs that way.
 *
 * Reconnection resumes `?from=<highest seq seen>` rather than from zero, so a
 * dropped socket costs a few events of catch-up instead of the whole run.
 */
export function LiveRunView({
  initial,
  runId,
}: {
  initial: RunPayload;
  runId: string;
}) {
  const [data, setData] = useState(initial);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const seenSeq = useRef<Set<number>>(new Set());
  const highestSeq = useRef(0);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">(
    "connecting",
  );

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const wsUrl =
        API.replace(/^http/, "ws") +
        `/ws/runs/${runId}?from=${highestSeq.current}`;
      socket = new WebSocket(wsUrl);
      setConnection("connecting");

      socket.onopen = () => setConnection("open");

      socket.onmessage = (msg) => {
        try {
          const e = JSON.parse(msg.data as string) as Record<string, unknown>;
          const seq = e["seq"] as number;
          if (typeof seq === "number") {
            if (seenSeq.current.has(seq)) return; // duplicate across handover
            seenSeq.current.add(seq);
            if (seq > highestSeq.current) highestSeq.current = seq;
          }
          setEvents((prev) => [...prev, e]);

          // A terminal event means the report exists — refetch the full run so
          // issues and observations are present rather than derived.
          if (e["type"] === "run.finished" || e["type"] === "run.issues") {
            fetch(`${API}/runs/${runId}`, { cache: "no-store" })
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => d && setData(d));
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onclose = () => {
        setConnection("closed");
        if (!stopped) retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [runId]);

  return (
    <>
      {connection === "closed" && (
        <div className="border-b border-hairline bg-panel px-6 py-2">
          <span className="readout text-major">
            reconnecting — the run keeps going without this page
          </span>
        </div>
      )}
      <RunView data={data} events={events} replaySpeed={1000} live />
    </>
  );
}
