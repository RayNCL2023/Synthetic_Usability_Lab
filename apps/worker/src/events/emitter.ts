import type Redis from "ioredis";
import type { Database } from "@sul/shared/db";
import { redisChannelForRun, type RunEvent, type RunEventInput } from "@sul/shared";
import { appendEvent } from "../persistence/repository.js";

/**
 * The only sanctioned way to emit a run event.
 *
 * Enforces the two ordering rules the whole replay story depends on:
 *
 *  1. `seq` is allocated by the single per-run Postgres counter inside
 *     `appendEvent` — never by a local variable. Three persona workers emit
 *     concurrently, so any in-process counter produces duplicate or
 *     out-of-order seq values and silently corrupts replay.
 *
 *  2. The DB commit happens BEFORE the Redis publish, and the published
 *     payload is exactly what was persisted. A live subscriber can therefore
 *     never observe an event that a page refresh would lose. The reverse
 *     ordering is the subtle one: it looks fine in dev and produces a live
 *     view that disagrees with the report.
 */
export class RunEventEmitter {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly runId: string,
  ) {}

  async emit(input: RunEventInput): Promise<RunEvent> {
    // Persist first. If this throws, nothing is published — correct, because
    // an event that isn't durable isn't an event.
    const event = await appendEvent(this.db, this.runId, input);

    // Publish exactly what was persisted, so live and replayed streams are
    // byte-identical.
    await this.redis
      .publish(redisChannelForRun(this.runId), JSON.stringify(event))
      .catch(() => {
        // A publish failure degrades the live view but not the record. The
        // client's replay-on-connect will pick this event up.
      });

    return event;
  }
}
