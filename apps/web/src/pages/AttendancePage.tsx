import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, PageTitle, Progress, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, pct100, todayISO, toneForPercent, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ClassPicker, StudentPicker, useClasses, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

type Status = "present" | "absent" | "late" | "excused";
const STATUSES: { value: Status; label: string; short: string; tone: Tone; active: string }[] = [
  { value: "present", label: "Present", short: "P", tone: "green", active: "bg-emerald-500 text-white ring-emerald-500" },
  { value: "absent", label: "Absent", short: "A", tone: "red", active: "bg-rose-500 text-white ring-rose-500" },
  { value: "late", label: "Late", short: "L", tone: "amber", active: "bg-amber-500 text-white ring-amber-500" },
  { value: "excused", label: "Excused", short: "E", tone: "sky", active: "bg-sky-500 text-white ring-sky-500" },
];
const TONE_OF = Object.fromEntries(STATUSES.map((s) => [s.value, s.tone])) as Record<Status, Tone>;

export function AttendancePage() {
  const { can } = useAuth();
  if (can("classes.manage")) return <StaffAttendance />;
  return <StudentAttendance />;
}

function StaffAttendance() {
  const { classes, loading } = useClasses();
  const [params, setParams] = useSearchParams();
  const classId = params.get("classId") ?? classes[0]?.id ?? "";
  const [tab, setTab] = useState<"mark" | "report">("mark");

  if (loading && !classes.length) return <Spinner />;
  return (
    <div className="space-y-5">
      <PageTitle
        title="Attendance"
        icon="checkSquare"
        subtitle="Mark daily attendance and track each student's record."
        action={
          <>
            <Tabs value={tab} onChange={setTab} options={[{ value: "mark", label: "Mark" }, { value: "report", label: "Report" }]} />
            {classes.length > 0 && <ClassPicker value={classId} onChange={(id) => setParams({ classId: id })} classes={classes} />}
          </>
        }
      />
      {!classes.length ? (
        <Empty title="No classes yet" icon="layers">Create a class on Live classes and enrol students to take attendance.</Empty>
      ) : tab === "mark" ? (
        <MarkAttendance classId={classId} />
      ) : (
        <ClassReport classId={classId} />
      )}
    </div>
  );
}

