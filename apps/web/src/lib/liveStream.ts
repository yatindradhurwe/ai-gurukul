import { authHeaders, tryRefresh } from "./api";

export interface LiveEvent {
  id: number;
  type: string;
  payload: any;
  createdAt: string;
}

/**
 * Subscribe to a live session. Uses a streaming fetch of the server-sent-event
 * endpoint (so the bearer token can be sent as a header), reconnects with
 * Last-Event-ID, and falls back to polling if streaming keeps failing.
 */
export function connectLive(sessionId: string, fromId: number, onEvent: (e: LiveEvent) => void, onStatus: (s: "live" | "reconnecting" | "polling") => void) {
  let lastId = fromId;
  let stopped = false;
  let failures = 0;
  let controller: AbortController | null = null;
  let pollTimer: number | undefined;

  const deliver = (e: LiveEvent) => {
    if (e.id <= lastId) return;
    lastId = e.id;
    onEvent(e);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`/api/v1/live/sessions/${sessionId}/events?after=${lastId}`, { headers: authHeaders() });
      if (r.status === 401) await tryRefresh();
      else if (r.ok) (await r.json()).events.forEach(deliver);
    } catch {
      /* keep polling */
    }
    pollTimer = window.setTimeout(poll, 2500);
  };

  const stream = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`/api/v1/live/sessions/${sessionId}/stream?after=${lastId}`, {
          headers: { ...authHeaders(), Accept: "text/event-stream", "Last-Event-ID": String(lastId) },
          signal: controller.signal,
        });
        if (res.status === 401 && (await tryRefresh())) continue;
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onStatus("live");
        failures = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data) deliver(JSON.parse(data));
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      failures++;
      if (failures >= 3) {
        onStatus("polling");
        poll();
        return;
      }
      onStatus("reconnecting");
      await new Promise((r) => setTimeout(r, 1000 * failures));
    }
  };

  stream();
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(pollTimer);
  };
}
