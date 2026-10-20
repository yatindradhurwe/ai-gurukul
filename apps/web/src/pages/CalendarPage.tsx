import { useMemo, useState, type FormEvent } from "react";
import { Icon } from "../components/icons";
import { ErrorNote, Field, Modal, PageTitle, SectionCard, Spinner, fmtDate, todayISO } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";

const KINDS: Record<string, { label: string; dot: string; chip: string }> = {
  holiday: { label: "Holiday", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  exam: { label: "Exam", dot: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  event: { label: "Event", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200" },
  meeting: { label: "Meeting", dot: "bg-sky-500", chip: "bg-sky-50 text-sky-700 ring-sky-200" },
  sports: { label: "Sports", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  cultural: { label: "Cultural", dot: "bg-fuchsia-500", chip: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200" },
};
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarPage() {
  const { can } = useAuth();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [adding, setAdding] = useState<string | null>(null);
  const first = cursor;
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const offset = (first.getDay() + 6) % 7; // Monday-first weeks
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - offset);
  const cells = Array.from({ length: offset + last.getDate() > 35 ? 42 : 35 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const from = iso(cells[0]);
  const to = iso(cells[cells.length - 1]);
  const data = useApi<any>(`/events?from=${from}&to=${to}`);
  const today = todayISO();

  const byDay = useMemo(() => {
    const m: Record<string, { id: string; title: string; kind: string }[]> = {};
    for (const e of data.data?.events ?? []) {
      for (let d = new Date(`${e.start_date}T00:00:00`); iso(d) <= e.end_date; d.setDate(d.getDate() + 1)) (m[iso(d)] ??= []).push({ id: e.id, title: e.title, kind: e.kind });
    }
    for (const x of data.data?.exams ?? []) (m[x.date] ??= []).push({ id: x.id, title: `${x.subject} · ${x.class_name}`, kind: "exam" });
    return m;
  }, [data.data]);

  const upcoming = [...(data.data?.events ?? [])].filter((e) => e.end_date >= today && e.start_date <= iso(last)).slice(0, 8);
  const remove = async (id: string) => {
    if (!confirm("Remove this event from the calendar?")) return;
    await api(`/events/${id}`, { method: "DELETE" });
    data.reload();
  };

  return (
    <div className="space-y-5">
      <PageTitle
        title="School calendar"
        icon="calendar"
        subtitle="Holidays, exams, events and meetings."
        action={
          can("announcements.manage") && (
            <button className="btn" onClick={() => setAdding(today)}>
              <Icon name="plus" size={16} /> Add event
            </button>
          )
        }
      />
      <ErrorNote message={data.error} />
      <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
        <section className="rounded-[2rem] bg-white p-4 shadow-soft ring-1 ring-slate-200/70 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <button className="rounded-xl p-2 text-slate-500 hover:bg-slate-100" onClick={() => setCursor(new Date(first.getFullYear(), first.getMonth() - 1, 1))} aria-label="Previous month">
              <Icon name="chevronLeft" />
            </button>
            <h2 className="font-display text-xl font-semibold text-slate-900">{first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</h2>
            <button className="rounded-xl p-2 text-slate-500 hover:bg-slate-100" onClick={() => setCursor(new Date(first.getFullYear(), first.getMonth() + 1, 1))} aria-label="Next month">
              <Icon name="chevronRight" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-bold uppercase tracking-wider text-slate-400">
            {WEEK.map((w) => (
              <div key={w} className="pb-1">
                {w}
              </div>
            ))}
          </div>
          {data.loading && !data.data ? (
            <Spinner />
          ) : (
            <div className="grid grid-cols-7 gap-1.5">
              {cells.map((d) => {
                const key = iso(d);
                const inMonth = d.getMonth() === first.getMonth();
                const items = byDay[key] ?? [];
                const holiday = items.some((i) => i.kind === "holiday");
                const sunday = d.getDay() === 0;
                return (
                  <button
                    key={key}
                    onClick={() => can("announcements.manage") && setAdding(key)}
                    className={`min-h-[5.5rem] rounded-2xl p-1.5 text-left align-top transition sm:min-h-[6.5rem] ${inMonth ? "bg-slate-50 hover:bg-slate-100" : "bg-transparent opacity-40"} ${
                      key === today ? "ring-2 ring-brand" : ""
                    } ${holiday ? "bg-rose-50" : ""}`}
                  >
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${key === today ? "bg-brand text-white" : sunday || holiday ? "text-rose-500" : "text-slate-700"}`}>{d.getDate()}</span>
                    <div className="mt-1 space-y-0.5">
                      {items.slice(0, 3).map((i) => (
                        <p key={i.id + key} className={`truncate rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${KINDS[i.kind].chip}`} title={i.title}>
                          {i.title}
                        </p>
                      ))}
                      {items.length > 3 && <p className="px-1 text-[10px] font-semibold text-slate-500">+{items.length - 3} more</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-600">
            {Object.entries(KINDS).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${v.dot}`} /> {v.label}
              </span>
            ))}
          </div>
        </section>
        <SectionCard title="Upcoming this month" icon="star">
          {upcoming.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing scheduled.</p>
          ) : (
            <ul className="space-y-2.5">
              {upcoming.map((e) => (
                <li key={e.id} className="flex items-start gap-3 rounded-2xl p-2.5 ring-1 ring-slate-100">
                  <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${KINDS[e.kind].dot}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">{e.title}</p>
                    <p className="text-xs text-slate-500">
                      {e.start_date === e.end_date ? fmtDate(e.start_date, { weekday: "short", day: "numeric", month: "short" }) : `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`} · {KINDS[e.kind].label}
                    </p>
                    {e.description && <p className="mt-0.5 text-xs text-slate-500">{e.description}</p>}
                  </div>
                  {can("announcements.manage") && (
                    <button className="rounded-lg p-1 text-slate-400 hover:text-red-600" onClick={() => remove(e.id)} aria-label={`Remove ${e.title}`}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
      {adding && <AddEvent date={adding} onClose={() => setAdding(null)} onSaved={data.reload} />}
    </div>
  );
}

function AddEvent({ date, onClose, onSaved }: { date: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ title: "", description: "", kind: "event", startDate: date, endDate: date, audience: "all" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/events", { body: form });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="Add to the calendar">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <input className="input" required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Annual sports day" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For">
            <select className="input" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              <option value="all">Everyone</option>
              <option value="staff">Staff</option>
              <option value="students">Students</option>
              <option value="parents">Parents</option>
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
          </Field>
          <Field label="To">
            <input className="input" type="date" required min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>
        <Field label="Details (optional)">
          <textarea className="input min-h-[4rem]" maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Add</button>
        </div>
      </form>
    </Modal>
  );
}
