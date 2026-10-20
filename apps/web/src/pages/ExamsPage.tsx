import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, SectionCard, Spinner, StatCard, Tabs, fmtDate, pct100, toneForPercent, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ClassPicker, StudentPicker, useClasses, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "slate", label: "Draft" },
  published: { tone: "sky", label: "Published" },
  completed: { tone: "green", label: "Results declared" },
};
const RESULT: Record<string, { tone: Tone; label: string }> = { pass: { tone: "green", label: "Pass" }, fail: { tone: "red", label: "Fail" }, pending: { tone: "slate", label: "Pending" } };

const range = (a?: string | null, b?: string | null) =>
  a && b ? `${fmtDate(a)} – ${fmtDate(b, { day: "numeric", month: "short", year: "numeric" })}` : a ? fmtDate(a) : "Dates to be announced";

export function ExamsPage() {
  const list = useApi<any>("/exams");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const exams: any[] = list.data?.exams ?? [];
  const manage = !!list.data?.canManage;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Exams"
        icon="file"
        subtitle={manage ? "Plan exams, publish the date sheet and declare results." : "Your exam schedule and results."}
        action={
          manage && (
            <button className="btn" onClick={() => setOpen(true)}>
              <Icon name="plus" size={16} /> New exam
            </button>
          )
        }
      />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : exams.length === 0 ? (
        <Empty title="No exams yet" icon="file">
          {manage ? "Create an exam such as “Half-yearly”, then add a paper for each class and subject." : "Published exam date sheets will appear here."}
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {exams.map((e) => (
            <Link key={e.id} to={`/exams/${e.id}`} className="card card-hover block animate-fade-up">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-brand">{e.term}</p>
                  <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{e.name}</h2>
                </div>
                <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2 text-slate-600">
                  <Icon name="calendar" size={16} className="text-slate-400" />
                  {range(e.first_paper ?? e.start_date, e.last_paper ?? e.end_date)}
                </div>
                <div className="flex items-center gap-2 text-slate-600">
                  <Icon name="clipboard" size={16} className="text-slate-400" />
                  {e.papers} paper{e.papers === 1 ? "" : "s"}
                </div>
              </div>
              {e.classes && <p className="mt-2 truncate text-xs text-slate-500">{e.classes}</p>}
            </Link>
          ))}
        </div>
      )}
      {open && <NewExam onClose={() => setOpen(false)} onCreated={(id) => navigate(`/exams/${id}`)} />}
    </div>
  );
}

function NewExam({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", term: "Term 1", startDate: "", endDate: "", instructions: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api("/exams", { body: { ...form, startDate: form.startDate || null, endDate: form.endDate || null } });
      onCreated(r.exam.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New exam">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" required maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Half-yearly examination" />
          </Field>
          <Field label="Term">
            <input className="input" required list="exam-terms" value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} />
            <datalist id="exam-terms">
              <option value="Term 1" />
              <option value="Term 2" />
              <option value="Half-yearly" />
              <option value="Annual" />
            </datalist>
          </Field>
          <Field label="Starts">
            <input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="Ends">
            <input className="input" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>
        <Field label="Instructions for students (optional)">
          <textarea className="input min-h-[5rem]" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Report 15 minutes early. Bring your admit card." />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create exam</button>
        </div>
      </form>
    </Modal>
  );
}

