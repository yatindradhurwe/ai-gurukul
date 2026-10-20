import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Empty, ErrorNote, Field, Modal, Spinner } from "../components/ui";
import { api, apiBlob } from "../lib/api";
import { useAuth } from "../lib/auth";
import { realtime, useRealtime, useRealtimeStatus } from "../lib/realtime";
import { useApi } from "../lib/useApi";

const ROLE: Record<string, string> = {
  tenant_owner: "Principal",
  tenant_admin: "Admin",
  teacher: "Teacher",
  staff: "Office",
  accountant: "Accounts",
  librarian: "Library",
  transport_manager: "Transport",
  warden: "Warden",
  parent: "Parent",
  student: "Student",
};

const roleOf = (roles: string[] = []) => roles.filter(Boolean).map((r) => ROLE[r] ?? r).join(", ");

// ---------------------------------------------------------------------------
// Time formatting, WhatsApp style
// ---------------------------------------------------------------------------
const IST = "Asia/Kolkata";
const dayKey = (d: string | Date) => new Date(d).toLocaleDateString("en-CA", { timeZone: IST });
const clock = (d: string | Date) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: IST });
function dayLabel(d: string | Date) {
  const k = dayKey(d);
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  if (k === today) return "Today";
  if (k === yesterday) return "Yesterday";
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: new Date(d).getFullYear() === new Date().getFullYear() ? undefined : "numeric", timeZone: IST });
}
/** Inbox time: "10:42 am" today, "Yesterday", or a short date. */
function listTime(d: string) {
  const l = dayLabel(d);
  if (l === "Today") return clock(d);
  if (l === "Yesterday") return l;
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: IST });
}
function lastSeen(p?: { online: boolean; lastSeen: string | null }) {
  if (!p) return "";
  if (p.online) return "online";
  if (!p.lastSeen) return "";
  const l = dayLabel(p.lastSeen);
  return `last seen ${l === "Today" ? "today" : l === "Yesterday" ? "yesterday" : l} at ${clock(p.lastSeen)}`;
}

