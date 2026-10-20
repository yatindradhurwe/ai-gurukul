import { useState, type FormEvent } from "react";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, SectionCard, Spinner, SuccessNote, fmtDate, todayISO } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

/** Meeting times are shown in school (India) time, whatever the viewer's device is set to. */
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function groupByDay<T extends { starts_at: string }>(rows: T[]) {
  return rows.reduce<Record<string, T[]>>((m, r) => ({ ...m, [dayKey(r.starts_at)]: [...(m[dayKey(r.starts_at)] ?? []), r] }), {});
}

export function MeetingsPage() {
  const { can } = useAuth();
  return can("classes.manage") ? <TeacherMeetings /> : <ParentMeetings />;
}

function TeacherMeetings() {
  const slots = useApi<any>("/ptm/slots/mine");
  const [open, setOpen] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const rows: any[] = slots.data?.slots ?? [];
  const booked = rows.filter((s) => s.booked_by);
  const days = groupByDay(rows);

  const remove = async (s: any) => {
    await api(`/ptm/slots/${s.id}`, { method: "DELETE" });
    slots.reload();
  };
  const cancel = async (s: any) => {
    if (!confirm(`Cancel the meeting with ${s.booked_by_name}?`)) return;
    await api(`/ptm/slots/${s.id}/cancel`, { body: {} });
    slots.reload();
  };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Parent-teacher meetings"
        icon="users"
        subtitle={`${booked.length} booked · ${rows.length - booked.length} open slots`}
        action={
          <button className="btn" onClick={() => setOpen(true)}>
            <Icon name="plus" size={16} /> Publish slots
          </button>
        }
      />
      <SuccessNote message={ok} />
      {slots.loading && !slots.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No meeting slots yet" icon="calendar">Publish a few slots and parents of your students can book a time with you.</Empty>
      ) : (
        Object.entries(days).map(([d, list]) => (
          <SectionCard key={d} title={fmtDate(d, { weekday: "long", day: "numeric", month: "long" })} icon="calendar">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((s) => (
                <div key={s.id} className={`rounded-2xl p-4 ring-1 ${s.booked_by ? "bg-brand-soft ring-brand/30" : "bg-white ring-slate-200"}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-bold text-slate-900">
                      {time(s.starts_at)} <span className="text-xs font-medium text-slate-500">· {s.duration_minutes} min</span>
                    </p>
                    {s.booked_by ? <Badge tone="brand">Booked</Badge> : <Badge tone="green">Open</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{s.location}</p>
                  {s.booked_by ? (
                    <div className="mt-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={s.booked_by_name} size={28} />
                        <div className="text-sm">
                          <p className="font-semibold text-slate-900">{s.booked_by_name}</p>
                          <p className="text-xs text-slate-500">Parent of {s.student}</p>
                        </div>
                      </div>
                      {s.note && <p className="mt-2 rounded-xl bg-white/70 p-2 text-xs text-slate-600">“{s.note}”</p>}
                      <button className="btn-ghost btn-sm mt-3" onClick={() => cancel(s)}>
                        Cancel booking
                      </button>
                    </div>
                  ) : (
                    <button className="mt-3 text-xs font-semibold text-slate-400 hover:text-red-600" onClick={() => remove(s)}>
                      Remove slot
                    </button>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        ))
      )}
      {open && <PublishSlots onClose={() => setOpen(false)} onDone={(n) => (setOk(`Published ${n} slot(s).`), slots.reload())} />}
    </div>
  );
}

function PublishSlots({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const [form, setForm] = useState({ date: todayISO(), startTime: "15:30", endTime: "17:00", minutes: 15, location: "Classroom" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api("/ptm/slots", { body: { ...form, minutes: Number(form.minutes) } });
      onDone(r.created);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="Publish meeting slots">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <input className="input" type="date" required min={todayISO()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Each meeting (minutes)">
            <select className="input" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}>
              {[10, 15, 20, 30].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </Field>
          <Field label="To">
            <input className="input" type="time" required value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          </Field>
        </div>
        <Field label="Where">
          <input className="input" required maxLength={120} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Room 8A, or a video-call link" />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Publish</button>
        </div>
      </form>
    </Modal>
  );
}

function ParentMeetings() {
  const data = useApi<any>("/ptm/available");
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const [booking, setBooking] = useState<any>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const available: any[] = data.data?.available ?? [];
  const mine: any[] = data.data?.bookings ?? [];
  const byTeacher = available.reduce<Record<string, any[]>>((m, s) => ({ ...m, [s.teacher]: [...(m[s.teacher] ?? []), s] }), {});

  async function book(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/ptm/slots/${booking.id}/book`, { body: { studentId, note: note || null } });
      setOk(`Booked with ${booking.teacher} on ${fmtDate(dayKey(booking.starts_at), { weekday: "short", day: "numeric", month: "short" })} at ${time(booking.starts_at)}.`);
      setBooking(null);
      setNote("");
      data.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const cancel = async (s: any) => {
    if (!confirm("Cancel this meeting?")) return;
    await api(`/ptm/slots/${s.id}/cancel`, { body: {} });
    data.reload();
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Parent-teacher meetings" icon="users" subtitle="Book a time to meet your child's teachers." action={<StudentPicker value={studentId} onChange={setStudentId} options={students.options} />} />
      <SuccessNote message={ok} />
      {mine.length > 0 && (
        <SectionCard title="Your meetings" icon="calendar">
          <ul className="grid gap-3 sm:grid-cols-2">
            {mine.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-2xl bg-brand-soft p-4 ring-1 ring-brand/30">
                <div className="flex items-center gap-3">
                  <Avatar name={s.teacher} size={40} />
                  <div>
                    <p className="font-semibold text-slate-900">{s.teacher}</p>
                    <p className="text-xs text-slate-600">
                      {fmtDate(dayKey(s.starts_at), { weekday: "short", day: "numeric", month: "short" })} · {time(s.starts_at)} · {s.location}
                    </p>
                    <p className="text-xs text-slate-500">About {s.student}</p>
                  </div>
                </div>
                <button className="btn-ghost btn-sm" onClick={() => cancel(s)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {data.loading && !data.data ? (
        <Spinner />
      ) : available.length === 0 ? (
        <Empty title="No open slots right now" icon="calendar">Teachers publish meeting times before each PTM. Check back soon.</Empty>
      ) : (
        Object.entries(byTeacher).map(([teacher, list]) => (
          <SectionCard key={teacher} title={teacher} icon="graduation">
            {Object.entries(groupByDay(list)).map(([d, slots]) => (
              <div key={d} className="mb-3 last:mb-0">
                <p className="label">{fmtDate(d, { weekday: "long", day: "numeric", month: "long" })}</p>
                <div className="flex flex-wrap gap-2">
                  {slots.map((s) => (
                    <button key={s.id} className="rounded-2xl bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200 transition hover:-translate-y-0.5 hover:bg-emerald-100" onClick={() => setBooking(s)}>
                      {time(s.starts_at)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </SectionCard>
        ))
      )}
      {booking && (
        <Modal open onClose={() => setBooking(null)} title={`Meet ${booking.teacher}`}>
          <form onSubmit={book} className="space-y-4">
            <p className="text-sm text-slate-600">
              {fmtDate(dayKey(booking.starts_at), { weekday: "long", day: "numeric", month: "long" })} at <b>{time(booking.starts_at)}</b> · {booking.duration_minutes} minutes · {booking.location}
            </p>
            {students.options.length > 1 && (
              <Field label="About">
                <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />
              </Field>
            )}
            <Field label="Anything you'd like to discuss? (optional)">
              <textarea className="input min-h-[5rem]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <ErrorNote message={error} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setBooking(null)}>
                Cancel
              </button>
              <button className="btn" disabled={!studentId}>
                Book this time
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
