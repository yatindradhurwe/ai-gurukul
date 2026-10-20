import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Empty, ErrorNote, Field, Modal, Spinner } from "../components/ui";
import { api } from "../lib/api";
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
interface Msg {
  id: string;
  sender_id: string;
  sender: string;
  body: string | null;
  created_at: string;
  mine: boolean;
  local?: "pending" | "failed";
}

function Thread({ id, typing, onRead }: { id: string; typing: string[]; onRead: () => void }) {
  const { user } = useAuth();
  const thread = useApi<any>(`/messages/conversations/${id}`);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const atBottom = useRef(true);

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
      // Our own message coming back: replace the optimistic copy.
      const pending = mine ? list.findIndex((m) => m.local === "pending" && m.body === e.message.body) : -1;
      const next = { ...e.message, mine } as Msg;
      if (pending >= 0) return list.map((m, i) => (i === pending ? next : m));
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

  async function deliver(text: string, tempId: string) {
    try {
      const r = await api(`/messages/conversations/${id}`, { body: { body: text } });
      setMsgs((list) => {
        const real = { ...r.message, sender: user?.name ?? "", mine: true } as Msg;
        if (list.some((m) => m.id === real.id)) return list.filter((m) => m.id !== tempId);
        return list.map((m) => (m.id === tempId ? real : m));
      });
    } catch (err) {
      setMsgs((list) => list.map((m) => (m.id === tempId ? { ...m, local: "failed" } : m)));
      setError((err as Error).message);
    }
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody("");
    setError(null);
    realtime.send({ type: "typing", conversationId: id, typing: false });
    lastTyping.current = 0;
    const tempId = `local-${Date.now()}`;
    atBottom.current = true;
    setMsgs((list) => [...list, { id: tempId, sender_id: user!.id, sender: user!.name, body: text, created_at: new Date().toISOString(), mine: true, local: "pending" }]);
    deliver(text, tempId);
  }

  function retry(m: Msg) {
    setMsgs((list) => list.map((x) => (x.id === m.id ? { ...x, local: "pending" } : x)));
    deliver(m.body ?? "", m.id);
  }

  function onType(v: string) {
    setBody(v);
    const now = Date.now();
    if (v.trim() && now - lastTyping.current > 2500) {
      lastTyping.current = now;
      realtime.send({ type: "typing", conversationId: id });
    }
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
          <p className={`truncate text-xs ${typing.length || presence[who?.id]?.online ? "font-medium text-emerald-600" : "text-slate-500"}`}>
            {status || roleOf(who?.roles)}
          </p>
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
              return (
                <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"} ${first ? "pt-1.5" : ""}`}>
                  <div
                    className={`relative max-w-[80%] rounded-2xl px-3 pb-1.5 pt-2 text-sm leading-relaxed shadow-sm sm:max-w-[65%] ${
                      m.mine ? `bg-[#d9fdd3] text-slate-900 ${first ? "rounded-tr-sm" : ""}` : `bg-white text-slate-800 ${first ? "rounded-tl-sm" : ""}`
                    }`}
                  >
                    {group && !m.mine && first && <p className="mb-0.5 text-[11px] font-semibold text-brand">{m.sender}</p>}
                    <span className="whitespace-pre-wrap break-words">{m.body}</span>
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
      <form onSubmit={send} className="flex items-end gap-2 border-t border-slate-100 bg-slate-50 p-2.5">
        <textarea
          className="input max-h-40 min-h-[2.75rem] resize-none rounded-3xl border-0 bg-white px-4 py-3 shadow-sm"
          rows={1}
          placeholder="Type a message"
          value={body}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Message"
        />
        <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md transition hover:bg-emerald-600 disabled:opacity-40" disabled={!body.trim()} aria-label="Send">
          <Icon name="send" size={18} />
        </button>
      </form>
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
