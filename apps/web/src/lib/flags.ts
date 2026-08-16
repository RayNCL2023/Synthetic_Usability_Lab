/**
 * Live runs are OFF unless a backend is explicitly configured.
 *
 * Failing closed matters here: a Vercel deployment with no environment
 * variables should serve the recorded runs perfectly and never render a form
 * that posts into the void. Setting NEXT_PUBLIC_API_URL is the single switch
 * that turns the live path on.
 */
export const LIVE_RUNS_ENABLED =
  (process.env.NEXT_PUBLIC_ENABLE_LIVE_RUNS ?? "").toLowerCase() === "true" &&
  Boolean(process.env.NEXT_PUBLIC_API_URL);
