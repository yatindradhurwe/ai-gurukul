import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { processOutboxBatch } from "./jobs/outbox.js";
import { chatHub } from "./realtime/hub.js";

const server = createApp().listen(env.PORT, () => {
  console.log(`AI Gurukul API listening on http://localhost:${env.PORT}`);
});
chatHub.attach(server);

if (env.RUN_WORKER_IN_PROCESS === "true") {
  // Simple hosts without a separate worker process: poll the outbox in the background.
  const tick = async () => {
    try {
      const n = await processOutboxBatch(20);
      setTimeout(tick, n > 0 ? 100 : 1000);
    } catch (err) {
      console.error("in-process worker error", err);
      setTimeout(tick, 5000);
    }
  };
  tick();
}
