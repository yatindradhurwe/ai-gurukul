import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Empty, ErrorNote, Field, Modal, PageTitle, Spinner, fmtDateTime } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
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

const roleOf = (roles: string[] = []) => roles.map((r) => ROLE[r] ?? r).join(", ");

export function MessagesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useApi<any>("/messages/conversations");
  const [composing, setComposing] = useState(false);
  const conversations: any[] = list.data?.conversations ?? [];

  return (
    <div className="space-y-5">
      <PageTitle
        title="Messages"
        icon="send"
        subtitle="Talk to teachers, parents and the school office."
        action={
          <button className="btn" onClick={() => setComposing(true)}>
            <Icon name="plus" size={16} /> New message
          </button>
        }
      />
      <ErrorNote message={list.error} />
      <div className="grid h-[calc(100vh-15rem)] min-h-[28rem] overflow-hidden rounded-[2rem] bg-white shadow-soft ring-1 ring-slate-200/70 md:grid-cols-[22rem_1fr]">
        <aside className={`flex flex-col border-r border-slate-100 ${id ? "hidden md:flex" : "flex"}`}>
          <div className="border-b border-slate-100 px-5 py-4 text-sm font-semibold text-slate-900">
            Inbox {list.data?.unread ? <span className="chip ml-1 bg-rose-100 text-rose-600">{list.data.unread} new</span> : null}
          </div>
          <div className="flex-1 overflow-y-auto">
            {list.loading && !list.data ? (
              <Spinner />
            ) : conversations.length === 0 ? (
              <div className="p-6">
                <Empty title="No messages yet" icon="send">
                  Start a conversation with a teacher or the office.
                </Empty>
              </div>
            ) : (
              conversations.map((c) => {
                const name = (c.others ?? []).map((o: any) => o.name).join(", ") || "Conversation";
                return (
                  <Link
                    key={c.id}
                    to={`/messages/${c.id}`}
                    className={`flex gap-3 border-b border-slate-50 px-5 py-3.5 transition ${c.id === id ? "bg-brand-soft" : "hover:bg-slate-50"}`}
                  >
                    <Avatar name={name} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={`truncate text-sm ${c.unread ? "font-bold text-slate-900" : "font-semibold text-slate-800"}`}>{name}</p>
                        <span className="shrink-0 text-[11px] text-slate-400">{fmtDateTime(c.last_message_at)}</span>
                      </div>
                      {(c.subject || c.student) && <p className="truncate text-xs font-medium text-brand">{[c.subject, c.student && `About ${c.student}`].filter(Boolean).join(" · ")}</p>}
                      <p className={`truncate text-xs ${c.unread ? "font-semibold text-slate-700" : "text-slate-500"}`}>
                        {c.last_mine && "You: "}
                        {c.last_body}
                      </p>
                    </div>
                    {c.unread > 0 && <span className="mt-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
                  </Link>
                );
              })
            )}
          </div>
        </aside>
        <section className={`flex min-w-0 flex-col ${id ? "flex" : "hidden md:flex"}`}>
          {id ? (
            <Thread id={id} onChanged={list.reload} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <Empty title="Choose a conversation" icon="send">
                Or start a new one with the button above.
              </Empty>
            </div>
          )}
        </section>
      </div>
      {composing && <Compose onClose={() => setComposing(false)} onSent={(cid) => (list.reload(), navigate(`/messages/${cid}`))} />}
    </div>
  );
}

function Thread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { user } = useAuth();
  const thread = useApi<any>(`/messages/conversations/${id}`);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const msgs: any[] = thread.data?.messages ?? [];

  useEffect(() => {
    if (thread.data) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.data?.conversation?.id]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs.length]);
  // Light polling so replies show up without a refresh.
  useEffect(() => {
    const t = window.setInterval(() => thread.reload(), 15000);
    return () => clearInterval(t);
  }, [thread.reload]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/messages/conversations/${id}`, { body: { body } });
      setBody("");
      await thread.reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (thread.loading && !thread.data) return <Spinner />;
  if (!thread.data) return <ErrorNote message={thread.error} />;
  const who = thread.data.members.find((m: any) => m.id !== user?.id);

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5">
        <Link to="/messages" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back to inbox">
          <Icon name="chevronLeft" />
        </Link>
        {who && <Avatar name={who.name} size={38} />}
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{who?.name}</p>
          <p className="truncate text-xs text-slate-500">
            {roleOf(who?.roles)}
            {thread.data.conversation.student && ` · About ${thread.data.conversation.student}`}
            {thread.data.conversation.subject && ` · ${thread.data.conversation.subject}`}
          </p>
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto bg-gradient-to-b from-slate-50/60 to-white px-5 py-5">
        {msgs.map((m, i) => {
          const showName = !m.mine && msgs[i - 1]?.sender_id !== m.sender_id;
          return (
            <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[78%]">
                {showName && <p className="mb-1 ml-1 text-[11px] font-semibold text-slate-500">{m.sender}</p>}
                <div
                  className={`whitespace-pre-line rounded-3xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                    m.mine ? "rounded-br-lg bg-gradient-to-br from-brand to-violet-500 text-white" : "rounded-bl-lg bg-white text-slate-800 ring-1 ring-slate-200"
                  }`}
                >
                  {m.body}
                </div>
                <p className={`mt-1 text-[10px] text-slate-400 ${m.mine ? "text-right" : "ml-1"}`}>{fmtDateTime(m.created_at)}</p>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex items-end gap-2 border-t border-slate-100 p-3">
        <textarea
          className="input max-h-40 min-h-[2.75rem] resize-none rounded-2xl"
          rows={1}
          placeholder="Write a message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
          }}
        />
        <button className="btn h-11 shrink-0 rounded-2xl" disabled={busy || !body.trim()} aria-label="Send">
          <Icon name="send" size={16} />
        </button>
      </form>
      <ErrorNote message={error} />
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
    <Modal open onClose={onClose} title="New message" wide>
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
