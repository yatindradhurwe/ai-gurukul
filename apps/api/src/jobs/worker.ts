import { pool } from "../database/pool.js";
import { processOutboxBatch } from "./outbox.js";

let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

console.log("AI Gurukul worker started");
while (running) {
  try {
    const n = await processOutboxBatch(20);
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    console.error("worker error", err);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await pool.end();
