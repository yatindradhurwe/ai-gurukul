import { enterSystemContext, pool } from "../database/pool.js";
import { handlers, RetryLater, type OutboxEvent } from "./handlers.js";

const MAX_ATTEMPTS = 8;

/**
 * Claim and process a batch of outbox events. SKIP LOCKED lets several
 * workers run concurrently without double-processing. Each event runs in its
 * own transaction; failures are retried with exponential backoff.
 */
export async function processOutboxBatch(limit = 10): Promise<number> {
  const client = await pool.connect();
  let processed = 0;
  try {
    for (let i = 0; i < limit; i++) {
      await client.query("BEGIN");
      // Workers act across tenants; each handler re-checks the tenant carried on its event.
      await enterSystemContext(client);
      const e: OutboxEvent | undefined = (
        await client.query(
          `SELECT id, tenant_id, topic, payload, attempts FROM outbox_events
            WHERE processed_at IS NULL AND available_at <= now() AND attempts < $1
            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [MAX_ATTEMPTS],
        )
      ).rows[0];
      if (!e) {
        await client.query("COMMIT");
        break;
      }
      const handler = handlers[e.topic];
      await client.query("SAVEPOINT job");
      try {
        if (!handler) throw new Error(`no handler for ${e.topic}`);
        await handler(client, e);
        await client.query(`UPDATE outbox_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`, [e.id]);
      } catch (err) {
        const retry = err instanceof RetryLater;
        // RetryLater means "progress saved, check again soon": keep the handler's writes.
        // Any other error discards them.
        await client.query(retry ? "RELEASE SAVEPOINT job" : "ROLLBACK TO SAVEPOINT job");
        await client.query(
          `UPDATE outbox_events SET attempts = attempts + $2, last_error = $3,
                  available_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [e.id, retry ? 0 : 1, String((err as Error).message).slice(0, 1000), retry ? 5 : Math.min(3600, 2 ** (e.attempts + 1))],
        );
      }
      await client.query("COMMIT");
      processed++;
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return processed;
}
