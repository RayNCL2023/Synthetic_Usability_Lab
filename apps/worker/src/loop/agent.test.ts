import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { getPersona, type Decision } from "@sul/shared";
import { runAgentLoop } from "./agent.js";
import { RunBudget } from "./budget.js";
import {
  RecordedModelClient,
  clickDecision,
  giveUp,
  scrollDecision,
} from "../model/recorded.js";
import { startFixtureServer } from "../cli/fixture.js";

let browser: Browser;
let page: Page;
let fixtureUrl: string;
let stopFixture: () => Promise<void>;

const persona = getPersona("procurement");

function budget(overrides: Partial<{ steps: number; calls: number; cents: number }> = {}) {
  return new RunBudget(
    {
      maxStepsPerPersona: overrides.steps ?? 8,
      maxModelCallsPerRun: overrides.calls ?? 40,
      maxWallClockMs: 120_000,
      maxCostCents: overrides.cents ?? 100,
    },
    "5m",
  );
}

function observe(ref: string): Decision {
  return {
    narration: "This is buried.",
    reasoning: "noting friction",
    action: { type: "scroll", ref: null, text: null, direction: "down", outcome: null },
    observations: [
      {
        severity: "major",
        category: "navigation",
        ref,
        quote: "I had to dig for this.",
        description: "Pricing is not reachable from the primary navigation.",
      },
    ],
  };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript({
    content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
  });
  page = await ctx.newPage();
  const fixture = await startFixtureServer();
  fixtureUrl = fixture.url;
  stopFixture = fixture.close;
});

afterAll(async () => {
  await browser?.close();
  await stopFixture?.();
});

describe("agent loop", () => {
  it("runs to a finish action and reports goal_achieved", async () => {
    const model = new RecordedModelClient([
      { decision: clickDecision("s0e8", "Looking for pricing.") },
      {
        decision: {
          narration: "Found it.",
          reasoning: "done",
          action: {
            type: "finish",
            ref: null,
            text: null,
            direction: null,
            outcome: "goal_achieved",
          },
          observations: [],
        },
      },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(result.outcome).toBe("goal_achieved");
    expect(result.steps.length).toBe(2);
  });

  it("retries once with the validator's problems when a ref is ungrounded", async () => {
    // First response cites a ref from a step that does not exist; the loop must
    // re-prompt rather than acting on it.
    const model = new RecordedModelClient([
      { decision: clickDecision("s99e99", "Clicking something imaginary.") },
      { decision: giveUp("Fine, I give up.") },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(model.calls).toHaveLength(2);
    // The retry must carry the problem back to the model.
    expect(model.calls[1]?.retryProblems?.join(" ")).toMatch(/not in the current snapshot/);
    expect(result.grounding.rejectedDecisions).toBe(1);
    expect(result.outcome).toBe("gave_up");
  });

  it("gives up after two consecutive ungrounded responses rather than looping", async () => {
    const model = new RecordedModelClient([
      { decision: clickDecision("s42e1") },
      { decision: clickDecision("s43e2") },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(model.callCount).toBe(2);
    expect(result.grounding.rejectedDecisions).toBe(2);
    expect(result.steps).toHaveLength(0);
    expect(result.outcome).toBe("gave_up");
  });

  it("treats max_tokens as truncation, not as a grounding failure", async () => {
    // The distinction that prevents a runaway loop: truncation needs a bigger
    // budget, a bad ref needs a re-prompt. A max_tokens stop must NOT be
    // re-prompted at the same budget, and must not count as a rejection.
    const model = new RecordedModelClient([{ stopReason: "max_tokens" }]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(model.callCount).toBe(1);
    expect(result.grounding.rejectedDecisions).toBe(0);
    expect(result.outcome).toBe("gave_up");
  });

  it("stops on a refusal without retrying", async () => {
    const model = new RecordedModelClient([
      { stopReason: "refusal", refusalCategory: "cyber" },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(model.callCount).toBe(1);
    expect(result.outcome).toBe("error");
    expect(result.blockedReason).toMatch(/declined/);
  });

  it("drops ungrounded observations but keeps the step", async () => {
    // A step can produce a good action and one bad citation. Throwing away the
    // action too would waste a step and a model call for no gain.
    const model = new RecordedModelClient([
      { decision: observe("s0e999") },
      { decision: giveUp("done") },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(result.steps[0]?.observations).toHaveLength(0);
    expect(result.grounding.droppedObservations).toBe(1);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("keeps grounded observations", async () => {
    const model = new RecordedModelClient([
      { decision: observe("s0e2") },
      { decision: giveUp("done") },
    ]);

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(result.steps[0]?.observations).toHaveLength(1);
    expect(result.grounding.droppedObservations).toBe(0);
  });

  it("caps cleanly and returns partial results rather than failing", async () => {
    // Scroll rather than click: it needs no ref, so it stays grounded on every
    // step and the budget cap is unambiguously what ends the run. A click on a
    // fixed ref would go stale after the first navigation and the run would end
    // on a grounding failure instead, testing the wrong thing.
    const model = new RecordedModelClient(
      Array.from({ length: 10 }, () => ({ decision: scrollDecision() })),
    );

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: fixtureUrl,
      page,
      model,
      budget: budget({ calls: 3 }),
      stepTimeoutMs: 10_000,
    });

    expect(result.outcome).toBe("capped");
    // Partial results survive the cap — that is the product working as designed.
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe("bot wall", () => {
  it("reports blocked instead of critiquing a challenge page", async () => {
    const model = new RecordedModelClient([{ decision: giveUp("n/a") }]);
    const blocked = await browser.newContext();
    const blockedPage = await blocked.newPage();
    await blockedPage.route("**/*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "text/html",
        body: "<html><head><title>Attention Required</title></head><body></body></html>",
      }),
    );

    const result = await runAgentLoop({
      persona,
      goal: "Find pricing",
      startUrl: "https://example.invalid/",
      page: blockedPage,
      model,
      budget: budget(),
      stepTimeoutMs: 10_000,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.blockedReason).toMatch(/403|Forbidden/i);
    // The model was never asked to critique the challenge page.
    expect(model.callCount).toBe(0);
    await blocked.close();
  });
});
