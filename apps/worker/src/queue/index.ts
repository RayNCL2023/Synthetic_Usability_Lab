import { FlowProducer, Queue, Worker, type ConnectionOptions } from "bullmq";
import Redis from "ioredis";

/**
 * Queue wiring.
 *
 * One parent job fans out to one child per persona; BullMQ runs the parent only
 * after every child has settled, which is what makes "aggregate whatever
 * finished" the natural behaviour rather than something we hand-roll. A persona
 * that fails does not prevent the parent from running — the report is supposed
 * to survive a partial run.
 */

export const PERSONA_QUEUE = "sul.persona";
export const AGGREGATE_QUEUE = "sul.aggregate";

export interface PersonaJobData {
  runId: string;
  personaRunId: string;
  personaKey: string;
  url: string;
  goal: string;
}

export interface AggregateJobData {
  runId: string;
  url: string;
  goal: string;
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    // BullMQ requires this; without it blocking commands throw at runtime.
    maxRetriesPerRequest: null,
  });
}

export function connectionFor(url: string): ConnectionOptions {
  return { url } as unknown as ConnectionOptions;
}

export function createFlowProducer(connection: ConnectionOptions): FlowProducer {
  return new FlowProducer({ connection });
}

export function createPersonaQueue(connection: ConnectionOptions): Queue<PersonaJobData> {
  return new Queue<PersonaJobData>(PERSONA_QUEUE, { connection });
}

export { FlowProducer, Queue, Worker };
export type { ConnectionOptions };
