import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Spinner, Tabs, fmtDateTime } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useClasses } from "../lib/lms";
import { useApi } from "../lib/useApi";

const AUDIENCE: Record<string, string> = { all: "Everyone", staff: "Staff", students: "Students", parents: "Parents" };

export function AnnouncementsPage() {
  const { can, info } = useAuth();
  const feed = useApi<any>("/announcements");
  const manager = can("announcements.manage");
  const orgAdmin = can("members.manage") || can("tenant.manage");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const list: any[] = feed.data?.announcements ?? [];
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const shown = filter === "unread" ? list.filter((a) => !a.read || fresh.has(a.id)) : list;

  // Opening the page counts as reading it; keep the "New" highlight for this visit.
  useEffect(() => {
    const unread = list.filter((a) => !a.read);
    if (!unread.length) return;
    setFresh((f) => new Set([...f, ...unread.map((a) => a.id)]));
    Promise.all(unread.map((a) => api(`/announcements/${a.id}/read`, { body: {} }).catch(() => {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.data]);

  async function remove(id: string) {
    if (!confirm("Delete this announcement for everyone?")) return;
    await api(`/announcements/${id}`, { method: "DELETE" });
    feed.reload();
  }

  if (feed.loading && !feed.data) return <Spinner />;
  return (
    <div className="space-y-5">
      <PageTitle
        title="Announcements"
        icon="megaphone"
        subtitle="Notices for the whole school and for your classes."
        action={
          <>
            <Tabs value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread${feed.data?.unread ? ` (${feed.data.unread})` : ""}` }]} />
            {manager && (
              <button className="btn" onClick={() => setOpen(true)}>
                <Icon name="plus" size={16} /> New announcement
              </button>
            )}
          </>
        }
      />
      <ErrorNote message={feed.error} />
      {shown.length === 0 && <Empty title={filter === "unread" ? "You're all caught up" : "No announcements yet"} icon="megaphone">{manager ? "Post a notice to share news with your school or a class." : "Notices from your school will appear here."}</Empty>}
      <div className="space-y-3">
        {shown.map((a) => (
          <article key={a.id} className={`card animate-fade-up ${a.pinned ? "ring-amber-300/70" : ""} ${fresh.has(a.id) ? "border-l-4 border-l-brand" : ""}`}>
            <div className="flex items-start gap-4">
              <Avatar name={a.author} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {a.pinned && (
                    <Badge tone="amber">
                      <Icon name="pin" size={12} /> Pinned
                    </Badge>
                  )}
                  <Badge tone={a.class_name ? "sky" : "brand"}>{a.class_name ?? "Whole school"}</Badge>
                  {a.audience !== "all" && <Badge>{AUDIENCE[a.audience]}</Badge>}
                  {fresh.has(a.id) && <Badge tone="red">New</Badge>}
                </div>
                <h2 className="mt-2 text-lg font-semibold text-slate-900">{a.title}</h2>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600">{a.body}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{a.author}</span>
                  <span>{fmtDateTime(a.created_at)}</span>
                  {a.reads != null && <span>Seen by {a.reads}</span>}
                </div>
              </div>
              {(a.mine || orgAdmin) && manager && (
                <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove(a.id)} aria-label="Delete announcement">
                  <Icon name="trash" size={16} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {manager && <Compose open={open} onClose={() => setOpen(false)} orgAdmin={orgAdmin} onPosted={feed.reload} teaches={!!info?.permissions.includes("classes.manage")} />}
    </div>
  );
}

function Compose({ open, onClose, orgAdmin, onPosted, teaches }: { open: boolean; onClose: () => void; orgAdmin: boolean; onPosted: () => void; teaches: boolean }) {
  const { classes } = useClasses();
  const [form, setForm] = useState({ title: "", body: "", audience: "all", classId: "", pinned: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mustPickClass = !orgAdmin;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/announcements", { body: { ...form, classId: form.classId || null } });
      setForm({ title: "", body: "", audience: "all", classId: "", pinned: false });
      onPosted();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New announcement">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <input className="input" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Annual sports day on 14 November" />
        </Field>
        <Field label="Message">
          <textarea className="input min-h-[8rem]" required maxLength={5000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Post to">
            <select className="input" value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })} required={mustPickClass}>
              {orgAdmin ? <option value="">Whole school</option> : <option value="">Choose a class…</option>}
              {teaches &&
                classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Audience">
            <select className="input" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              {Object.entries(AUDIENCE).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
          Pin to the top
        </label>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            <Icon name="send" size={16} /> {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
