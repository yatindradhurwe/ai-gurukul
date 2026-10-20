import { useEffect, useState, type FormEvent } from "react";
import { api, todayISO } from "../lib/api";
import { useApi } from "../lib/useApi";
import { Empty, ErrorNote, InfoNote, PageTitle, Spinner, TaskChip } from "../components/ui";

export function PlanPage() {
  const plans = useApi("/academic/study-plans");
  const exams = useApi("/academic/exams");
  const chapters = useApi("/curriculum/chapters");
  // Only offer subjects that actually have chapters in this student's curriculum.
  const subjects = [...new Map((chapters.data?.chapters ?? []).map((c: any) => [c.subject_id, { id: c.subject_id, name: c.subject }])).values()];
  const active = plans.data?.plans.find((p: any) => p.status === "active");
  const [planId, setPlanId] = useState<string | null>(null);
  const plan = useApi(planId ? `/academic/study-plans/${planId}` : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (active && !planId) setPlanId(active.id);
  }, [active, planId]);

  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const generate = () =>
    run(async () => {
      const r = await api("/academic/study-plans/generate", { body: {} });
      setPlanId(r.plan.id);
      plans.reload();
    });

  const recalc = () =>
    run(async () => {
      const r = await api(`/academic/study-plans/${planId}/recalculate`, { body: { trigger: "missed_tasks", reason: "Student requested a fresh plan" } });
      setPlanId(r.plan.id);
      plans.reload();
    });

  async function toggle(t: any) {
    await api(`/academic/tasks/${t.id}`, { method: "PATCH", body: { status: t.status === "completed" ? "pending" : "completed" } });
    plan.reload();
  }

  const byDate = new Map<string, any[]>();
  for (const t of plan.data?.tasks ?? []) byDate.set(t.task_date, [...(byDate.get(t.task_date) ?? []), t]);
  const s = plan.data?.plan.summary;
  const isActive = plan.data?.plan.status === "active";

  return (
    <div className="space-y-6">
      <PageTitle
        icon="calendar"
        title="Study Plan"
        subtitle="Built from your syllabus, results, exam dates and real available time."
        action={
          <div className="flex gap-2">
            {planId && isActive && (
              <button className="btn-ghost" onClick={recalc} disabled={busy}>
                ↻ Recalculate
              </button>
            )}
            <button className="btn" onClick={generate} disabled={busy || !exams.data?.exams.length}>
              {active ? "New plan" : "Generate plan"}
            </button>
          </div>
        }
      />
      <ErrorNote message={error} />

      <div className="grid gap-4 md:grid-cols-2">
        <ExamCard exams={exams} subjects={subjects} />
        <DisruptionCard onDone={() => (plans.reload(), setPlanId(null))} />
      </div>

      {!planId && !plans.loading && <Empty title="No study plan yet">Add an upcoming exam, then generate your plan.</Empty>}
      {plan.loading && <Spinner />}
      {s && (
        <>
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-medium">Version {plan.data.plan.version}</h2>
              <span className={`chip ${isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{plan.data.plan.status}</span>
              <span className={`chip ${s.feasible ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{s.feasible ? "Fits your time" : `Short by ~${s.gapMinutes} min`}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              <Stat label="Available" value={`${Math.round(s.availableMinutes / 60)} h`} />
              <Stat label="Scheduled" value={`${Math.round(s.scheduledMinutes / 60)} h`} />
              <Stat label="Study days" value={s.studyDays} />
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
              {s.explanations.map((e: string, i: number) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            {s.unscheduled?.length > 0 && (
              <InfoNote>
                <p className="font-medium">Not scheduled:</p>
                <ul className="mt-1 list-disc pl-5">
                  {s.unscheduled.map((u: any) => (
                    <li key={u.topicId}>{u.explanation}</li>
                  ))}
                </ul>
                {s.alternatives?.length > 0 && (
                  <>
                    <p className="mt-2 font-medium">Options:</p>
                    <ul className="list-disc pl-5">
                      {s.alternatives.map((a: any) => (
                        <li key={a.kind}>{a.description}</li>
                      ))}
                    </ul>
                  </>
                )}
              </InfoNote>
            )}
            {plan.data.versions.length > 1 && (
              <div className="flex flex-wrap gap-2 text-xs">
                {plan.data.versions.map((v: any) => (
                  <button key={v.id} onClick={() => setPlanId(v.id)} className={`chip ${v.id === planId ? "bg-brand text-white" : "bg-slate-100"}`} title={v.reason}>
                    v{v.version} · {v.trigger}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            {[...byDate.entries()].map(([date, tasks]) => (
              <div key={date} className={`card ${date === todayISO() ? "ring-2 ring-brand" : ""}`}>
                <div className="mb-2 flex justify-between text-sm">
                  <p className="font-medium">{new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</p>
                  <p className="text-slate-500">{tasks.reduce((a, t) => a + t.duration_minutes, 0)} min</p>
                </div>
                <ul className="space-y-2">
                  {tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 text-sm">
                      <input type="checkbox" disabled={!isActive} checked={t.status === "completed"} onChange={() => toggle(t)} className="h-4 w-4" aria-label={`Mark ${t.title} done`} />
                      <span className={`flex-1 ${t.status === "completed" ? "text-slate-400 line-through" : t.status === "missed" ? "text-red-500" : ""}`}>{t.title}</span>
                      <TaskChip type={t.task_type} />
                      <span className="w-12 text-right text-xs text-slate-500">{t.duration_minutes}m</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-xl bg-slate-50 p-3">
    <p className="text-lg font-semibold">{value}</p>
    <p className="text-xs text-slate-500">{label}</p>
  </div>
);

function ExamCard({ exams, subjects }: { exams: ReturnType<typeof useApi<any>>; subjects: any[] }) {
  const [form, setForm] = useState({ subjectId: "", title: "", examDate: "", maxMarks: 80 });
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/academic/exams", { body: { ...form, subjectId: form.subjectId || subjects[0]?.id } });
      setForm({ ...form, title: "", examDate: "" });
      exams.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card">
      <h2 className="label">Upcoming exams</h2>
      <ul className="mb-3 mt-2 space-y-1 text-sm">
        {exams.data?.exams.map((x: any) => (
          <li key={x.id} className="flex justify-between">
            <span>
              {x.title} <span className="text-slate-400">· {x.subject}</span>
            </span>
            <span className="text-slate-500">{x.exam_date}</span>
          </li>
        ))}
        {!exams.data?.exams.length && <li className="text-slate-500">None yet.</li>}
      </ul>
      <form onSubmit={add} className="grid grid-cols-2 gap-2">
        <select className="input" value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input className="input" type="date" required min={todayISO()} value={form.examDate} onChange={(e) => setForm({ ...form, examDate: e.target.value })} />
        <input className="input col-span-2" placeholder="Exam name, e.g. Term 1 Science" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <button className="btn-ghost col-span-2">+ Add exam</button>
      </form>
      <ErrorNote message={error} />
    </section>
  );
}

function DisruptionCard({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ startDate: "", endDate: "", reasonCategory: "illness", availableMinutesPerDay: 0 });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api("/academic/disruptions", { body: form });
      setMsg(r.recalculated.length ? `Plan updated to version ${r.recalculated[0].version}.` : "Saved. It will be used next time you generate a plan.");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card">
      <h2 className="label">Missed or busy days?</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Tell us when you can't study (illness, travel…). We'll rebuild your plan — old versions are kept.</p>
      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <input className="input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} aria-label="From" />
        <input className="input" type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} aria-label="To" />
        <select className="input" value={form.reasonCategory} onChange={(e) => setForm({ ...form, reasonCategory: e.target.value })}>
          {["illness", "travel", "family", "school_absence", "holiday_travel", "other"].map((r) => (
            <option key={r} value={r}>
              {r.replace("_", " ")}
            </option>
          ))}
        </select>
        <input className="input" type="number" min={0} max={720} value={form.availableMinutesPerDay} onChange={(e) => setForm({ ...form, availableMinutesPerDay: Number(e.target.value) })} aria-label="Minutes available per day" title="Minutes you can still study per day" />
        <button className="btn-ghost col-span-2">Report & recalculate</button>
      </form>
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      <ErrorNote message={error} />
    </section>
  );
}
