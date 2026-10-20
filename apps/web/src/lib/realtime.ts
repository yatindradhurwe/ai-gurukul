import { useEffect, useRef, useState } from "react";
import { getAccessToken, tryRefresh } from "./api";

export type RealtimeStatus = "offline" | "connecting" | "live";
type Handler = (event: any) => void;

/**
 * One WebSocket per tab to /api/v1/ws for live chat, receipts, typing,
 * presence and module notifications. Authenticates with the first frame,
 * refreshes an expired token, and reconnects with backoff (also when the tab
 * comes back to the foreground or the network returns).
 */
class Realtime {
  private ws: WebSocket | null = null;
  private tenantId: string | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<(s: RealtimeStatus) => void>();
  private retry = 0;
  private timer: number | undefined;
  private watching: string[] = [];
  private userId: string | null = null;
  private deliverTimer: number | undefined;
  status: RealtimeStatus = "offline";

  constructor() {
    if (typeof window === "undefined") return;
    const wake = () => this.tenantId && (!this.ws || this.ws.readyState > WebSocket.OPEN) && this.connect(true);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
  }

  start(tenantId: string) {
    if (this.tenantId === tenantId && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.stop();
    this.tenantId = tenantId;
    this.connect(true);
  }

  stop() {
    this.tenantId = null;
    window.clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus("offline");
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === "live") this.ws.send(JSON.stringify(msg));
  }

  /** Users whose online / last-seen status this tab wants (re-sent after reconnects). */
  watch(userIds: string[]) {
    this.watching = userIds;
    this.send({ type: "presence.watch", userIds });
  }

  on(type: string, fn: Handler) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  onStatus(fn: (s: RealtimeStatus) => void) {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  private setStatus(s: RealtimeStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
    this.emit({ type: "status", status: s });
  }

  private emit(e: any) {
    for (const fn of this.handlers.get(e.type) ?? []) fn(e);
    for (const fn of this.handlers.get("*") ?? []) fn(e);
  }

  private connect(now = false) {
    window.clearTimeout(this.timer);
    if (!this.tenantId) return;
    const delay = now ? 0 : Math.min(30_000, 1000 * 2 ** this.retry) + Math.random() * 500;
    this.timer = window.setTimeout(() => this.open(), delay);
  }

  private open() {
    const tenantId = this.tenantId;
    const token = getAccessToken();
    if (!tenantId || !token) return this.setStatus("offline");
    this.ws?.close();
    this.setStatus("connecting");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, tenantId }));
    ws.onmessage = async (m) => {
      let e: any;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "message" && e.message?.sender_id !== this.userId) {
        // Acknowledge receipt (grey ✓✓ for the sender); batched when many arrive at once.
        window.clearTimeout(this.deliverTimer);
        this.deliverTimer = window.setTimeout(() => this.send({ type: "delivered" }), 300);
      }
      if (e.type === "ready") {
        this.userId = e.userId;
        this.retry = 0;
        this.setStatus("live");
        if (this.watching.length) this.send({ type: "presence.watch", userIds: this.watching });
        // Anything sent while we were away is now delivered here.
        this.send({ type: "delivered" });
      } else if (e.type === "auth.error") {
        if (e.code === "expired_token" && (await tryRefresh())) this.retry = 0;
        else this.retry = Math.max(this.retry, 4);
      }
      this.emit(e);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus(this.tenantId ? "connecting" : "offline");
      this.retry++;
      this.connect();
    };
  }
}

export const realtime = new Realtime();

/** Run `handler` for every event of `type` while the component is mounted. */
export function useRealtime(type: string, handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.on(type, (e) => ref.current(e)), [type]);
}

export function useRealtimeStatus() {
  const [s, setS] = useState<RealtimeStatus>(realtime.status);
  useEffect(() => {
    setS(realtime.status);
    return realtime.onStatus(setS);
  }, []);
  return s;
}
