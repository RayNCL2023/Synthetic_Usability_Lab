"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API, PERSONA_META } from "@/lib/api";
import { GOAL_PRESETS, DEFAULT_GOAL } from "@sul/shared";


/**
 * Run setup.
 *
 * The consent checkbox is not decoration and is not pre-ticked: this tool
 * drives a real browser against a real site, and the person starting it has to
 * say they are allowed to. Estimates are shown before launch so nobody is
 * surprised by a two-minute wait.
 */
export function RunForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [passcode, setPasscode] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [keys, setKeys] = useState<string[]>(Object.keys(PERSONA_META));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; demo?: boolean } | null>(
    null,
  );

  const toggle = (k: string) =>
    setKeys((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          goal,
          personaKeys: keys,
          passcode,
          authorised,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError({ message: body.message ?? "That did not work.", demo: body.demoAvailable });
        return;
      }
      router.push(`/runs/${body.runId}`);
    } catch {
      setError({ message: "Could not reach the API. Is it running?" });
    } finally {
      setBusy(false);
    }
  }

  const estMinutes = Math.max(1, Math.round((keys.length * 5 * 6) / 60));

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5 border border-hairline bg-panel/40 p-6"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="readout">start a run</h2>
        <span className="readout text-[0.6rem]">
          ~{estMinutes} min · ~2¢ notional
        </span>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="readout">site</span>
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          className="border border-hairline bg-ink px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-mute focus:border-minor focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="readout">goal</span>
        <textarea
          required
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          className="resize-none border border-hairline bg-ink px-3 py-2 text-sm leading-snug text-fg focus:border-minor focus:outline-none"
        />
        <div className="mt-1 flex flex-wrap gap-1.5">
          {GOAL_PRESETS.map((g) => (
            <button
              key={g.label}
              type="button"
              onClick={() => setGoal(g.goal)}
              title={g.probes}
              className={`readout border px-2 py-1 text-[0.6rem] transition-colors ${
                goal === g.goal
                  ? "border-minor/50 text-minor"
                  : "border-hairline text-fg-mute hover:text-fg-dim"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="readout mb-1">personas</legend>
        {Object.entries(PERSONA_META).map(([k, m]) => (
          <label key={k} className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={keys.includes(k)}
              onChange={() => toggle(k)}
              className="accent-minor"
            />
            <span className="font-mono text-sm" style={{ color: m.colour }}>
              {m.avatar}
            </span>
            <span className="text-sm text-fg-dim">{m.name}</span>
            {!m.sighted && (
              <span className="readout ml-auto text-[0.58rem]">snapshot only</span>
            )}
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="readout">passcode</span>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          className="border border-hairline bg-ink px-3 py-2 font-mono text-sm text-fg focus:border-minor focus:outline-none"
        />
      </label>

      <label className="flex cursor-pointer items-start gap-2.5 border-t border-hairline pt-4">
        <input
          type="checkbox"
          checked={authorised}
          onChange={(e) => setAuthorised(e.target.checked)}
          required
          className="mt-0.5 accent-minor"
        />
        <span className="text-[0.85rem] leading-snug text-fg-dim">
          I am authorised to test this site. It respects robots.txt, never fills
          forms, never logs in, and stops at any payment step.
        </span>
      </label>

      {error && (
        <div className="border-l-2 border-blocker bg-blocker/5 px-3 py-2">
          <p className="text-[0.85rem] leading-snug text-fg">{error.message}</p>
          {error.demo && (
            <p className="readout mt-1 text-[0.6rem]">
              the recorded runs below are always available
            </p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || keys.length === 0 || !authorised}
        className="readout border border-fg-dim bg-fg px-4 py-2.5 text-[0.68rem] text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {busy ? "checking the site…" : "run it"}
      </button>
    </form>
  );
}
