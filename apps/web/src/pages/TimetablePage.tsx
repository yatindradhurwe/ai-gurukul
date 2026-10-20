import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { DAYS, Empty, ErrorNote, Field, Modal, PageTitle, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ClassPicker, useClasses } from "../lib/lms";
import { useApi } from "../lib/useApi";

const COLORS = ["bg-indigo-50 text-indigo-700 ring-indigo-200/60", "bg-emerald-50 text-emerald-700 ring-emerald-200/60", "bg-amber-50 text-amber-700 ring-amber-200/60", "bg-rose-50 text-rose-700 ring-rose-200/60", "bg-sky-50 text-sky-700 ring-sky-200/60", "bg-violet-50 text-indigo-700 ring-violet-200/60"];
const colorFor = (subject: string) => COLORS[[...subject].reduce((h, c) => h + c.charCodeAt(0), 0) % COLORS.length];

export function TimetablePage() {
  const { can } = useAuth();
  const staff = can("classes.manage");
  const { classes } = useClasses();
  const [params, setParams] = useSearchParams();
  const classId = params.get("classId") ?? "";
  const slots = useApi<any>(`/timetable${classId ? `?classId=${classId}` : ""}`);
  const [open, setOpen] = useState(false);
  const list: any[] = slots.data?.slots ?? [];
  const todayIdx = (new Date().getDay() + 6) % 7; // Monday = 0
  const showSunday = list.some((s) => s.day_of_week === 7);
  const days = DAYS.slice(0, showSunday ? 7 : 6);

  async function remove(id: string) {
    if (!confirm("Remove this period from the timetable?")) return;
    await api(`/timetable/${id}`, { method: "DELETE" });
    slots.reload();
  }

  return (
    <div className="space-y-5">
      <PageTitle
        title="Timetable"
        icon="clock"
        subtitle="The weekly schedule for your classes."
        action={
          <>
            {classes.length > 0 && <ClassPicker allowAll value={classId} onChange={(id) => setParams(id ? { classId: id } : {})} classes={classes} />}
            {staff && (
              <button className="btn" onClick={() => setOpen(true)} disabled={!classes.length}>
                <Icon name="plus" size={16} /> Add period
              </button>
            )}
            <button className="btn-ghost no-print" onClick={() => window.print()}>
              <Icon name="printer" size={16} /> Print
            </button>
          </>
        }
      />
      <ErrorNote message={slots.error} />
      {slots.loading && !slots.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="No periods yet" icon="clock">
          {staff ? "Add periods to build the weekly timetable for your classes." : "Your school hasn't published a timetable yet."}
        </Empty>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2">
          <div className="grid min-w-[56rem] gap-3" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d, i) => {
              const daySlots = list.filter((s) => s.day_of_week === i + 1);
              const today = i === todayIdx;
              return (
                <div key={d} className={`rounded-2xl p-2 ${today ? "bg-brand-soft ring-1 ring-brand/30" : "bg-slate-100/60"}`}>
                  <p className={`px-2 pb-2 pt-1 text-xs font-bold uppercase tracking-wider ${today ? "text-brand" : "text-slate-500"}`}>
                    {d}
                    {today && " · today"}
                  </p>
                  <div className="space-y-2">
                    {daySlots.length === 0 && <p className="px-2 py-4 text-center text-xs text-slate-400">Free</p>}
                    {daySlots.map((s) => (
                      <div key={s.id} className={`group relative rounded-xl p-2.5 ring-1 ${colorFor(s.subject)}`}>
                        <p className="text-[11px] font-semibold opacity-80">
                          {s.start_time}–{s.end_time}
                        </p>
                        <p className="mt-0.5 text-sm font-bold leading-snug">{s.subject}</p>
                        <p className="mt-0.5 text-[11px] opacity-80">
                          {s.class_name}
                          {s.room && ` · ${s.room}`}
                        </p>
                        <p className="text-[11px] opacity-70">{s.teacher}</p>
                        {staff && (
                          <button
                            className="no-print absolute right-1.5 top-1.5 hidden rounded-md bg-surface/80 p-1 text-slate-500 hover:text-red-600 group-hover:block"
                            onClick={() => remove(s.id)}
                            aria-label={`Remove ${s.subject} period`}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {staff && <AddPeriod open={open} onClose={() => setOpen(false)} classes={classes} defaultClass={classId} onAdded={slots.reload} />}
    </div>
  );
}

function AddPeriod({ open, onClose, classes, defaultClass, onAdded }: { open: boolean; onClose: () => void; classes: { id: string; name: string }[]; defaultClass: string; onAdded: () => void }) {
  const [form, setForm] = useState({ classId: defaultClass, dayOfWeek: 1, startTime: "09:00", endTime: "09:45", subject: "", room: "" });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/timetable", { body: { ...form, classId: form.classId || classes[0]?.id, dayOfWeek: Number(form.dayOfWeek), room: form.room || null } });
      onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a period">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Class">
            <ClassPicker value={form.classId || classes[0]?.id || ""} onChange={(id) => setForm({ ...form, classId: id })} classes={classes} />
          </Field>
          <Field label="Day">
            <select className="input" value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Starts">
            <input className="input" type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </Field>
          <Field label="Ends">
            <input className="input" type="time" required value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          </Field>
          <Field label="Subject">
            <input className="input" required maxLength={120} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Science" />
          </Field>
          <Field label="Room (optional)">
            <input className="input" maxLength={60} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} placeholder="e.g. Lab 2" />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Add period</button>
        </div>
      </form>
    </Modal>
  );
}
