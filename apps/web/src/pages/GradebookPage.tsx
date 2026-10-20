import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Spinner, SuccessNote, fmtDate, pct100, toneForPercent } from "../components/ui";
import { api } from "../lib/api";
import { ClassPicker, useClasses } from "../lib/lms";
import { useApi } from "../lib/useApi";

const CATEGORIES = ["test", "exam", "project", "homework", "practical"];

export function GradebookPage() {
  const { classes, loading } = useClasses();
  const [params, setParams] = useSearchParams();
  const classId = params.get("classId") ?? classes[0]?.id ?? "";
  const term = params.get("term") ?? "";
  const book = useApi<any>(classId ? `/gradebook/classes/${classId}${term ? `?term=${encodeURIComponent(term)}` : ""}` : null);
  const [draft, setDraft] = useState<Record<string, string>>({}); // `${itemId}:${studentId}` -> marks text
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft({}), [book.data]);
  useEffect(() => setOk(null), [classId, term]);

  const items: any[] = book.data?.items ?? [];
  const students: any[] = book.data?.students ?? [];
  const terms: string[] = book.data?.terms ?? [];
  const dirty = Object.keys(draft).length;
  const setQuery = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries({ classId, term, ...next }).filter(([, v]) => v)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const byItem = new Map<string, { studentId: string; marks: number | null }[]>();
      for (const [key, text] of Object.entries(draft)) {
        const [itemId, studentId] = key.split(":");
        const marks = text.trim() === "" ? null : Number(text);
        if (marks != null && (Number.isNaN(marks) || marks < 0)) throw new Error("Marks must be a number of 0 or more");
        byItem.set(itemId, [...(byItem.get(itemId) ?? []), { studentId, marks }]);
      }
      for (const [itemId, scores] of byItem) await api(`/gradebook/items/${itemId}/scores`, { method: "PUT", body: { scores } });
      setOk(`Saved ${dirty} mark(s).`);
      book.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: any) {
    if (!confirm(`Delete “${item.title}” and all its marks?`)) return;
    await api(`/gradebook/items/${item.id}`, { method: "DELETE" });
    book.reload();
  }

  if (loading && !classes.length) return <Spinner />;
  return (
    <div className="space-y-5">
      <PageTitle
        title="Gradebook"
        icon="award"
        subtitle="Enter marks for tests and projects. Report cards are calculated from them."
        action={
          classes.length > 0 && (
            <>
              <ClassPicker value={classId} onChange={(id) => setQuery({ classId: id })} classes={classes} />
              <select className="input w-auto" value={term} onChange={(e) => setQuery({ term: e.target.value })} aria-label="Term">
                <option value="">All terms</option>
                {terms.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => setOpen(true)}>
                <Icon name="plus" size={16} /> Add column
              </button>
            </>
          )
        }
      />
      {!classes.length && <Empty title="No classes yet" icon="layers">Create a class first, then record marks here.</Empty>}
      <ErrorNote message={book.error ?? error} />
      <SuccessNote message={ok} />
      {book.loading && !book.data ? (
        <Spinner />
      ) : (
        book.data &&
        (students.length === 0 ? (
          <Empty title="No students in this class" icon="users">Enrol students from Live classes → Manage.</Empty>
        ) : items.length === 0 ? (
          <Empty title="No columns yet" icon="award">Add a test, exam or project to start entering marks.</Empty>
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-surface pl-5">Student</th>
                    {items.map((i) => (
                      <th key={i.id} className="min-w-[7.5rem] text-center normal-case tracking-normal">
                        <div className="group flex items-start justify-center gap-1">
                          <div>
                            <p className="text-xs font-semibold text-slate-800">{i.title}</p>
                            <p className="text-[10px] font-medium text-slate-400">
                              {i.term} · {i.category} · /{Number(i.max_marks)}
                              {i.date && ` · ${fmtDate(i.date)}`}
                            </p>
                          </div>
                          <button className="hidden rounded p-0.5 text-slate-400 hover:text-red-600 group-hover:block" onClick={() => removeItem(i)} aria-label={`Delete ${i.title}`}>
                            <Icon name="trash" size={12} />
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="pr-5 text-right">Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.student_id}>
                      <td className="sticky left-0 z-10 bg-surface pl-5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={s.name} size={28} />
                          <Link to={`/report-card?studentId=${s.student_id}`} className="whitespace-nowrap font-medium text-slate-900 hover:text-brand">
                            {s.name}
                          </Link>
                        </div>
                      </td>
                      {items.map((i) => {
                        const key = `${i.id}:${s.student_id}`;
                        const saved = s.scores[i.id]?.marks;
                        const value = draft[key] ?? (saved == null ? "" : String(Number(saved)));
                        const over = value !== "" && Number(value) > Number(i.max_marks);
                        return (
                          <td key={i.id} className="text-center">
                            <input
                              className={`w-20 rounded-lg border bg-surface px-2 py-1.5 text-center text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20 ${over ? "border-rose-400 text-rose-600" : draft[key] != null ? "border-amber-400" : "border-slate-200"}`}
                              inputMode="decimal"
                              value={value}
                              placeholder="—"
                              aria-label={`${s.name} — ${i.title}`}
                              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                            />
                          </td>
                        );
                      })}
                      <td className="pr-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="font-semibold text-slate-900">{pct100(s.percent)}</span>
                          {s.grade && <Badge tone={toneForPercent(s.percent)}>{s.grade}</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
              <p className="text-xs text-slate-500">{dirty ? `${dirty} unsaved change(s)` : "Click a cell to enter marks. Leave blank for not assessed."}</p>
              <div className="flex gap-2">
                {dirty > 0 && (
                  <button className="btn-ghost" onClick={() => setDraft({})}>
                    Discard
                  </button>
                )}
                <button className="btn" onClick={save} disabled={!dirty || busy}>
                  {busy ? "Saving…" : "Save marks"}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {classId && <AddColumn open={open} onClose={() => setOpen(false)} classId={classId} defaultTerm={term || terms[0] || "Term 1"} onAdded={book.reload} />}
    </div>
  );
}

function AddColumn({ open, onClose, classId, defaultTerm, onAdded }: { open: boolean; onClose: () => void; classId: string; defaultTerm: string; onAdded: () => void }) {
  const [form, setForm] = useState({ title: "", term: defaultTerm, category: "test", maxMarks: 20, date: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm((f) => ({ ...f, term: defaultTerm })), [defaultTerm]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/gradebook/classes/${classId}/items`, { body: { ...form, maxMarks: Number(form.maxMarks), date: form.date || null } });
      setForm({ ...form, title: "" });
      onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add gradebook column">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <input className="input" required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Unit test 1 — Force & Pressure" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Term">
            <input className="input" required list="terms" value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} />
            <datalist id="terms">
              <option value="Term 1" />
              <option value="Term 2" />
              <option value="Half-yearly" />
              <option value="Annual" />
            </datalist>
          </Field>
          <Field label="Type">
            <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Maximum marks">
            <input className="input" type="number" min={1} max={1000} required value={form.maxMarks} onChange={(e) => setForm({ ...form, maxMarks: Number(e.target.value) })} />
          </Field>
          <Field label="Date (optional)">
            <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Add column</button>
        </div>
      </form>
    </Modal>
  );
}
