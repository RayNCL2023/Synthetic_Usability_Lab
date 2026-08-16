import type { Database } from "@sul/shared/db";
import type { ModelConfig } from "@sul/shared";
import { PERSONA_KEYS, getPersona } from "@sul/shared";
import { createRun, createPersonaRun } from "../persistence/repository.js";
import {
  AGGREGATE_QUEUE,
  PERSONA_QUEUE,
  createFlowProducer,
  type ConnectionOptions,
} from "./index.js";

/**
 * Creates a run and fans it out.
 *
 * The parent/child shape matters: BullMQ runs the aggregate parent only once
 * every persona child has settled — succeeded OR failed — so a persona that
 * blows up still produces a report from whatever the others found. That is the
 * behaviour the spec asks for, and getting it from the queue rather than from
 * hand-rolled coordination is most of why BullMQ is here.
 */
export async function enqueueRun(
  db: Database,
  connection: ConnectionOptions,
  input: {
    url: string;
    goal: string;
    personaKeys?: string[];
    modelConfig: ModelConfig;
    slug?: string;
    createdByIp?: string;
  },
): Promise<{ runId: string; personaRunIds: Record<string, string> }> {
  const keys = (input.personaKeys ?? PERSONA_KEYS).filter((k) =>
    PERSONA_KEYS.includes(k),
  );
  if (keys.length === 0) throw new Error("no valid personas selected");

  const runId = await createRun(db, {
    url: input.url,
    goal: input.goal,
    modelConfig: input.modelConfig,
    slug: input.slug,
    createdByIp: input.createdByIp,
  });

  const personaRunIds: Record<string, string> = {};
  for (const key of keys) {
    getPersona(key); // throws on an unknown key before anything is queued
    personaRunIds[key] = await createPersonaRun(db, runId, key);
  }

  const flow = createFlowProducer(connection);
  await flow.add({
    name: "aggregate",
    queueName: AGGREGATE_QUEUE,
    data: { runId, url: input.url, goal: input.goal },
    children: keys.map((key) => ({
      name: `persona:${key}`,
      queueName: PERSONA_QUEUE,
      data: {
        runId,
        personaRunId: personaRunIds[key]!,
        personaKey: key,
        url: input.url,
        goal: input.goal,
      },
      opts: {
        // A persona that throws must not block the aggregate. `failParentOnFailure`
        // defaults false, which is what we want, but state it so a later reader
        // doesn't "fix" it into cascading failure.
        failParentOnFailure: false,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    })),
    opts: { removeOnComplete: false, removeOnFail: false },
  });
  await flow.close();

  return { runId, personaRunIds };
}
