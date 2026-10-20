import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Badge, Empty, ErrorNote, PageTitle, Progress, Spinner, fmtDate, pct100, toneForPercent } from "../components/ui";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const BANDS = [
  ["A1", "91–100"],
  ["A2", "81–90"],
  ["B1", "71–80"],
  ["B2", "61–70"],
  ["C1", "51–60"],
  ["C2", "41–50"],
  ["D", "33–40"],
  ["E", "Below 33"],
];

export function ReportCardPage() {
  const { info } = useAuth();
  const self = !!info?.studentProfileId;
  const students = useStudentOptions();
  const [params, setParams] = useSearchParams();
  const studentId = params.get("studentId");
  const term = params.get("term") ?? "";
  const needsPick = !self && students.needed;
  const query = new URLSearchParams();
  if (studentId && !self) query.set("studentId", studentId);
  if (term) query.set("term", term);
  const card = useApi<any>(needsPick && !studentId ? null : `/gradebook/report-card?${query}`);
  const r = card.data;
  const setQuery = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries({ studentId: studentId ?? "", term, ...next }).filter(([, v]) => v)));

  return (
    <div className="space-y-5">
      <div className="no-print">
        <PageTitle
          title="Report card"
          icon="file"
          subtitle="Marks, grades, attendance and homework for the term."
          action={
            <>
              {needsPick && <StudentPicker value={studentId} onChange={(id) => setQuery({ studentId: id })} options={students.options} />}
              {r?.terms?.length > 0 && (
                <select className="input w-auto" value={term} onChange={(e) => setQuery({ term: e.target.value })} aria-label="Term">
                  <option value="">All terms</option>
                  {r.terms.map((t: string) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              {r && (
                <button className="btn" onClick={() => window.print()}>
                  <Icon name="printer" size={16} /> Print / PDF
                </button>
              )}
            </>
          }
        />
      </div>
      <ErrorNote message={card.error} />
      {needsPick && !students.loading && !students.options.length && <Empty title="No students to show" icon="users">There are no students linked to your account yet.</Empty>}
      {card.loading && !r ? (
        <Spinner />
      ) : (
        r && (
          <article className="card overflow-hidden p-0 animate-fade-up">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-brand to-violet-500 px-6 py-6 text-white md:px-8">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
                  <Icon name="graduation" size={26} />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-white/75">{r.organization}</p>
                  <h2 className="font-display text-2xl font-semibold">Progress report</h2>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold">{r.student.name}</p>
                <p className="text-sm text-white/80">{r.term ?? "All terms"} · Issued {fmtDate(r.generatedAt, { day: "numeric", month: "long", year: "numeric" })}</p>
              </div>
            </div>

            {/* Summary */}
            <div className="grid divide-y divide-slate-100 border-b border-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Summary label="Overall" value={pct100(r.overall.percent)} badge={r.overall.grade} percent={r.overall.percent} />
              <Summary label="Attendance" value={pct100(r.attendance.rate)} hint={`${r.attendance.attended} of ${r.attendance.counted} days`} percent={r.attendance.rate} />
              <Summary
                label="Homework"
                value={`${r.assignments.submitted}/${r.assignments.total}`}
                hint={r.assignments.averagePercent != null ? `Average score ${pct100(r.assignments.averagePercent)}` : "submitted"}
                percent={r.assignments.total ? (r.assignments.submitted / r.assignments.total) * 100 : null}
              />
            </div>

            {/* Subjects */}
            <div className="space-y-6 p-6 md:p-8">
              {r.subjects.length === 0 ? (
                <Empty title="Not enrolled in any class yet" icon="layers">Marks appear here once the student is in a class and has been assessed.</Empty>
              ) : (
                r.subjects.map((s: any) => (
                  <section key={s.classId} className="break-inside-avoid">
                    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">{s.name}</h3>
                        <p className="text-xs text-slate-500">Teacher: {s.teacher}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-700">
                          {s.max ? `${Number(s.obtained)}/${Number(s.max)}` : "Not assessed"}
                        </span>
                        {s.grade && <Badge tone={toneForPercent(s.percent)}>{s.grade} · {pct100(s.percent)}</Badge>}
                      </div>
                    </div>
                    {s.items.length > 0 ? (
                      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-100">
                        <table className="table">
                          <thead>
                            <tr>
                              <th className="pl-4">Assessment</th>
                              <th>Term</th>
                              <th>Date</th>
                              <th className="text-right">Marks</th>
                              <th className="pr-4">Remarks</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.items.map((i: any) => (
                              <tr key={i.id}>
                                <td className="pl-4 font-medium text-slate-900">
                                  {i.title} <span className="text-xs font-normal capitalize text-slate-400">· {i.category}</span>
                                </td>
                                <td className="text-slate-500">{i.term}</td>
                                <td className="text-slate-500">{fmtDate(i.date)}</td>
                                <td className="text-right font-semibold">{i.marks == null ? "—" : `${Number(i.marks)}/${Number(i.max_marks)}`}</td>
                                <td className="pr-4 text-slate-500">{i.remarks ?? ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">No assessments recorded yet.</p>
                    )}
                  </section>
                ))
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
                <span className="font-semibold text-slate-700">Grading scale</span>
                {BANDS.map(([g, range]) => (
                  <span key={g}>
                    <b className="text-slate-700">{g}</b> {range}
                  </span>
                ))}
              </div>
            </div>
          </article>
        )
      )}
    </div>
  );
}

function Summary({ label, value, badge, hint, percent }: { label: string; value: string; badge?: string | null; hint?: string; percent: number | null }) {
  return (
    <div className="p-5 md:px-8">
      <p className="label">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-3xl font-bold text-slate-900">{value}</p>
        {badge && <Badge tone={toneForPercent(percent)}>{badge}</Badge>}
      </div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      <div className="mt-3">
        <Progress value={percent ?? 0} tone={percent == null ? "brand" : percent >= 75 ? "green" : percent >= 50 ? "amber" : "red"} />
      </div>
    </div>
  );
}
