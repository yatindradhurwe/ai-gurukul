import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STATE: Record<string, { tone: Tone; label: string; cell: string }> = {
  on_track: { tone: "green", label: "On track", cell: "bg-emerald-50 ring-emerald-200 text-emerald-800" },
  ahead: { tone: "sky", label: "Ahead", cell: "bg-sky-50 ring-sky-200 text-sky-800" },
  behind: { tone: "red", label: "Behind", cell: "bg-rose-50 ring-rose-200 text-rose-800" },
  done: { tone: "brand", label: "Completed", cell: "bg-indigo-50 ring-indigo-200 text-indigo-800" },
  no_plan: { tone: "slate", label: "No plan", cell: "bg-slate-50 ring-slate-200 text-slate-500" },
};
const pctOf = (s: { completed: number; total: number }) => (s.total ? Math.round((s.completed / s.total) * 100) : 0);
const classLabel = (c: { name: string; board?: string | null; grade?: string | null }) => [c.board, c.grade].filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
// Principal: every class × subject
// ---------------------------------------------------------------------------
export function AcademicsPage() {
  const { can } = useAuth();
  const o = useApi<any>("/academics/overview");
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = o.data;
  async function generate() {
    setBusy(true);
    try {
      const r = await api("/academics/plans/generate", { body: {} });
      setOk(`Planned ${r.planned} of ${r.subjects} subjects.${r.withWarnings ? ` ${r.withWarnings} need attention — see the warnings.` : ""}`);
      o.reload();
    } finally {
      setBusy(false);
    }
  }
  const cell = (classId: string, subject: string) => d?.cells.find((c: any) => c.class_id === classId && c.subject === subject);
  const overall = d?.totals.total ? Math.round((d.totals.completed / d.totals.total) * 100) : 0;
  const expected = d?.totals.total ? Math.round((d.totals.due / d.totals.total) * 100) : 0;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Syllabus tracker"
        icon="chart"
        subtitle={d?.year ? `${d.year.name} · every class and subject against its plan` : "Every class and subject against its plan"}
        action={
          can("academics.manage") && (
            <>
              <Link to="/academics/setup" className="btn-ghost">
                <Icon name="sliders" size={16} /> Academic setup
              </Link>
              <button className="btn" onClick={generate} disabled={busy}>
                <Icon name="sparkles" size={16} /> {busy ? "Planning…" : "Generate all plans"}
              </button>
            </>
          )
        }
      />
      <SuccessNote message={ok} />
      <ErrorNote message={o.error} />
      {o.loading && !d ? (
        <Spinner />
      ) : !d?.cells.length ? (
        <Empty title="No class subjects yet" icon="layers">
          Set up the academic year, syllabi and each class's subjects in <Link to="/academics/setup" className="text-brand underline">Academic setup</Link>.
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard label="Syllabus covered" value={`${overall}%`} icon="check" tone="green" hint={`${d.totals.completed} of ${d.totals.total} chapters`} />
            <StatCard label="Expected by today" value={`${expected}%`} icon="calendar" tone="sky" hint={`${d.totals.due} chapters due`} />
            <StatCard label="Subjects behind" value={d.totals.behind} icon="alert" tone={d.totals.behind ? "red" : "green"} />
            <StatCard label="Classes · subjects" value={`${d.classes.length} · ${d.subjects.length}`} icon="layers" tone="amber" />
          </div>
          <div className="card overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-2 p-2 text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Class</th>
                    {d.subjects.map((s: string) => (
                      <th key={s} className="min-w-[10rem] px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.classes.map((c: any) => (
                    <tr key={c.id}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-2 align-top">
                        <p className="whitespace-nowrap font-semibold text-slate-900">{c.name}</p>
                        <p className="text-xs text-slate-500">{classLabel(c)}</p>
                      </td>
                      {d.subjects.map((s: string) => {
                        const x = cell(c.id, s);
                        if (!x) return <td key={s} className="rounded-2xl bg-slate-50/50 text-center text-xs text-slate-300">—</td>;
                        const st = STATE[x.state];
                        return (
                          <td key={s} className="align-top">
                            <Link to={`/academics/plan/${x.id}`} className={`block rounded-2xl p-3 ring-1 transition hover:-translate-y-0.5 hover:shadow-md ${st.cell}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-lg font-bold">{pctOf(x)}%</span>
                                <span className="text-[10px] font-bold uppercase">{st.label}</span>
                              </div>
                              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/70">
                                <div className="h-full rounded-full bg-current opacity-60" style={{ width: `${pctOf(x)}%` }} />
                              </div>
                              <p className="mt-1.5 truncate text-[11px] opacity-80">{x.teacher ?? "No teacher"}</p>
                              {x.current_unit && <p className="truncate text-[11px] font-semibold">Now: {x.current_unit}</p>}
                              {x.plan_warning && <p className="mt-1 truncate text-[10px] font-semibold text-amber-700" title={x.plan_warning}>⚠ {x.plan_warning}</p>}
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-slate-600">
            {Object.entries(STATE).map(([k, v]) => (
              <Badge key={k} tone={v.tone}>
                {v.label}
              </Badge>
            ))}
            <span>Behind means a chapter's planned end date has passed and it isn't marked done.</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One class subject's plan
// ---------------------------------------------------------------------------
export function SubjectPlanPage() {
  const { id } = useParams();
  const plan = useApi<any>(`/academics/class-subjects/${id}/plan`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (plan.loading && !plan.data) return <Spinner />;
  if (!plan.data) return <ErrorNote message={plan.error ?? "Plan not found"} />;
  const { subject: s, items, canEdit } = plan.data;
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const terms = [...new Set<string>(items.map((i: any) => i.term_name ?? "Plan"))];
  const setStatus = async (item: any, status: string) => {
    setError(null);
    try {
      await api(`/academics/plan-items/${item.id}`, { method: "PATCH", body: { status } });
      plan.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const regenerate = async () => {
    setBusy(true);
    try {
      await api(`/academics/class-subjects/${id}/plan`, { body: {} });
      plan.reload();
    } finally {
      setBusy(false);
    }
  };
  const st = STATE[s.state];

  return (
    <div className="space-y-5">
      <Link to="/academics" className="no-print inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <Icon name="chevronLeft" size={16} /> Syllabus tracker
      </Link>
      <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 p-6 text-white shadow-lift animate-fade-up">
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/75">
              {s.class_name} {[s.board, s.grade].filter(Boolean).length > 0 && `· ${[s.board, s.grade].filter(Boolean).join(" ")}`}
            </p>
            <h1 className="font-display text-3xl font-semibold">{s.subject}</h1>
            <p className="mt-1 text-white/85">
              {s.teacher ?? "No teacher assigned"} · {s.periods_per_week} periods a week
            </p>
          </div>
          <div className="text-right">
            <p className="text-4xl font-black">{pctOf(s)}%</p>
            <p className="text-sm text-white/85">
              {s.completed} of {s.total} chapters done
            </p>
          </div>
        </div>
        <div className="relative mt-4 h-3 overflow-hidden rounded-full bg-white/25">
          <div className="absolute inset-y-0 left-0 rounded-full bg-white/40" style={{ width: `${s.total ? (s.due / s.total) * 100 : 0}%` }} title="Expected by today" />
          <div className="relative h-full rounded-full bg-gradient-to-r from-amber-300 to-yellow-200" style={{ width: `${pctOf(s)}%` }} />
        </div>
        <p className="relative mt-1.5 text-xs text-white/80">The lighter bar shows where the plan expected to be by today.</p>
      </section>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        {s.plan_warning && <span className="rounded-xl bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">⚠ {s.plan_warning}</span>}
        {canEdit && (
          <button className="btn-ghost btn-sm ml-auto" onClick={regenerate} disabled={busy}>
            <Icon name="sparkles" size={14} /> {busy ? "Planning…" : "Re-plan remaining chapters"}
          </button>
        )}
      </div>
      <ErrorNote message={error} />
      {items.length === 0 ? (
        <Empty title="No plan yet" icon="calendar">
          {canEdit ? "Link a syllabus and set up the academic year, then generate the plan." : "The plan for this subject hasn't been made yet."}
        </Empty>
      ) : (
        terms.map((t) => (
          <SectionCard key={t} title={t} icon="calendar">
            <ol className="relative space-y-3 border-l-2 border-dashed border-slate-200 pl-6">
              {items
                .filter((i: any) => (i.term_name ?? "Plan") === t)
                .map((i: any) => {
                  const now = i.status !== "completed" && i.planned_start && i.planned_start <= today && (!i.planned_end || i.planned_end >= today);
                  const late = i.status !== "completed" && i.planned_end && i.planned_end < today;
                  return (
                    <li key={i.id} className="relative">
                      <span
                        className={`absolute -left-[33px] top-3 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black ring-4 ring-white ${
                          i.status === "completed" ? "bg-emerald-500 text-white" : late ? "bg-rose-500 text-white" : now ? "bg-brand text-white animate-pop" : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {i.status === "completed" ? <Icon name="check" size={12} /> : i.sequence}
                      </span>
                      <div className={`rounded-2xl p-4 ring-1 ${now ? "bg-brand-soft ring-brand/30" : late ? "bg-rose-50/60 ring-rose-200" : "bg-white ring-slate-200"}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900">
                              {i.title} {now && <Badge tone="brand">Now</Badge>} {late && <Badge tone="red">Overdue</Badge>}
                            </p>
                            <p className="text-xs text-slate-500">
                              {i.planned_start ? `${fmtDate(i.planned_start)} – ${fmtDate(i.planned_end, { day: "numeric", month: "short", year: "numeric" })}` : "Not scheduled"} · {Number(i.planned_periods)} periods
                              {i.completed_on && ` · done ${fmtDate(i.completed_on)}`}
                            </p>
                            {i.topics && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{i.topics}</p>}
                            {i.note && <p className="mt-1 text-xs italic text-slate-600">“{i.note}”</p>}
                          </div>
                          {canEdit && (
                            <div className="flex gap-1.5">
                              {i.status !== "in_progress" && i.status !== "completed" && (
                                <button className="btn-ghost btn-sm" onClick={() => setStatus(i, "in_progress")}>
                                  Start
                                </button>
                              )}
                              {i.status !== "completed" ? (
                                <button className="btn btn-sm" onClick={() => setStatus(i, "completed")}>
                                  <Icon name="check" size={14} /> Done
                                </button>
                              ) : (
                                <button className="btn-ghost btn-sm" onClick={() => setStatus(i, "planned")}>
                                  Undo
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
            </ol>
          </SectionCard>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teachers, students and parents
// ---------------------------------------------------------------------------
export function MySyllabusPage() {
  const { info, can } = useAuth();
  if (!info?.studentProfileId && !can("reports.children")) return <TeacherSyllabus />;
  return <StudentSyllabus />;
}

function TeacherSyllabus() {
  const mine = useApi<any>("/academics/my-subjects");
  const rows: any[] = mine.data?.subjects ?? [];
  return (
    <div className="space-y-5">
      <PageTitle title="My syllabus plan" icon="book" subtitle="Your classes and subjects, chapter by chapter." />
      <ErrorNote message={mine.error} />
      {mine.loading && !mine.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No subjects assigned to you yet" icon="book">An admin assigns subjects to teachers in Academic setup.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => {
            const st = STATE[s.state];
            return (
              <Link key={s.id} to={`/academics/plan/${s.id}`} className="card card-hover block animate-fade-up">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-brand">{s.class_name}</p>
                    <h2 className="text-lg font-semibold text-slate-900">{s.subject}</h2>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-slate-500">
                    <span>
                      {s.completed}/{s.total} chapters
                    </span>
                    <span>{pctOf(s)}%</span>
                  </div>
                  <Progress value={pctOf(s)} tone={s.state === "behind" ? "red" : "green"} />
                </div>
                {s.current_unit && (
                  <p className="mt-3 text-sm text-slate-700">
                    <b>Now:</b> {s.current_unit}
                    {s.current_due && <span className="text-xs text-slate-500"> · finish by {fmtDate(s.current_due)}</span>}
                  </p>
                )}
                {s.plan_warning && <p className="mt-2 text-xs font-semibold text-amber-700">⚠ {s.plan_warning}</p>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

const SUBJECT_COLORS = ["from-indigo-400 to-violet-500", "from-emerald-400 to-teal-500", "from-amber-400 to-orange-500", "from-pink-400 to-rose-500", "from-sky-400 to-blue-500", "from-lime-400 to-green-500"];

function StudentSyllabus() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const data = useApi<any>(parent ? (studentId ? `/academics/student?studentId=${studentId}` : null) : "/academics/student");
  const rows: any[] = data.data?.subjects ?? [];
  return (
    <div className="space-y-5">
      <PageTitle title={parent ? "Syllabus" : "My syllabus"} icon="book" subtitle="What's being taught in class now, and what's coming next." action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />} />
      <ErrorNote message={data.error} />
      {data.loading && !data.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No syllabus plan yet" icon="book">Your school hasn't published the syllabus plan for your class yet.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((s, i) => (
            <div key={s.id} className="overflow-hidden rounded-[2rem] bg-white shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
              <div className={`bg-gradient-to-br ${SUBJECT_COLORS[i % SUBJECT_COLORS.length]} p-5 text-white`}>
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-xl font-semibold">{s.subject}</h2>
                  <span className="rounded-full bg-white/25 px-2.5 py-0.5 text-sm font-bold">{pctOf(s)}%</span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-sm text-white/90">
                  {s.teacher && <Avatar name={s.teacher} size={22} />}
                  {s.teacher ?? "Teacher to be assigned"}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/25">
                  <div className="h-full rounded-full bg-white" style={{ width: `${pctOf(s)}%` }} />
                </div>
              </div>
              <div className="space-y-3 p-5">
                <div className="rounded-2xl bg-brand-soft p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-brand">Now in class</p>
                  <p className="mt-0.5 font-semibold text-slate-900">{s.now?.title ?? (s.total ? "All chapters done! 🎉" : "—")}</p>
                  {s.now?.end && <p className="text-xs text-slate-500">until about {fmtDate(s.now.end, { day: "numeric", month: "short" })}</p>}
                </div>
                {s.next && (
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Up next</p>
                    <p className="mt-0.5 font-semibold text-slate-800">{s.next.title}</p>
                    {s.next.start && <p className="text-xs text-slate-500">from about {fmtDate(s.next.start, { day: "numeric", month: "short" })}</p>}
                  </div>
                )}
                <p className="text-xs text-slate-500">
                  {s.completed} of {s.total} chapters completed
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin setup: years, syllabi, classes
// ---------------------------------------------------------------------------
export function AcademicSetupPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "year" | "syllabi" | "classes") ?? "year";
  return (
    <div className="space-y-5">
      <PageTitle
        title="Academic setup"
        icon="sliders"
        subtitle="Academic year, terms, holidays, syllabi and each class's subjects."
        action={<Tabs value={tab} onChange={(t) => setParams({ tab: t })} options={[{ value: "year", label: "Year & calendar" }, { value: "syllabi", label: "Syllabi" }, { value: "classes", label: "Classes & subjects" }]} />}
      />
      {tab === "year" && <YearSetup />}
      {tab === "syllabi" && <SyllabusSetup />}
      {tab === "classes" && <ClassSetup />}
    </div>
  );
}

function YearSetup() {
  const years = useApi<any>("/academics/years");
  const [addingYear, setAddingYear] = useState(false);
  const [termFor, setTermFor] = useState<any>(null);
  const [holidaysFor, setHolidaysFor] = useState<any>(null);
  const list: any[] = years.data?.years ?? [];
  const removeTerm = async (t: any) => {
    if (!confirm(`Remove ${t.name}?`)) return;
    await api(`/academics/terms/${t.id}`, { method: "DELETE" });
    years.reload();
  };
  const makeCurrent = async (y: any) => {
    await api(`/academics/years/${y.id}`, { method: "PATCH", body: { isCurrent: true } });
    years.reload();
  };
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn" onClick={() => setAddingYear(true)}>
          <Icon name="plus" size={16} /> New academic year
        </button>
      </div>
      {years.loading && !years.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="No academic year yet" icon="calendar">Create the session (for example 2026-27, 1 April to 31 March), then add its terms and holidays.</Empty>
      ) : (
        list.map((y) => (
          <SectionCard
            key={y.id}
            title={`Academic year ${y.name}`}
            icon="calendar"
            action={
              <div className="flex flex-wrap items-center gap-2">
                {y.is_current ? <Badge tone="green">Current</Badge> : <button className="btn-ghost btn-sm" onClick={() => makeCurrent(y)}>Make current</button>}
                <button className="btn-ghost btn-sm" onClick={() => setHolidaysFor(y)}>
                  <Icon name="star" size={14} /> Holidays
                </button>
                <button className="btn btn-sm" onClick={() => setTermFor(y)}>
                  <Icon name="plus" size={14} /> Term
                </button>
              </div>
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="label">Session</p>
                <p className="font-semibold text-slate-900">
                  {fmtDate(y.start_date, { day: "numeric", month: "short", year: "numeric" })} – {fmtDate(y.end_date, { day: "numeric", month: "short", year: "numeric" })}
                </p>
              </div>
              <div className="rounded-2xl bg-emerald-50 p-3">
                <p className="label">Teaching days</p>
                <p className="text-xl font-bold text-emerald-700">{y.teachingDays}</p>
              </div>
              <div className="rounded-2xl bg-rose-50 p-3">
                <p className="label">Holiday & exam days</p>
                <p className="text-xl font-bold text-rose-700">{y.holidayDays}</p>
              </div>
            </div>
            {y.terms.length === 0 ? (
              <p className="text-sm text-slate-500">No terms yet — without terms the whole year is planned as one block.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {y.terms.map((t: any) => (
                  <div key={t.id} className="rounded-2xl p-4 ring-1 ring-slate-200">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-slate-900">{t.name}</p>
                      <button className="rounded-lg p-1 text-slate-400 hover:text-red-600" onClick={() => removeTerm(t)} aria-label={`Remove ${t.name}`}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                    <p className="text-sm text-slate-600">
                      {fmtDate(t.start_date)} – {fmtDate(t.end_date, { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                    {t.exam_start && (
                      <p className="mt-1 text-xs text-indigo-700">
                        Exams {fmtDate(t.exam_start)} – {fmtDate(t.exam_end)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Holidays live on the <Link to="/calendar" className="text-brand underline">school calendar</Link>; plans skip Sundays, holidays and exam weeks.
            </p>
          </SectionCard>
        ))
      )}
      {addingYear && <NewYear onClose={() => setAddingYear(false)} onSaved={years.reload} />}
      {termFor && <NewTerm year={termFor} onClose={() => setTermFor(null)} onSaved={years.reload} />}
      {holidaysFor && <HolidayLoader year={holidaysFor} onClose={() => setHolidaysFor(null)} onSaved={years.reload} />}
    </div>
  );
}

function NewYear({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const y = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const [form, setForm] = useState({ name: `${y}-${String(y + 1).slice(2)}`, startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/academics/years", { body: { ...form, isCurrent: true } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New academic year">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name">
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Starts">
            <input className="input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="Ends">
            <input className="input" type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function NewTerm({ year, onClose, onSaved }: { year: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: `Term ${year.terms.length + 1}`, startDate: year.start_date, endDate: year.end_date, examStart: "", examEnd: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/academics/years/${year.id}/terms`, { body: { ...form, examStart: form.examStart || null, examEnd: form.examEnd || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Add term — ${year.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <input className="input" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Term starts">
            <input className="input" type="date" required min={year.start_date} max={year.end_date} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="Term ends">
            <input className="input" type="date" required min={form.startDate} max={year.end_date} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
          <Field label="Exams from (optional)">
            <input className="input" type="date" min={form.startDate} max={form.endDate} value={form.examStart} onChange={(e) => setForm({ ...form, examStart: e.target.value })} />
          </Field>
          <Field label="Exams until">
            <input className="input" type="date" min={form.examStart || form.startDate} max={form.endDate} value={form.examEnd} onChange={(e) => setForm({ ...form, examEnd: e.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-slate-500">Chapters for this term are planned to finish before the exams start.</p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Add term</button>
        </div>
      </form>
    </Modal>
  );
}

function HolidayLoader({ year, onClose, onSaved }: { year: any; onClose: () => void; onSaved: () => void }) {
  const sugg = useApi<any>(`/academics/years/${year.id}/holiday-suggestions`);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [extra, setExtra] = useState({ name: "", date: "", endDate: "" });
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list: any[] = sugg.data?.holidays ?? [];
  const chosen = picked ?? new Set(list.filter((h) => !h.added).map((h) => h.date + h.name));
  const toggle = (k: string) => {
    const n = new Set(chosen);
    n.has(k) ? n.delete(k) : n.add(k);
    setPicked(n);
  };
  async function save(holidays: any[]) {
    setError(null);
    try {
      const r = await api(`/academics/years/${year.id}/holidays`, { body: { holidays } });
      setOk(`Added ${r.added} holiday(s) to the calendar.`);
      sugg.reload();
      setPicked(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Holidays — ${year.name}`} wide>
      <div className="space-y-4">
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          Festival dates marked “approximate” follow the lunar calendar and differ by state. Please check them against your state government's holiday list before saving.
        </p>
        {sugg.loading && !sugg.data ? (
          <Spinner />
        ) : (
          <ul className="grid max-h-72 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {list.map((h) => {
              const k = h.date + h.name;
              return (
                <li key={k}>
                  <label className={`flex items-center gap-3 rounded-2xl p-2.5 ring-1 ${h.added ? "bg-emerald-50 ring-emerald-200" : "ring-slate-200 hover:bg-slate-50"}`}>
                    <input type="checkbox" className="h-4 w-4" disabled={h.added} checked={h.added || chosen.has(k)} onChange={() => toggle(k)} />
                    <span className="flex-1 text-sm">
                      <span className="block font-semibold text-slate-900">{h.name}</span>
                      <span className="block text-xs text-slate-500">
                        {fmtDate(h.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                        {h.approximate && " · approximate"}
                        {h.added && " · on the calendar"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <button className="btn" disabled={!chosen.size} onClick={() => save(list.filter((h) => !h.added && chosen.has(h.date + h.name)).map((h) => ({ date: h.date, name: h.name })))}>
          Add {chosen.size} holiday(s)
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save([{ name: extra.name, date: extra.date, endDate: extra.endDate || undefined }]);
            setExtra({ name: "", date: "", endDate: "" });
          }}
          className="grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_auto_auto_auto]"
        >
          <input className="input" required placeholder="Other holiday or vacation, e.g. Summer vacation" value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} />
          <input className="input" type="date" required min={year.start_date} max={year.end_date} value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} aria-label="From" />
          <input className="input" type="date" min={extra.date} max={year.end_date} value={extra.endDate} onChange={(e) => setExtra({ ...extra, endDate: e.target.value })} aria-label="To (optional)" />
          <button className="btn-ghost">Add</button>
        </form>
        <SuccessNote message={ok} />
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}

function SyllabusSetup() {
  const list = useApi<any>("/academics/syllabi");
  const years = useApi<any>("/academics/years");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const rows: any[] = list.data?.syllabi ?? [];
  const yearList: any[] = years.data?.years ?? [];
  const remove = async (s: any) => {
    if (!confirm(`Delete the ${s.board} ${s.grade} ${s.subject} syllabus? Plans using it will be cleared.`)) return;
    await api(`/academics/syllabi/${s.id}`, { method: "DELETE" });
    list.reload();
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => setImporting(true)}>
          <Icon name="layers" size={16} /> Import from library
        </button>
        <button className="btn" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New syllabus
        </button>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No syllabi yet" icon="book">Add each board, class and subject's chapter list — or import a ready one from the library.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => (
            <div key={s.id} className="card animate-fade-up">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="brand">{s.board}</Badge>
                    <Badge>{s.grade}</Badge>
                    {s.year && <Badge tone="sky">{s.year}</Badge>}
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-slate-900">{s.subject}</h3>
                  <p className="text-xs text-slate-500">
                    {s.units} chapters · {s.periods} periods · used by {s.used_by} class{s.used_by === 1 ? "" : "es"}
                  </p>
                </div>
                <button className="rounded-lg p-1 text-slate-400 hover:text-red-600" onClick={() => remove(s)} aria-label="Delete syllabus">
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <button className="btn-ghost btn-sm mt-4" onClick={() => setEditing(s.id)}>
                Edit chapters
              </button>
            </div>
          ))}
        </div>
      )}
      {creating && <NewSyllabus years={yearList} onClose={() => setCreating(false)} onSaved={list.reload} />}
      {importing && <ImportSyllabus years={yearList} onClose={() => setImporting(false)} onSaved={list.reload} />}
      {editing && <EditUnits id={editing} onClose={() => setEditing(null)} onSaved={list.reload} />}
    </div>
  );
}

const BOARDS = ["CBSE", "ICSE", "State Board", "IB", "Cambridge (IGCSE)"];
const GRADES = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];
const SUBJECTS = ["English", "Hindi", "Mathematics", "Science", "Social Science", "Sanskrit", "Computer Science", "EVS", "Physics", "Chemistry", "Biology", "Accountancy", "Economics"];

function NewSyllabus({ years, onClose, onSaved }: { years: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ board: "CBSE", grade: "Class 8", subject: "", academicYearId: years.find((y) => y.is_current)?.id ?? "", chapters: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    // One chapter per line; an optional "| periods" suffix sets its length.
    const units = form.chapters
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [title, periods] = l.split("|").map((x) => x.trim());
        return { title, estPeriods: Math.min(200, Math.max(1, Number(periods) || 8)) };
      });
    try {
      await api("/academics/syllabi", { body: { board: form.board, grade: form.grade, subject: form.subject, academicYearId: form.academicYearId || null, units } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New syllabus" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Board">
            <input className="input" required list="boards" value={form.board} onChange={(e) => setForm({ ...form, board: e.target.value })} />
          </Field>
          <Field label="Class">
            <input className="input" required list="grades" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} />
          </Field>
          <Field label="Subject">
            <input className="input" required list="subjects" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Academic year">
            <select className="input" value={form.academicYearId} onChange={(e) => setForm({ ...form, academicYearId: e.target.value })}>
              <option value="">Any year</option>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <datalist id="boards">{BOARDS.map((b) => <option key={b} value={b} />)}</datalist>
        <datalist id="grades">{GRADES.map((g) => <option key={g} value={g} />)}</datalist>
        <datalist id="subjects">{SUBJECTS.map((s) => <option key={s} value={s} />)}</datalist>
        <Field label="Chapters, one per line" hint="Add “| 10” after a chapter to set how many periods it needs (default 8).">
          <textarea className="input min-h-[12rem] font-mono text-xs" value={form.chapters} onChange={(e) => setForm({ ...form, chapters: e.target.value })} placeholder={"Rational Numbers | 12\nLinear Equations in One Variable | 14\nUnderstanding Quadrilaterals | 10"} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create syllabus</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportSyllabus({ years, onClose, onSaved }: { years: any[]; onClose: () => void; onSaved: () => void }) {
  const lib = useApi<any>("/academics/library");
  const [yearId, setYearId] = useState(years.find((y) => y.is_current)?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const take = async (l: any) => {
    setError(null);
    try {
      await api("/academics/syllabi/import", { body: { curriculumVersionId: l.curriculum_version_id, subjectId: l.subject_id, academicYearId: yearId || null } });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Import from the built-in library">
      <div className="space-y-4">
        <Field label="For academic year">
          <select className="input" value={yearId} onChange={(e) => setYearId(e.target.value)}>
            <option value="">Any year</option>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </Field>
        {lib.loading && !lib.data ? (
          <Spinner />
        ) : (
          <ul className="space-y-2">
            {(lib.data?.library ?? []).map((l: any) => (
              <li key={l.curriculum_version_id + l.subject_id} className="flex items-center justify-between gap-3 rounded-2xl p-3 ring-1 ring-slate-200">
                <div>
                  <p className="font-semibold text-slate-900">
                    {l.board} · {l.grade} · {l.subject}
                  </p>
                  <p className="text-xs text-slate-500">
                    {l.chapters} chapters · {l.academic_year}
                  </p>
                </div>
                <button className="btn btn-sm" onClick={() => take(l)}>
                  Import
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">Imported syllabi are your school's own copy — edit chapters and periods freely.</p>
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}

function EditUnits({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const data = useApi<any>(`/academics/syllabi/${id}`);
  const [units, setUnits] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = units ?? (data.data?.units ?? []).map((u: any) => ({ id: u.id, title: u.title, estPeriods: u.est_periods, term: u.term_sequence ?? "", topics: u.topics }));
  const set = (i: number, patch: object) => setUnits(list.map((u: any, j: number) => (j === i ? { ...u, ...patch } : u)));
  const move = (i: number, d: number) => {
    const n = [...list];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setUnits(n);
  };
  async function save() {
    setError(null);
    try {
      await api(`/academics/syllabi/${id}/units`, { method: "PUT", body: { units: list.map((u: any) => ({ ...u, estPeriods: Number(u.estPeriods), term: u.term === "" ? null : Number(u.term) })) } });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const s = data.data?.syllabus;
  return (
    <Modal open onClose={onClose} title={s ? `${s.board} · ${s.grade} · ${s.subject}` : "Chapters"} wide>
      {data.loading && !data.data ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <ul className="max-h-[55vh] space-y-2 overflow-y-auto">
            {list.map((u: any, i: number) => (
              <li key={u.id ?? `new-${i}`} className="grid grid-cols-[auto_1fr_5rem_5rem_auto] items-center gap-2 rounded-2xl bg-slate-50 p-2">
                <span className="w-6 text-center text-xs font-bold text-slate-500">{i + 1}</span>
                <input className="input" value={u.title} onChange={(e) => set(i, { title: e.target.value })} aria-label="Chapter" />
                <input className="input" type="number" min={1} max={200} value={u.estPeriods} onChange={(e) => set(i, { estPeriods: e.target.value })} aria-label="Periods" title="Periods" />
                <select className="input" value={u.term} onChange={(e) => set(i, { term: e.target.value })} aria-label="Term" title="Term">
                  <option value="">Auto</option>
                  <option value="1">T1</option>
                  <option value="2">T2</option>
                  <option value="3">T3</option>
                </select>
                <div className="flex gap-0.5">
                  <button className="rounded-lg p-1 text-slate-400 hover:bg-white disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <Icon name="chevronDown" size={14} className="rotate-180" />
                  </button>
                  <button className="rounded-lg p-1 text-slate-400 hover:bg-white disabled:opacity-30" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <Icon name="chevronDown" size={14} />
                  </button>
                  <button className="rounded-lg p-1 text-slate-400 hover:text-red-600" onClick={() => setUnits(list.filter((_: any, j: number) => j !== i))} aria-label="Remove">
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button className="btn-ghost btn-sm" onClick={() => setUnits([...list, { title: "New chapter", estPeriods: 8, term: "", topics: "" }])}>
            <Icon name="plus" size={14} /> Add chapter
          </button>
          <p className="text-xs text-slate-500">Periods = how many class periods the chapter needs. Term “Auto” lets the planner spread chapters across terms.</p>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" onClick={save}>
              Save chapters
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ClassSetup() {
  const data = useApi<any>("/academics/classes");
  const years = useApi<any>("/academics/years");
  const syllabi = useApi<any>("/academics/syllabi");
  const teachers = useApi<any>("/tenants/current/members");
  const [profile, setProfile] = useState<any>(null);
  const [subjectFor, setSubjectFor] = useState<{ cls: any; s?: any } | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const classes: any[] = data.data?.classes ?? [];
  const teacherList = (teachers.data?.members ?? []).filter((m: any) => m.roles.some((r: string) => ["teacher", "tenant_admin", "tenant_owner"].includes(r)));
  const plan = async (id: string) => {
    setPlanning(id);
    try {
      await api(`/academics/class-subjects/${id}/plan`, { body: {} });
      data.reload();
    } finally {
      setPlanning(null);
    }
  };
  const remove = async (s: any) => {
    if (!confirm(`Remove ${s.subject} and its plan from this class?`)) return;
    await api(`/academics/class-subjects/${s.id}`, { method: "DELETE" });
    data.reload();
  };
  return (
    <div className="space-y-4">
      {data.loading && !data.data ? (
        <Spinner />
      ) : classes.length === 0 ? (
        <Empty title="No classes yet" icon="layers">Create classes on Live classes first, then set their board, grade and subjects here.</Empty>
      ) : (
        classes.map((c) => (
          <SectionCard
            key={c.id}
            title={c.name}
            icon="layers"
            action={
              <div className="flex flex-wrap items-center gap-2">
                {c.board && <Badge tone="brand">{c.board}</Badge>}
                {c.grade && <Badge>{c.grade}</Badge>}
                {c.year && <Badge tone="sky">{c.year}</Badge>}
                <button className="btn-ghost btn-sm" onClick={() => setProfile(c)}>
                  Board & class
                </button>
                <button className="btn btn-sm" onClick={() => setSubjectFor({ cls: c })}>
                  <Icon name="plus" size={14} /> Subject
                </button>
              </div>
            }
          >
            <p className="mb-3 text-xs text-slate-500">
              Class teacher {c.class_teacher} · {c.students} students
            </p>
            {c.subjects.length === 0 ? (
              <p className="text-sm text-slate-500">No subjects yet.</p>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="pl-5">Subject</th>
                      <th>Teacher</th>
                      <th>Periods / week</th>
                      <th>Syllabus</th>
                      <th>Plan</th>
                      <th className="pr-5" />
                    </tr>
                  </thead>
                  <tbody>
                    {c.subjects.map((s: any) => (
                      <tr key={s.id}>
                        <td className="pl-5 font-semibold text-slate-900">{s.subject}</td>
                        <td>{s.teacher ?? <span className="text-slate-400">Not assigned</span>}</td>
                        <td>{s.periods_per_week}</td>
                        <td>{s.syllabus_id ? <Badge tone="green">Linked</Badge> : <Badge tone="amber">None</Badge>}</td>
                        <td>
                          {s.total ? (
                            <Link to={`/academics/plan/${s.id}`} className="text-sm font-semibold text-brand">
                              {s.completed}/{s.total} · {STATE[s.state].label}
                            </Link>
                          ) : (
                            <span className="text-xs text-slate-400">{s.plan_warning ?? "Not generated"}</span>
                          )}
                        </td>
                        <td className="pr-5">
                          <div className="flex justify-end gap-1.5">
                            <button className="btn-ghost btn-sm" onClick={() => plan(s.id)} disabled={planning === s.id}>
                              <Icon name="sparkles" size={13} /> {planning === s.id ? "…" : s.total ? "Re-plan" : "Plan"}
                            </button>
                            <button className="btn-ghost btn-sm" onClick={() => setSubjectFor({ cls: c, s })}>
                              Edit
                            </button>
                            <button className="rounded-lg p-1.5 text-slate-400 hover:text-red-600" onClick={() => remove(s)} aria-label={`Remove ${s.subject}`}>
                              <Icon name="trash" size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ))
      )}
      {profile && <ClassProfile cls={profile} years={years.data?.years ?? []} onClose={() => setProfile(null)} onSaved={data.reload} />}
      {subjectFor && (
        <SubjectModal cls={subjectFor.cls} s={subjectFor.s} teachers={teacherList} syllabi={syllabi.data?.syllabi ?? []} onClose={() => setSubjectFor(null)} onSaved={data.reload} />
      )}
    </div>
  );
}

function ClassProfile({ cls, years, onClose, onSaved }: { cls: any; years: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ board: cls.board ?? "CBSE", grade: cls.grade ?? "", section: cls.section ?? "", academicYearId: cls.academic_year_id ?? years.find((y) => y.is_current)?.id ?? "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/academics/classes/${cls.id}`, { method: "PATCH", body: { ...form, section: form.section || null, academicYearId: form.academicYearId || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`${cls.name} — board & class`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Board">
            <input className="input" required list="boards" value={form.board} onChange={(e) => setForm({ ...form, board: e.target.value })} />
          </Field>
          <Field label="Class / grade">
            <input className="input" required list="grades" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder="Class 8" />
          </Field>
          <Field label="Section">
            <input className="input" maxLength={10} value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="A" />
          </Field>
          <Field label="Academic year">
            <select className="input" value={form.academicYearId} onChange={(e) => setForm({ ...form, academicYearId: e.target.value })}>
              <option value="">Current year</option>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <datalist id="boards">{BOARDS.map((b) => <option key={b} value={b} />)}</datalist>
        <datalist id="grades">{GRADES.map((g) => <option key={g} value={g} />)}</datalist>
        <p className="text-xs text-slate-500">Subjects are linked automatically to the syllabus with the same board, class and subject.</p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function SubjectModal({ cls, s, teachers, syllabi, onClose, onSaved }: { cls: any; s?: any; teachers: any[]; syllabi: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ subject: s?.subject ?? "", teacherId: s?.teacher_id ?? "", periodsPerWeek: s?.periods_per_week ?? 6, syllabusId: s?.syllabus_id ?? "" });
  const [error, setError] = useState<string | null>(null);
  const matching = syllabi.filter((x) => !cls.board || x.board.toLowerCase() === String(cls.board).toLowerCase());
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const body = { ...form, teacherId: form.teacherId || null, periodsPerWeek: Number(form.periodsPerWeek), syllabusId: form.syllabusId || (s ? null : undefined) };
      await api(s ? `/academics/class-subjects/${s.id}` : `/academics/classes/${cls.id}/subjects`, { method: s ? "PATCH" : "POST", body });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={s ? `${cls.name} · ${s.subject}` : `Add a subject to ${cls.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Subject">
            <input className="input" required list="subjects" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Periods per week">
            <input className="input" type="number" min={1} max={48} required value={form.periodsPerWeek} onChange={(e) => setForm({ ...form, periodsPerWeek: Number(e.target.value) })} />
          </Field>
          <Field label="Teacher">
            <select className="input" value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
              <option value="">Assign later</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Syllabus">
            <select className="input" value={form.syllabusId} onChange={(e) => setForm({ ...form, syllabusId: e.target.value })}>
              <option value="">{s ? "None" : "Match automatically"}</option>
              {matching.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.board} · {x.grade} · {x.subject}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <datalist id="subjects">{SUBJECTS.map((x) => <option key={x} value={x} />)}</datalist>
        <p className="text-xs text-slate-500">If the class timetable lists this subject, the plan uses those periods; otherwise it spreads the weekly periods over Monday–Saturday.</p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">{s ? "Save" : "Add subject"}</button>
        </div>
      </form>
    </Modal>
  );
}