type Tick = "pending" | "failed" | "sent" | "delivered" | "read";
function Ticks({ state }: { state: Tick }) {
  if (state === "pending") return <Icon name="clock" size={13} className="text-current opacity-70" aria-label="Sending" />;
  if (state === "failed") return <Icon name="alert" size={13} className="text-red-300" aria-label="Not sent" />;
  const double = state !== "sent";
  return (
    <span className={`inline-flex ${state === "read" ? "text-sky-300" : "opacity-70"}`} aria-label={state === "read" ? "Read" : state === "delivered" ? "Delivered" : "Sent"}>
      <Icon name="check" size={13} />
      {double && <Icon name="check" size={13} className="-ml-2" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared live state for the page: presence of people on screen, and who's typing
// ---------------------------------------------------------------------------
type Presence = Record<string, { online: boolean; lastSeen: string | null }>;

function usePresence(userIds: string[]) {
  const [presence, setPresence] = useState<Presence>({});
  const key = [...new Set(userIds)].sort().join(",");
  useEffect(() => {
    realtime.watch(key ? key.split(",") : []);
    return () => realtime.watch([]);
  }, [key]);
  useRealtime("presence", (e) => setPresence((p) => ({ ...p, ...Object.fromEntries(e.users.map((u: any) => [u.userId, { online: u.online, lastSeen: u.lastSeen }])) })));
  return presence;
}

/** conversationId → names typing right now (cleared 4 s after the last keystroke event). */
function useTyping() {
  const [typing, setTyping] = useState<Record<string, Record<string, string>>>({});
  const timers = useRef<Record<string, number>>({});
  useRealtime("typing", (e) => {
    const k = `${e.conversationId}:${e.userId}`;
    window.clearTimeout(timers.current[k]);
    const stop = () =>
      setTyping((t) => {
        const c = { ...(t[e.conversationId] ?? {}) };
        delete c[e.userId];
        return { ...t, [e.conversationId]: c };
      });
    if (e.typing === false) return stop();
    setTyping((t) => ({ ...t, [e.conversationId]: { ...(t[e.conversationId] ?? {}), [e.userId]: e.name } }));
    timers.current[k] = window.setTimeout(stop, 4000);
  });
  // A message from someone ends their typing indicator.
  useRealtime("message", (e) =>
    setTyping((t) => {
      const c = { ...(t[e.conversationId] ?? {}) };
      delete c[e.message?.sender_id];
      return { ...t, [e.conversationId]: c };
    }),
  );
  return typing;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function MessagesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const list = useApi<any>("/messages/conversations");
  const status = useRealtimeStatus();
  const [composing, setComposing] = useState(false);
  const [q, setQ] = useState("");
  const typing = useTyping();
  const conversations: any[] = list.data?.conversations ?? [];
  const { setData, reload } = list;

  // Keep the inbox current without refetching on every event.
  useRealtime("message", (e) => {
    if (!e.message || !conversations.some((c) => c.id === e.conversationId)) return reload();
    const mine = e.message.sender_id === user?.id;
    setData((d: any) => {
      if (!d) return d;
      const rows = d.conversations.map((c: any) =>
        c.id === e.conversationId
          ? { ...c, last_body: e.message.body ?? c.last_body, last_mine: mine, last_message_at: e.message.created_at, unread: mine || c.id === id ? 0 : c.unread + 1 }
          : c,
      );
      rows.sort((a: any, b: any) => +new Date(b.last_message_at) - +new Date(a.last_message_at));
      return { ...d, conversations: rows, unread: rows.reduce((t: number, c: any) => t + c.unread, 0) };
    });
  });
  useRealtime("receipt", (e) => {
    if (e.userId === user?.id) {
      // Read on another device or tab.
      if (e.readAt) setData((d: any) => d && { ...d, conversations: d.conversations.map((c: any) => (c.id === e.conversationId ? { ...c, unread: 0 } : c)) });
      return;
    }
    setData((d: any) => d && { ...d, conversations: d.conversations.map((c: any) => (c.id === e.conversationId ? { ...c, others_read_at: e.readAt, others_delivered_at: e.deliveredAt } : c)) });
  });
  // Fall back to light polling while the live connection is down.
  useEffect(() => {
    if (status === "live") return;
    const t = window.setInterval(reload, 20000);
    return () => clearInterval(t);
  }, [status, reload]);

  const filtered = conversations.filter((c) => {
    if (!q.trim()) return true;
    const hay = `${(c.others ?? []).map((o: any) => o.name).join(" ")} ${c.subject ?? ""} ${c.student ?? ""} ${c.last_body ?? ""}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 animate-fade-up">
        <div className="flex items-center gap-3">
          <div className="hidden h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand sm:flex">
            <Icon name="send" size={22} />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900">Messages</h1>
            <p className="flex items-center gap-1.5 text-sm text-slate-500">
              <span className={`h-2 w-2 rounded-full ${status === "live" ? "bg-emerald-500" : "animate-pulse bg-amber-400"}`} />
              {status === "live" ? "Live — messages arrive instantly" : "Connecting…"}
            </p>
          </div>
        </div>
        <button className="btn" onClick={() => setComposing(true)}>
          <Icon name="plus" size={16} /> New chat
        </button>
      </div>
      <ErrorNote message={list.error} />
      <div className="grid h-[calc(100vh-12.5rem)] min-h-[30rem] overflow-hidden rounded-[2rem] bg-white shadow-soft ring-1 ring-slate-200/70 md:grid-cols-[23rem_1fr]">
        <aside className={`flex min-h-0 flex-col border-r border-slate-100 ${id ? "hidden md:flex" : "flex"}`}>
          <div className="border-b border-slate-100 p-3">
            <input className="input rounded-full bg-slate-50" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.loading && !list.data ? (
              <Spinner />
            ) : filtered.length === 0 ? (
              <div className="p-6">
                <Empty title={q ? "No chats match" : "No messages yet"} icon="send">
                  {q ? "Try another name." : "Start a chat with a teacher, a parent or the office."}
                </Empty>
              </div>
            ) : (
              filtered.map((c) => <InboxRow key={c.id} c={c} active={c.id === id} typing={Object.values(typing[c.id] ?? {})} />)
            )}
          </div>
        </aside>
        <section className={`flex min-h-0 min-w-0 flex-col ${id ? "flex" : "hidden md:flex"}`}>
          {id ? (
            <Thread key={id} id={id} typing={Object.values(typing[id] ?? {})} onRead={() => setData((d: any) => d && { ...d, conversations: d.conversations.map((c: any) => (c.id === id ? { ...c, unread: 0 } : c)) })} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-gradient-to-b from-slate-50/80 to-white p-8 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-soft text-brand">
                <Icon name="send" size={28} />
              </span>
              <p className="font-semibold text-slate-800">Choose a chat</p>
              <p className="max-w-xs text-sm text-slate-500">Messages are delivered instantly. Grey ticks mean delivered; blue ticks mean read.</p>
            </div>
          )}
        </section>
      </div>
      {composing && <Compose onClose={() => setComposing(false)} onSent={(cid) => (reload(), navigate(`/messages/${cid}`))} />}
    </div>
  );
}

function InboxRow({ c, active, typing }: { c: any; active: boolean; typing: string[] }) {
  const name = (c.others ?? []).map((o: any) => o.name).join(", ") || "Conversation";
  const tick: Tick | null = c.last_mine
    ? c.others_read_at && new Date(c.others_read_at) >= new Date(c.last_message_at)
      ? "read"
      : c.others_delivered_at && new Date(c.others_delivered_at) >= new Date(c.last_message_at)
        ? "delivered"
        : "sent"
    : null;
  return (
    <Link to={`/messages/${c.id}`} className={`flex gap-3 border-b border-slate-50 px-4 py-3 transition ${active ? "bg-brand-soft" : "hover:bg-slate-50"}`}>
      <Avatar name={name} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={`truncate text-sm ${c.unread ? "font-bold text-slate-900" : "font-semibold text-slate-800"}`}>{name}</p>
          <span className={`shrink-0 text-[11px] ${c.unread ? "font-semibold text-emerald-600" : "text-slate-400"}`}>{listTime(c.last_message_at)}</span>
        </div>
        {(c.subject || c.student) && <p className="truncate text-[11px] font-medium text-brand">{[c.subject, c.student && `About ${c.student}`].filter(Boolean).join(" · ")}</p>}
        <div className="flex items-center gap-2">
          <p className={`flex min-w-0 flex-1 items-center gap-1 truncate text-xs ${typing.length ? "font-semibold text-emerald-600" : c.unread ? "font-semibold text-slate-700" : "text-slate-500"}`}>
            {typing.length ? (
              "typing…"
            ) : (
              <>
                {tick && (
                  <span className={tick === "read" ? "text-sky-500" : "text-slate-400"}>
                    <Ticks state={tick} />
                  </span>
                )}
                <span className="truncate">{c.last_body}</span>
              </>
            )}
          </p>
          {c.unread > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// A conversation
// ---------------------------------------------------------------------------
interface Attachment {
  id: string;
  kind: "image" | "audio" | "file";
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  localUrl?: string;
}
interface Msg {
  id: string;
  sender_id: string;
  sender: string;
  body: string | null;
  created_at: string;
  mine: boolean;
  reply_to?: { id: string; sender_id: string; sender: string; body: string | null; kind: string | null } | null;
  attachment?: Attachment | null;
  local?: "pending" | "failed";
}
interface Outgoing {
  body: string;
  replyToId: string | null;
  attachment: { fileName: string; mimeType: string; data: string; durationMs?: number } | null;
}

const MAX_MB = 10;
const fileSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(blob);
  });
const replyPreview = (r: { body: string | null; kind: string | null }) =>
  r.body || (r.kind === "image" ? "📷 Photo" : r.kind === "audio" ? "🎤 Voice note" : r.kind === "file" ? "📎 File" : "");

// Downloaded attachments are kept for the session so scrolling doesn't refetch them.
const blobCache = new Map<string, Promise<string>>();
function useAttachmentUrl(a: Attachment | null | undefined, enabled = true) {
  const [url, setUrl] = useState<string | null>(a?.localUrl ?? null);
  useEffect(() => {
    if (!a || a.localUrl || !enabled || a.id.startsWith("local-")) return;
    let live = true;
    if (!blobCache.has(a.id)) blobCache.set(a.id, apiBlob(`/messages/attachments/${a.id}`).then((b) => URL.createObjectURL(b)));
    blobCache
      .get(a.id)!
      .then((u) => live && setUrl(u))
      .catch(() => blobCache.delete(a.id));
    return () => {
      live = false;
    };
  }, [a, enabled]);
  return url;
}

function ImageAttachment({ a, onOpen }: { a: Attachment; onOpen: (url: string) => void }) {
  const url = useAttachmentUrl(a);
  return (
    <button type="button" className="mb-1 block overflow-hidden rounded-xl bg-slate-200/60" onClick={() => url && onOpen(url)} aria-label={`Open ${a.file_name}`}>
      {url ? <img src={url} alt={a.file_name} className="max-h-72 w-full max-w-xs object-cover" /> : <div className="flex h-40 w-56 items-center justify-center text-slate-400"><Spinner /></div>}
    </button>
  );
}

function VoiceNote({ a, mine }: { a: Attachment; mine: boolean }) {
  const [want, setWant] = useState(false);
  const url = useAttachmentUrl(a, want);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const total = (a.duration_ms ?? 0) / 1000;
  useEffect(() => {
    if (url && want && audio.current && audio.current.paused) audio.current.play().catch(() => {});
  }, [url, want]);
  const toggle = () => {
    if (!url) return setWant(true);
    const el = audio.current!;
    el.paused ? el.play().catch(() => {}) : el.pause();
  };
  const length = audio.current?.duration && Number.isFinite(audio.current.duration) ? audio.current.duration : total;
  return (
    <div className="mb-1 flex w-60 items-center gap-2.5">
      <button type="button" onClick={toggle} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${mine ? "bg-emerald-600 text-white" : "bg-brand text-white"}`} aria-label={playing ? "Pause" : "Play voice note"}>
        {want && !url ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name={playing ? "pause" : "play"} size={16} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-300/70">
          <div className={`h-full ${mine ? "bg-emerald-600" : "bg-brand"}`} style={{ width: `${length ? Math.min(100, (pos / length) * 100) : 0}%` }} />
        </div>
        <p className="mt-1 text-[10px] text-slate-500">{duration((playing || pos ? pos : length) * 1000)}</p>
      </div>
      <Icon name="mic" size={14} className="shrink-0 text-slate-400" />
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => (setPlaying(false), setPos(0))}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        />
      )}
    </div>
  );
}

function FileAttachment({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const blob = await apiBlob(`/messages/attachments/${a.id}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.file_name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setBusy(false);
    }
  };
  const ext = a.file_name.split(".").pop()?.toUpperCase().slice(0, 4) ?? "FILE";
  return (
    <button type="button" onClick={open} disabled={a.id.startsWith("local-")} className="mb-1 flex w-64 max-w-full items-center gap-3 rounded-xl bg-black/5 p-2.5 text-left transition hover:bg-black/10">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-[10px] font-bold text-brand shadow-sm">{ext}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900">{a.file_name}</span>
        <span className="block text-[11px] text-slate-500">{fileSize(a.size_bytes)}</span>
      </span>
      {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" /> : <Icon name="arrowRight" size={16} className="rotate-90 text-slate-500" />}
    </button>
  );
}

/** Record a voice note with the microphone; resolves with the recording, or null if cancelled. */
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; started: number; stream: MediaStream; done?: (r: { blob: Blob; ms: number } | null) => void; cancel?: boolean } | null>(null);
  const tick = useRef<number>();
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const r = { mr, chunks: [] as Blob[], started: Date.now(), stream } as NonNullable<typeof rec.current>;
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearInterval(tick.current);
      setRecording(false);
      r.done?.(r.cancel || !r.chunks.length ? null : { blob: new Blob(r.chunks, { type: mr.mimeType || type || "audio/webm" }), ms: Date.now() - r.started });
    };
    rec.current = r;
    mr.start(250);
    setElapsed(0);
    setRecording(true);
    tick.current = window.setInterval(() => setElapsed(Date.now() - r.started), 200);
  };
  const stop = (cancel = false) =>
    new Promise<{ blob: Blob; ms: number } | null>((resolve) => {
      const r = rec.current;
      if (!r) return resolve(null);
      r.cancel = cancel;
      r.done = resolve;
      r.mr.stop();
      rec.current = null;
    });
  useEffect(
    () => () => {
      if (rec.current?.mr.state === "recording") rec.current.mr.stop();
    },
    [],
  );
  return { recording, elapsed, start, stop };
}

function Thread({ id, typing, onRead }: { id: string; typing: string[]; onRead: () => void }) {
  const { user } = useAuth();
  const thread = useApi<any>(`/messages/conversations/${id}`);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const atBottom = useRef(true);
  const outgoing = useRef(new Map<string, Outgoing>());
  const recorder = useRecorder();

  useEffect(() => {
    if (!thread.data) return;
    setMsgs(thread.data.messages);
    setMembers(thread.data.members);
    onRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.data]);

  const others = members.filter((m) => m.id !== user?.id);
  const presence = usePresence(others.map((m) => m.id));
  const scrollDown = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useEffect(() => {
    if (atBottom.current) scrollDown(msgs.length > 0);
  }, [msgs.length, typing.length, scrollDown]);

  const markRead = useCallback(() => {
    if (document.visibilityState === "visible") api(`/messages/conversations/${id}/read`, { method: "POST" }).catch(() => {});
  }, [id]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && markRead();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [markRead]);

  useRealtime("message", (e) => {
    if (e.conversationId !== id) return;
    if (e.truncated || e.message?.body == null) return thread.reload();
    setMsgs((list) => {
      if (list.some((m) => m.id === e.message.id)) return list;
      const mine = e.message.sender_id === user?.id;
      const next = { ...e.message, mine } as Msg;
      // Our own message coming back over the socket: replace the optimistic copy.
      const pending = mine
        ? list.findIndex((m) => m.local === "pending" && (m.body ?? "") === (next.body ?? "") && (m.attachment?.file_name ?? null) === (next.attachment?.file_name ?? null))
        : -1;
      if (pending >= 0) {
        outgoing.current.delete(list[pending].id);
        return list.map((m, i) => (i === pending ? next : m));
      }
      return [...list, next];
    });
    if (e.message.sender_id !== user?.id) {
      markRead();
      onRead();
    }
  });
  useRealtime("receipt", (e) => {
    if (e.conversationId !== id) return;
    setMembers((ms) => ms.map((m) => (m.id === e.userId ? { ...m, last_read_at: e.readAt ?? m.last_read_at, last_delivered_at: e.deliveredAt ?? m.last_delivered_at } : m)));
  });
  // Reconnected after a gap: catch up on anything missed.
  useRealtime("ready", () => thread.reload());

  const tickFor = (m: Msg): Tick => {
    if (m.local) return m.local;
    const t = new Date(m.created_at).getTime();
    if (!others.length) return "sent";
    if (others.every((o) => o.last_read_at && new Date(o.last_read_at).getTime() >= t)) return "read";
    if (others.every((o) => o.last_delivered_at && new Date(o.last_delivered_at).getTime() >= t)) return "delivered";
    return "sent";
  };

  async function deliver(tempId: string) {
    const out = outgoing.current.get(tempId);
    if (!out) return;
    try {
      const r = await api(`/messages/conversations/${id}`, { body: out });
      outgoing.current.delete(tempId);
      setMsgs((list) => {
        const real = { ...r.message, mine: true } as Msg;
        if (list.some((m) => m.id === real.id)) return list.filter((m) => m.id !== tempId);
        return list.map((m) => (m.id === tempId ? { ...real, attachment: real.attachment && { ...real.attachment, localUrl: m.attachment?.localUrl } } : m));
      });
    } catch (err) {
      setMsgs((list) => list.map((m) => (m.id === tempId ? { ...m, local: "failed" } : m)));
      setError((err as Error).message);
    }
  }

  /** Show the message at once, then send it. */
  function queue(out: Outgoing, preview: Partial<Msg> = {}) {
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    outgoing.current.set(tempId, out);
    atBottom.current = true;
    const quoted = replyTo ? { id: replyTo.id, sender_id: replyTo.sender_id, sender: replyTo.sender, body: replyTo.body, kind: replyTo.attachment?.kind ?? null } : null;
    setMsgs((list) => [...list, { id: tempId, sender_id: user!.id, sender: user!.name, body: out.body, created_at: new Date().toISOString(), mine: true, local: "pending", reply_to: quoted, ...preview }]);
    setReplyTo(null);
    setError(null);
    deliver(tempId);
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody("");
    realtime.send({ type: "typing", conversationId: id, typing: false });
    lastTyping.current = 0;
    queue({ body: text, replyToId: replyTo?.id ?? null, attachment: null });
  }

  async function attach(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) return setError(`Files can be at most ${MAX_MB} MB`);
    const data = await toBase64(file);
    const kind: Attachment["kind"] = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file";
    const caption = body.trim();
    setBody("");
    queue(
      { body: caption, replyToId: replyTo?.id ?? null, attachment: { fileName: file.name, mimeType: file.type || "application/octet-stream", data } },
      { attachment: { id: `local-${file.name}`, kind, file_name: file.name, mime_type: file.type, size_bytes: file.size, duration_ms: null, localUrl: kind === "image" ? URL.createObjectURL(file) : undefined } },
    );
  }

  async function startVoice() {
    setError(null);
    try {
      await recorder.start();
    } catch {
      setError("Allow microphone access in your browser to record a voice note.");
    }
  }

  async function finishVoice(cancel: boolean) {
    const r = await recorder.stop(cancel);
    if (!r || r.ms < 700) return;
    const ext = r.blob.type.includes("mp4") ? "m4a" : r.blob.type.includes("ogg") ? "ogg" : "webm";
    const data = await toBase64(r.blob);
    queue(
      { body: "", replyToId: replyTo?.id ?? null, attachment: { fileName: `voice-note.${ext}`, mimeType: r.blob.type, data, durationMs: r.ms } },
      { attachment: { id: "local-voice", kind: "audio", file_name: `voice-note.${ext}`, mime_type: r.blob.type, size_bytes: r.blob.size, duration_ms: r.ms, localUrl: URL.createObjectURL(r.blob) } },
    );
  }

  function retry(m: Msg) {
    setMsgs((list) => list.map((x) => (x.id === m.id ? { ...x, local: "pending" } : x)));
    deliver(m.id);
  }

  function onType(v: string) {
    setBody(v);
    const now = Date.now();
    if (v.trim() && now - lastTyping.current > 2500) {
      lastTyping.current = now;
      realtime.send({ type: "typing", conversationId: id });
    }
  }

  function jumpTo(messageId: string) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400");
    setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
  }

  function startReply(m: Msg) {
    if (m.local) return;
    setReplyTo(m);
    input.current?.focus();
  }

  const groups = useMemo(() => {
    const out: { day: string; items: Msg[] }[] = [];
    for (const m of msgs) {
      const day = dayLabel(m.created_at);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(m);
    }
    return out;
  }, [msgs]);

  if (thread.loading && !thread.data) return <Spinner />;
  if (!thread.data) return <ErrorNote message={thread.error} />;
  const who = others[0];
  const group = others.length > 1;
  const status = typing.length ? (group ? `${typing.join(", ")} typing…` : "typing…") : group ? others.map((o) => o.name).join(", ") : lastSeen(presence[who?.id]);
  const nameOf = (senderId: string, sender: string) => (senderId === user?.id ? "You" : sender);

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-100 bg-white px-4 py-3">
        <Link to="/messages" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back to chats">
          <Icon name="chevronLeft" />
        </Link>
        <span className="relative">
          <Avatar name={group ? others.map((o) => o.name).join(" ") : (who?.name ?? "?")} size={40} />
          {!group && presence[who?.id]?.online && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{group ? thread.data.conversation.subject || "Group" : who?.name}</p>
          <p className={`truncate text-xs ${typing.length || presence[who?.id]?.online ? "font-medium text-emerald-600" : "text-slate-500"}`}>{status || roleOf(who?.roles)}</p>
        </div>
        <div className="hidden text-right text-xs text-slate-500 sm:block">
          {roleOf(who?.roles)}
          {thread.data.conversation.student && <p className="font-medium text-brand">About {thread.data.conversation.student}</p>}
        </div>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-[#efeae2] bg-[radial-gradient(rgb(0_0_0/0.035)_1px,transparent_1px)] px-3 py-4 [background-size:18px_18px] sm:px-6"
      >
        {thread.data.conversation.subject && !group && (
          <p className="mx-auto mb-3 w-fit rounded-lg bg-amber-50 px-3 py-1 text-center text-xs text-amber-800 shadow-sm">Subject: {thread.data.conversation.subject}</p>
        )}
        {groups.map((g) => (
          <div key={g.day} className="space-y-1">
            <p className="sticky top-0 z-10 mx-auto my-3 w-fit rounded-lg bg-white/90 px-3 py-1 text-[11px] font-semibold text-slate-500 shadow-sm backdrop-blur">{g.day}</p>
            {g.items.map((m, i) => {
              const prev = g.items[i - 1];
              const first = !prev || prev.sender_id !== m.sender_id;
              const a = m.attachment;
              return (
                <div key={m.id} className={`group flex items-center gap-1 ${m.mine ? "flex-row-reverse" : ""} ${first ? "pt-1.5" : ""}`} onDoubleClick={() => startReply(m)}>
                  <div
                    id={`msg-${m.id}`}
                    className={`relative max-w-[80%] rounded-2xl px-2.5 pb-1.5 pt-2 text-sm leading-relaxed shadow-sm transition sm:max-w-[65%] ${
                      m.mine ? `bg-[#d9fdd3] text-slate-900 ${first ? "rounded-tr-sm" : ""}` : `bg-white text-slate-800 ${first ? "rounded-tl-sm" : ""}`
                    }`}
                  >
                    {group && !m.mine && first && <p className="mb-0.5 px-0.5 text-[11px] font-semibold text-brand">{m.sender}</p>}
                    {m.reply_to && (
                      <button
                        type="button"
                        onClick={() => jumpTo(m.reply_to!.id)}
                        className={`mb-1 block w-full rounded-lg border-l-4 px-2 py-1 text-left text-xs ${m.mine ? "border-emerald-600 bg-emerald-900/5" : "border-brand bg-slate-100"}`}
                      >
                        <span className={`block font-semibold ${m.mine ? "text-emerald-700" : "text-brand"}`}>{nameOf(m.reply_to.sender_id, m.reply_to.sender)}</span>
                        <span className="line-clamp-2 text-slate-600">{replyPreview(m.reply_to)}</span>
                      </button>
                    )}
                    {a?.kind === "image" && <ImageAttachment a={a} onOpen={setViewer} />}
                    {a?.kind === "audio" && <VoiceNote a={a} mine={m.mine} />}
                    {a?.kind === "file" && <FileAttachment a={a} />}
                    {m.body && <span className="whitespace-pre-wrap break-words px-0.5">{m.body}</span>}
                    <span className="float-right ml-3 mt-1.5 inline-flex translate-y-0.5 items-center gap-1 text-[10px] text-slate-500">
                      {clock(m.created_at)}
                      {m.mine && (
                        <span className={tickFor(m) === "read" ? "text-sky-500" : "text-slate-500"}>
                          <Ticks state={tickFor(m)} />
                        </span>
                      )}
                    </span>
                    {m.local === "failed" && (
                      <button className="mt-1 block text-[11px] font-semibold text-red-600" onClick={() => retry(m)}>
                        Not sent — tap to retry
                      </button>
                    )}
                  </div>
                  {!m.local && (
                    <button
                      type="button"
                      onClick={() => startReply(m)}
                      className="rounded-full bg-white/80 p-1.5 text-slate-500 opacity-0 shadow-sm transition hover:text-slate-900 focus:opacity-100 group-hover:opacity-100 max-sm:opacity-60"
                      aria-label="Reply"
                      title="Reply"
                    >
                      <Icon name="reply" size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {typing.length > 0 && (
          <div className="flex justify-start pt-2">
            <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-white px-4 py-3 shadow-sm" aria-label="Typing">
              {[0, 150, 300].map((d) => (
                <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      <div className="border-t border-slate-100 bg-slate-50">
        {replyTo && (
          <div className="mx-2.5 mt-2.5 flex items-start gap-2 rounded-xl border-l-4 border-brand bg-white px-3 py-2 shadow-sm">
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-semibold text-brand">Replying to {nameOf(replyTo.sender_id, replyTo.sender)}</p>
              <p className="truncate text-slate-600">{replyPreview({ body: replyTo.body, kind: replyTo.attachment?.kind ?? null })}</p>
            </div>
            <button type="button" className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        {recorder.recording ? (
          <div className="flex items-center gap-3 p-2.5">
            <button type="button" className="rounded-full p-2.5 text-slate-500 hover:bg-slate-200 hover:text-red-600" onClick={() => finishVoice(true)} aria-label="Cancel recording">
              <Icon name="trash" size={18} />
            </button>
            <div className="flex flex-1 items-center gap-2 rounded-3xl bg-white px-4 py-3 shadow-sm">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
              <span className="text-sm font-medium text-slate-700">Recording {duration(recorder.elapsed)}</span>
            </div>
            <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md hover:bg-emerald-600" onClick={() => finishVoice(false)} aria-label="Send voice note">
              <Icon name="send" size={18} />
            </button>
          </div>
        ) : (
          <form onSubmit={send} className="flex items-end gap-2 p-2.5">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) attach(f).catch((x) => setError((x as Error).message));
              }}
            />
            <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200 hover:text-slate-800" onClick={() => fileInput.current?.click()} aria-label="Attach a photo or file" title="Photo or file">
              <Icon name="paperclip" size={19} />
            </button>
            <textarea
              ref={input}
              className="input max-h-40 min-h-[2.75rem] resize-none rounded-3xl border-0 bg-white px-4 py-3 shadow-sm"
              rows={1}
              placeholder="Type a message"
              value={body}
              onChange={(e) => onType(e.target.value)}
              onPaste={(e) => {
                const f = [...e.clipboardData.files][0];
                if (f) {
                  e.preventDefault();
                  attach(f).catch((x) => setError((x as Error).message));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                } else if (e.key === "Escape") setReplyTo(null);
              }}
              aria-label="Message"
            />
            {body.trim() ? (
              <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md transition hover:bg-emerald-600" aria-label="Send">
                <Icon name="send" size={18} />
              </button>
            ) : (
              <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md transition hover:bg-emerald-600" onClick={startVoice} aria-label="Record a voice note" title="Voice note">
                <Icon name="mic" size={18} />
              </button>
            )}
          </form>
        )}
      </div>
      {viewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4" onClick={() => setViewer(null)}>
          <img src={viewer} alt="" className="max-h-full max-w-full rounded-xl shadow-2xl" />
          <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
      )}
    </>
  );
}

function Compose({ onClose, onSent }: { onClose: () => void; onSent: (id: string) => void }) {
  const c = useApi<any>("/messages/contacts");
  const [form, setForm] = useState({ recipientId: "", studentId: "", subject: "", body: "" });
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contacts: any[] = (c.data?.contacts ?? []).filter((x: any) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
  const children: any[] = c.data?.children ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api("/messages/conversations", { body: { ...form, studentId: form.studentId || null } });
      onSent(r.conversationId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open onClose={onClose} title="New chat" wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="To">
          <input className="input mb-2" placeholder="Search people" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="grid max-h-52 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {contacts.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setForm({ ...form, recipientId: p.id })}
                className={`flex items-center gap-2.5 rounded-2xl p-2 text-left ring-1 transition ${form.recipientId === p.id ? "bg-brand-soft ring-brand" : "ring-slate-200 hover:bg-slate-50"}`}
              >
                <Avatar name={p.name} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-900">{p.name}</span>
                  <span className="block truncate text-xs text-slate-500">{roleOf(p.roles)}</span>
                </span>
              </button>
            ))}
            {!c.loading && contacts.length === 0 && <p className="text-sm text-slate-500">No one to message yet.</p>}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {children.length > 0 && (
            <Field label="About">
              <select className="input" value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>
                <option value="">General</option>
                {children.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Subject (optional)">
            <input className="input" maxLength={160} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
        </div>
        <Field label="Message">
          <textarea className="input min-h-[7rem]" required maxLength={5000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!form.recipientId}>
            <Icon name="send" size={16} /> Send
          </button>
        </div>
      </form>
    </Modal>
  );
}