export function ExamDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const detail = useApi<any>(`/exams/${id}`);
  const [tab, setTab] = useState<"sheet" | "results">("sheet");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const staff = can("exams.manage") || can("classes.manage");

  if (detail.loading && !detail.data) return <Spinner />;
  if (!detail.data) return <ErrorNote message={detail.error ?? "Exam not found"} />;
  const { exam, papers, canManage } = detail.data;
  const byDate = papers.reduce((m: Record<string, any[]>, p: any) => ({ ...m, [p.date]: [...(m[p.date] ?? []), p] }), {});

  const setStatus = async (status: string) => {
    setError(null);
    try {
      await api(`/exams/${exam.id}`, { method: "PATCH", body: { status } });
      detail.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const removeExam = async () => {
    if (!confirm(`Delete ${exam.name}, its papers and all marks entered for them?`)) return;
    await api(`/exams/${exam.id}`, { method: "DELETE" });
    navigate("/exams");
  };
  const removePaper = async (p: any) => {
    if (!confirm(`Remove the ${p.subject} paper for ${p.class_name}? Marks entered for it are deleted too.`)) return;
    await api(`/exams/papers/${p.id}`, { method: "DELETE" });
    detail.reload();
  };

  return (
    <div className="space-y-5">
      <Link to="/exams" className="no-print inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <Icon name="chevronLeft" size={16} /> Exams
      </Link>
      <div className="card animate-fade-up">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-brand">{exam.term}</p>
            <h1 className="mt-1 font-display text-2xl font-semibold text-slate-900">{exam.name}</h1>
            <p className="mt-1 text-sm text-slate-500">{range(exam.start_date, exam.end_date)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[exam.status].tone}>{STATUS[exam.status].label}</Badge>
            <button className="btn-ghost btn-sm no-print" onClick={() => window.print()}>
              <Icon name="printer" size={14} /> Print date sheet
            </button>
          </div>
        </div>
        {exam.instructions && <p className="mt-4 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm text-slate-600">{exam.instructions}</p>}
        {canManage && (
          <div className="no-print mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <button className="btn btn-sm" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Add paper
            </button>
            {exam.status === "draft" && (
              <button className="btn-ghost btn-sm" onClick={() => setStatus("published")} disabled={!papers.length}>
                <Icon name="send" size={14} /> Publish date sheet
              </button>
            )}
            {exam.status === "published" && (
              <button className="btn-ghost btn-sm" onClick={() => confirm("Declare results? Students and parents will see their marks.") && setStatus("completed")}>
                <Icon name="award" size={14} /> Declare results
              </button>
            )}
            {exam.status !== "draft" && (
              <button className="btn-ghost btn-sm" onClick={() => setStatus(exam.status === "completed" ? "published" : "draft")}>
                {exam.status === "completed" ? "Withdraw results" : "Back to draft"}
              </button>
            )}
            <button className="btn-danger btn-sm ml-auto" onClick={removeExam}>
              <Icon name="trash" size={14} /> Delete exam
            </button>
          </div>
        )}
      </div>
      <ErrorNote message={error} />

      {staff && (
        <div className="no-print">
          <Tabs value={tab} onChange={setTab} options={[{ value: "sheet", label: "Date sheet" }, { value: "results", label: "Results" }]} />
        </div>
      )}

      {tab === "sheet" || !staff ? (
        <>
          {!staff && <MyResult examId={exam.id} />}
          <SectionCard title="Date sheet" icon="calendar">
            {papers.length === 0 ? (
              <Empty title="No papers yet" icon="calendar">{canManage ? "Add a paper for each class and subject." : "The date sheet hasn't been published."}</Empty>
            ) : (
              <div className="space-y-4">
                {Object.entries(byDate).map(([date, list]) => (
                  <div key={date} className="flex gap-4">
                    <div className="w-16 shrink-0 rounded-2xl bg-brand-soft py-2 text-center text-brand">
                      <p className="text-[11px] font-semibold uppercase">{fmtDate(date, { weekday: "short" })}</p>
                      <p className="text-xl font-bold leading-tight">{fmtDate(date, { day: "numeric" })}</p>
                      <p className="text-[11px] font-semibold">{fmtDate(date, { month: "short" })}</p>
                    </div>
                    <ul className="flex-1 space-y-2">
                      {(list as any[]).map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-slate-200">
                          <div>
                            <p className="font-semibold text-slate-900">{p.subject}</p>
                            <p className="text-xs text-slate-500">
                              {p.class_name} · {p.start_time} · {Math.round(p.duration_minutes / 60 * 10) / 10} h · Max {Number(p.max_marks)}
                              {p.pass_marks != null && ` · Pass ${Number(p.pass_marks)}`}
                              {p.room && ` · ${p.room}`}
                            </p>
                          </div>
                          {p.marked != null && (
                            <div className="no-print flex items-center gap-2">
                              <Badge tone={p.marked >= p.students && p.students ? "green" : "amber"}>
                                {p.marked}/{p.students} marked
                              </Badge>
                              <Link to={`/gradebook?classId=${p.class_id}&term=${encodeURIComponent(exam.term)}`} className="btn-ghost btn-sm">
                                Enter marks
                              </Link>
                              {canManage && (
                                <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => removePaper(p)} aria-label={`Remove ${p.subject}`}>
                                  <Icon name="trash" size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      ) : (
        <Results examId={exam.id} classIds={[...new Set(papers.map((p: any) => p.class_id))] as string[]} classNames={Object.fromEntries(papers.map((p: any) => [p.class_id, p.class_name]))} />
      )}
      {adding && <AddPaper exam={exam} onClose={() => setAdding(false)} onAdded={detail.reload} />}
    </div>
  );
}

function AddPaper({ exam, onClose, onAdded }: { exam: any; onClose: () => void; onAdded: () => void }) {
  const { classes } = useClasses();
  const [form, setForm] = useState({ classId: "", subject: "", date: exam.start_date ?? "", startTime: "09:00", durationMinutes: 180, maxMarks: 80, passMarks: 27, room: "" });
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/exams/${exam.id}/papers`, {
        body: { ...form, classId: form.classId || classes[0]?.id, durationMinutes: Number(form.durationMinutes), maxMarks: Number(form.maxMarks), passMarks: form.passMarks === ("" as any) ? null : Number(form.passMarks), room: form.room || null },
      });
      setAdded([...added, `${form.subject} on ${fmtDate(form.date)}`]);
      setForm({ ...form, subject: "" });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Add paper — ${exam.name}`} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Class">
            <ClassPicker value={form.classId || classes[0]?.id || ""} onChange={(id) => setForm({ ...form, classId: id })} classes={classes} />
          </Field>
          <Field label="Subject">
            <input className="input" required maxLength={120} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Science" />
          </Field>
          <Field label="Date">
            <input className="input" type="date" required min={exam.start_date ?? undefined} max={exam.end_date ?? undefined} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Starts">
            <input className="input" type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </Field>
          <Field label="Duration (minutes)">
            <input className="input" type="number" min={15} max={600} required value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Room (optional)">
            <input className="input" maxLength={60} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} placeholder="e.g. Hall A" />
          </Field>
          <Field label="Maximum marks">
            <input className="input" type="number" min={1} max={1000} required value={form.maxMarks} onChange={(e) => setForm({ ...form, maxMarks: Number(e.target.value) })} />
          </Field>
          <Field label="Pass marks">
            <input className="input" type="number" min={0} value={form.passMarks} onChange={(e) => setForm({ ...form, passMarks: e.target.value as any })} />
          </Field>
        </div>
        {added.length > 0 && <p className="text-sm text-emerald-700">Added: {added.join(", ")}</p>}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <button className="btn">Add paper</button>
        </div>
      </form>
    </Modal>
  );
}

function Results({ examId, classIds, classNames }: { examId: string; classIds: string[]; classNames: Record<string, string> }) {
  const [classId, setClassId] = useState(classIds[0] ?? "");
  useEffect(() => {
    if (!classId && classIds[0]) setClassId(classIds[0]);
  }, [classId, classIds]);
  const res = useApi<any>(classId ? `/exams/${examId}/results?classId=${classId}` : null);
  if (!classIds.length) return <Empty title="No papers yet" icon="award">Add papers to see results.</Empty>;
  const d = res.data;
  return (
    <div className="space-y-4">
      <ClassPicker value={classId} onChange={setClassId} classes={classIds.map((id) => ({ id, name: classNames[id] }))} />
      <ErrorNote message={res.error} />
      {res.loading && !d ? (
        <Spinner />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Students" value={d.summary.students} icon="users" />
              <StatCard label="Passed" value={d.summary.passed} icon="check" tone="green" hint={d.summary.failed ? `${d.summary.failed} need support` : undefined} />
              <StatCard label="Class average" value={pct100(d.summary.average)} icon="chart" tone={toneForPercent(d.summary.average)} />
              <StatCard label="Highest" value={pct100(d.summary.highest)} icon="award" tone="amber" />
            </div>
            <div className="card p-0">
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="pl-5">Rank</th>
                      <th>Student</th>
                      {d.subjects.map((s: any) => (
                        <th key={s.id} className="text-center normal-case tracking-normal">
                          <span className="text-xs font-semibold text-slate-800">{s.subject}</span>
                          <span className="block text-[10px] font-medium text-slate-400">/{s.max}</span>
                        </th>
                      ))}
                      <th className="text-right">Total</th>
                      <th className="text-right">%</th>
                      <th className="pr-5">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.students.map((s: any) => (
                      <tr key={s.student_id}>
                        <td className="pl-5 font-bold text-slate-900">{s.rank ?? "—"}</td>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.name} size={28} />
                            <span className="whitespace-nowrap font-medium text-slate-900">{s.name}</span>
                          </div>
                        </td>
                        {s.papers.map((p: any) => (
                          <td key={p.paperId} className={`text-center ${p.passed === false ? "font-semibold text-rose-600" : ""}`}>
                            {p.marks ?? "—"}
                          </td>
                        ))}
                        <td className="text-right font-semibold">
                          {s.max ? `${s.total}/${s.max}` : "—"}
                        </td>
                        <td className="text-right">
                          <span className="font-semibold">{pct100(s.percent)}</span> {s.grade && <Badge tone={toneForPercent(s.percent)}>{s.grade}</Badge>}
                        </td>
                        <td className="pr-5">
                          <Badge tone={RESULT[s.result].tone}>{RESULT[s.result].label}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

function MyResult({ examId }: { examId: string }) {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [params] = useSearchParams();
  const [studentId, setStudentId] = useState<string | null>(params.get("studentId"));
  const res = useApi<any>(parent ? (studentId ? `/exams/${examId}/student?studentId=${studentId}` : null) : `/exams/${examId}/student`);
  const d = res.data;
  return (
    <SectionCard title={d?.student ? `Result — ${d.student.name}` : "Result"} icon="award" action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />}>
      {res.loading && !d ? (
        <Spinner />
      ) : !d ? (
        <ErrorNote message={res.error} />
      ) : !d.declared ? (
        <p className="text-sm text-slate-500">Results haven't been declared yet. You'll see marks here as soon as the school publishes them.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <p className="label">Total</p>
              <p className="text-3xl font-bold text-slate-900">
                {d.total}
                <span className="text-lg font-medium text-slate-400">/{d.max}</span>
              </p>
            </div>
            <div>
              <p className="label">Percentage</p>
              <p className="text-3xl font-bold text-slate-900">{pct100(d.percent)}</p>
            </div>
            <div className="flex gap-2">
              {d.grade && <Badge tone={toneForPercent(d.percent)}>Grade {d.grade}</Badge>}
              <Badge tone={RESULT[d.result].tone}>{RESULT[d.result].label}</Badge>
            </div>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.papers.map((p: any) => (
              <li key={p.paperId} className="flex items-center justify-between rounded-xl px-3 py-2 ring-1 ring-slate-200">
                <span className="text-sm font-medium text-slate-800">{p.subject}</span>
                <span className={`text-sm font-semibold ${p.passed === false ? "text-rose-600" : "text-slate-900"}`}>
                  {p.marks ?? "—"}/{p.max}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