function MarkAttendance({ classId }: { classId: string }) {
  const [date, setDate] = useState(todayISO());
  const sheet = useApi<any>(classId ? `/attendance/classes/${classId}?date=${date}` : null);
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const students: any[] = sheet.data?.students ?? [];

  useEffect(() => {
    setMarks(Object.fromEntries(students.filter((s) => s.status).map((s) => [s.student_id, s.status])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.data]);
  useEffect(() => setOk(null), [classId, date]);

  const counts = STATUSES.map((s) => ({ ...s, n: Object.values(marks).filter((m) => m === s.value).length }));
  const unmarked = students.length - Object.keys(marks).length;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const records = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
      await api(`/attendance/classes/${classId}`, { body: { date, records } });
      setOk(`Saved attendance for ${records.length} student(s) on ${fmtDate(date, { day: "numeric", month: "long" })}.`);
      sheet.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={sheet.data?.class?.name ?? "Class"}
      icon="users"
      action={<input type="date" className="input w-auto" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
    >
      {sheet.loading && !sheet.data ? (
        <Spinner />
      ) : students.length === 0 ? (
        <Empty title="No students in this class" icon="users">Enrol students from Live classes → Manage.</Empty>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {counts.map((c) => (
              <Badge key={c.value} tone={c.tone}>
                {c.label}: {c.n}
              </Badge>
            ))}
            {unmarked > 0 && <Badge>Not marked: {unmarked}</Badge>}
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost btn-sm" onClick={() => setMarks(Object.fromEntries(students.map((s) => [s.student_id, "present"])))}>
                <Icon name="check" size={14} /> All present
              </button>
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {students.map((s) => (
              <li key={s.student_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={s.name} size={36} />
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{s.name}</p>
                    <p className="text-xs text-slate-500">{s.email}</p>
                  </div>
                </div>
                <div className="flex gap-1.5" role="radiogroup" aria-label={`Attendance for ${s.name}`}>
                  {STATUSES.map((st) => {
                    const on = marks[s.student_id] === st.value;
                    return (
                      <button
                        key={st.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={st.label}
                        onClick={() => setMarks({ ...marks, [s.student_id]: st.value })}
                        className={`h-9 min-w-9 rounded-xl px-2.5 text-sm font-semibold ring-1 transition ${on ? st.active : "text-slate-500 ring-slate-200 hover:bg-slate-100"}`}
                      >
                        <span className="sm:hidden">{st.short}</span>
                        <span className="hidden sm:inline">{st.label}</span>
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <ErrorNote message={error} />
            <SuccessNote message={ok} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">{sheet.data?.marked ? "Attendance was already taken for this day — saving updates it." : "Not taken yet for this day."}</p>
              <button className="btn" onClick={save} disabled={busy || !Object.keys(marks).length}>
                {busy ? "Saving…" : "Save attendance"}
              </button>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

function ClassReport({ classId }: { classId: string }) {
  const report = useApi<any>(classId ? `/attendance/classes/${classId}/report` : null);
  if (report.loading && !report.data) return <Spinner />;
  const rows: any[] = report.data?.students ?? [];
  const rated = rows.filter((r) => r.rate != null);
  const avg = rated.length ? rated.reduce((t, r) => t + r.rate, 0) / rated.length : null;
  const atRisk = rated.filter((r) => r.rate < 75).length;
  return (
    <div className="space-y-5">
      <ErrorNote message={report.error} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Days recorded" value={report.data?.days ?? 0} icon="calendar" />
        <StatCard label="Class average" value={pct100(avg)} icon="chart" tone={toneForPercent(avg)} />
        <StatCard label="Below 75%" value={atRisk} icon="alert" tone={atRisk ? "red" : "green"} hint="Students needing follow-up" />
      </div>
      <SectionCard title="By student" icon="users">
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="pl-5">Student</th>
                <th>Attended</th>
                <th>Absent</th>
                <th>Late</th>
                <th className="w-1/3 pr-5">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.student_id}>
                  <td className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} size={28} />
                      <span className="font-medium text-slate-900">{r.name}</span>
                    </div>
                  </td>
                  <td>{r.attended}</td>
                  <td>{r.absent}</td>
                  <td>{r.late}</td>
                  <td className="pr-5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <Progress value={r.rate ?? 0} tone={r.rate == null ? "brand" : r.rate >= 75 ? "green" : r.rate >= 50 ? "amber" : "red"} />
                      </div>
                      <span className="w-12 text-right text-sm font-semibold">{pct100(r.rate)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function StudentAttendance() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [params] = useSearchParams();
  const [studentId, setStudentId] = useState<string | null>(params.get("studentId"));
  const data = useApi<any>(parent ? (studentId ? `/attendance/students?studentId=${studentId}` : null) : "/attendance/students");
  const s = data.data?.summary;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Attendance"
        icon="checkSquare"
        subtitle={parent ? "Your child's attendance record." : "Your attendance record across classes."}
        action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />}
      />
      <ErrorNote message={data.error} />
      {parent && !students.loading && !students.options.length && <Empty title="No children linked" icon="heart">Link your child from My children to see attendance.</Empty>}
      {data.loading && !data.data ? (
        <Spinner />
      ) : (
        s && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Attendance rate" value={pct100(s.rate)} icon="chart" tone={toneForPercent(s.rate)} hint={s.rate != null && s.rate < 75 ? "Below the 75% requirement" : undefined} />
              <StatCard label="Days attended" value={s.attended} icon="check" tone="green" />
              <StatCard label="Absent" value={s.absent} icon="x" tone="red" />
              <StatCard label="Late / excused" value={`${s.late} / ${s.excused}`} icon="clock" tone="amber" />
            </div>
            <SectionCard title="Recent days" icon="calendar">
              {data.data.records.length ? (
                <ul className="divide-y divide-slate-100">
                  {data.data.records.map((r: any, i: number) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{fmtDate(r.date, { weekday: "short", day: "numeric", month: "short" })}</p>
                        <p className="text-xs text-slate-500">
                          {r.class_name}
                          {r.note && ` · ${r.note}`}
                        </p>
                      </div>
                      <Badge tone={TONE_OF[r.status as Status]}>{r.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No attendance recorded yet.</p>
              )}
            </SectionCard>
          </>
        )
      )}
    </div>
  );
}
