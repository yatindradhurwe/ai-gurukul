import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Badge, Empty, ErrorNote, Field, InfoNote, PageTitle, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, pct100, toneForPercent, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";

type Outcome = "promote" | "supplementary" | "detain" | "incomplete" | "skip";
const OUTCOME: Record<Outcome, { label: string; tone: Tone }> = {
  promote: { label: "Promote", tone: "green" },
  supplementary: { label: "Supplementary re-exam", tone: "amber" },
  detain: { label: "Same class", tone: "red" },
  incomplete: { label: "Decide later", tone: "slate" },
  skip: { label: "Decide later", tone: "slate" },
};

export function PromotionPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "run" | "supplementary" | "rules") ?? "run";
  const set = (t: string) => {
    const p = new URLSearchParams(params);
    p.set("tab", t);
    setParams(p);
  };
  return (
    <div className="space-y-5">
      <PageTitle
        title="Promotion"
        icon="trending"
        subtitle="Promote students from their final exam results: passed → next class, a few failed subjects → supplementary re-exam, more → same class."
        action={
          <Tabs
            value={tab}
            onChange={set}
            options={[
              { value: "run", label: "Run promotion" },
              { value: "supplementary", label: "Supplementary exams" },
              { value: "rules", label: "Rules" },
            ]}
          />
        }
      />
      {tab === "run" && <RunPromotion />}
      {tab === "supplementary" && <Supplementary />}
      {tab === "rules" && <Rules />}
    </div>
  );
}

function RunPromotion() {
  const [params, setParams] = useSearchParams();
  const exams = useApi<any>("/promotion/exams");
  const examId = params.get("examId") ?? exams.data?.exams.find((e: any) => e.is_final)?.id ?? exams.data?.exams[0]?.id ?? "";
  const plan = useApi<any>(examId ? `/promotion/preview?examId=${examId}` : null);
  const classes = useApi<any>("/directory/classes");
  const [choice, setChoice] = useState<Record<string, Outcome>>({});
  const [next, setNext] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  useEffect(() => {
    setChoice({});
    setNext({});
    setDone(null);
  }, [examId]);

  if (exams.loading && !exams.data) return <Spinner />;
  if (!exams.data?.exams.length)
    return (
      <Empty title="No exams with results yet" icon="file">
        Create the annual exam in <Link className="text-brand" to="/exams">Exams</Link>, tick "Final (annual) exam", enter marks and declare results.
      </Empty>
    );
  const p = plan.data;
  const key = (classId: string, studentId: string) => `${classId}:${studentId}`;
  const outcomeOf = (c: any, s: any): Outcome => choice[key(c.class.id, s.studentId)] ?? s.outcome;
  const totals = { promote: 0, supplementary: 0, detain: 0, incomplete: 0 } as Record<string, number>;
  for (const c of p?.classes ?? []) for (const s of c.students) if (!s.handled) totals[outcomeOf(c, s) === "skip" ? "incomplete" : outcomeOf(c, s)]++;
  const allClasses: any[] = classes.data?.classes ?? [];

  const run = async () => {
    if (!confirm("Run promotion now? Each student's year report is saved, then they move as shown. This can't be undone automatically.")) return;
    setBusy(true);
    setErr(null);
    try {
      const overrides = (p.classes as any[]).flatMap((c) =>
        c.students
          .filter((s: any) => !s.handled && (choice[key(c.class.id, s.studentId)] || next[c.class.id]))
          .map((s: any) => ({ studentId: s.studentId, classId: c.class.id, outcome: outcomeOf(c, s), toClassId: next[c.class.id] || null })),
      );
      const r = await api("/promotion/run", { body: { examId, overrides } });
      setDone(r.summary);
      plan.reload();
      exams.reload();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="card flex flex-wrap items-end gap-3">
        <Field label="Exam">
          <select className="input min-w-[18rem]" value={examId} onChange={(e) => setParams({ tab: "run", examId: e.target.value })}>
            {exams.data.exams.map((e: any) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.term}
                {e.is_final ? " · Final" : ""}
                {e.status !== "completed" ? " (results not declared)" : ""}
              </option>
            ))}
          </select>
        </Field>
        {p?.exam && (
          <div className="flex flex-wrap gap-1.5 pb-1">
            {p.exam.is_final ? <Badge tone="amber">Final exam</Badge> : <Badge tone="slate">Not marked final</Badge>}
            <Badge tone={p.exam.status === "completed" ? "green" : "sky"}>{p.exam.status === "completed" ? "Results declared" : "Results not declared"}</Badge>
            {p.exam.promotion_run_at && <Badge tone="brand">Promotion already run</Badge>}
            {p.rules.autoPromote && <Badge tone="brand">Automatic promotion on</Badge>}
          </div>
        )}
      </div>
      <ErrorNote message={plan.error ?? err} />
      {done && (
        <SuccessNote
          message={`Done: ${done.promoted} promoted, ${done.passedOut} passed out, ${done.supplementary} sent to supplementary exams, ${done.detained} kept in the same class${done.skipped.length ? `, ${done.skipped.length} left to decide` : ""}.`}
        />
      )}
      {done?.skipped?.length > 0 && (
        <InfoNote>
          Not moved: {done.skipped.map((s: any) => `${s.name} (${s.className}: ${s.reason})`).join("; ")}.
        </InfoNote>
      )}
      {plan.loading && !p ? (
        <Spinner />
      ) : p ? (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard label="Promote" value={totals.promote} icon="trending" tone="green" />
            <StatCard label="Supplementary re-exam" value={totals.supplementary} icon="file" tone="amber" />
            <StatCard label="Same class" value={totals.detain} icon="alert" tone="red" />
            <StatCard label="Decide later" value={totals.incomplete} icon="clock" tone="slate" hint="Marks missing or set aside" />
          </div>
          {p.exam.status !== "completed" && <InfoNote>This is a preview. Declare the exam's results before running promotion.</InfoNote>}
          {p.classes.map((c: any) => {
            const target = next[c.class.id] ?? c.next?.id ?? "";
            const options = allClasses.filter((x) => x.id !== c.class.id);
            return (
              <SectionCard
                key={c.class.id}
                title={c.class.name}
                icon="graduation"
                action={
                  c.lastGrade ? (
                    <Badge tone="brand">Class 12 · passes out</Badge>
                  ) : (
                    <label className="flex items-center gap-2 text-xs text-slate-500">
                      Promote to
                      <select className="input w-auto py-1 text-sm" value={target} onChange={(e) => setNext({ ...next, [c.class.id]: e.target.value })}>
                        <option value="">No next class</option>
                        {options.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                }
              >
                {!c.lastGrade && !target && <p className="mb-3 text-sm text-amber-700">There's no section of the next class yet. Create it in School directory → Classes 1–12 so students can be promoted.</p>}
                <div className="-mx-5 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="pl-5">Student</th>
                        <th className="text-right">Result</th>
                        <th className="text-right">Attendance</th>
                        <th>Why</th>
                        <th className="pr-5">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.students.map((s: any) => {
                        const o = outcomeOf(c, s);
                        return (
                          <tr key={s.studentId} className={s.handled ? "opacity-60" : ""}>
                            <td className="pl-5">
                              <Link className="font-semibold text-slate-900 hover:text-brand" to={`/directory/students/${s.studentId}`}>
                                {s.name}
                              </Link>
                            </td>
                            <td className="text-right">
                              <Badge tone={toneForPercent(s.percent)}>
                                {pct100(s.percent)}
                                {s.grade && ` · ${s.grade}`}
                              </Badge>
                            </td>
                            <td className="text-right">{pct100(s.attendance)}</td>
                            <td className="max-w-xs text-xs text-slate-600">{s.reasons.join("; ")}</td>
                            <td className="pr-5">
                              {s.handled ? (
                                <Badge tone="slate">Done</Badge>
                              ) : (
                                <select
                                  className={`input w-auto py-1 text-sm ${o === "promote" ? "text-emerald-700" : o === "detain" ? "text-red-700" : o === "supplementary" ? "text-amber-700" : ""}`}
                                  value={o === "incomplete" ? "skip" : o}
                                  onChange={(e) => setChoice({ ...choice, [key(c.class.id, s.studentId)]: e.target.value as Outcome })}
                                >
                                  <option value="promote">{c.lastGrade ? "Pass out" : "Promote"}</option>
                                  <option value="supplementary">Supplementary re-exam</option>
                                  <option value="detain">Same class</option>
                                  <option value="skip">Decide later</option>
                                </select>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn" disabled={busy || p.exam.status !== "completed"} onClick={run}>
              <Icon name="trending" size={16} /> {busy ? "Promoting…" : "Run promotion"}
            </button>
            <p className="text-xs text-slate-500">Each student's year report is saved to their profile first. Students already handled for this exam are left alone.</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Supplementary() {
  const list = useApi<any>("/promotion/supplementary");
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rows: any[] = list.data?.supplementary ?? [];
  const byStudent = new Map<string, any[]>();
  for (const r of rows) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);
  const save = async (r: any, absent = false) => {
    setErr(null);
    setMsg(null);
    try {
      const v = marks[r.id];
      const out = await api(`/promotion/supplementary/${r.id}`, { method: "PUT", body: absent ? { absent: true } : { marks: Number(v) } });
      if (out.result) setMsg(`${r.student}: ${out.result === "promoted" ? `cleared — promoted to ${r.target_class ?? "the next class"}` : out.result === "passed_out" ? "cleared — passed out" : "did not clear — stays in " + r.class_name}.`);
      list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  if (list.loading && !list.data) return <Spinner />;
  return (
    <div className="space-y-4">
      <ErrorNote message={err ?? list.error} />
      <SuccessNote message={msg} />
      {rows.some((r) => r.status === "pending") && (
        <ScheduleBySubject
          rows={rows.filter((r) => r.status === "pending")}
          onSaved={(n) => {
            setMsg(`Scheduled for ${n} student${n === 1 ? "" : "s"}. They and their parents see it on their dashboards now.`);
            list.reload();
          }}
          onError={setErr}
        />
      )}
      {!rows.length ? (
        <Empty title="No supplementary exams pending" icon="check">
          Students who failed in a few subjects of the final exam appear here for a re-exam.
        </Empty>
      ) : (
        [...byStudent.values()].map((items) => (
          <SectionCard key={items[0].student_id} title={`${items[0].student} · ${items[0].class_name}`} icon="file" action={<span className="text-xs text-slate-500">If cleared → {items[0].target_class ?? "passes out"}</span>}>
            <div className="-mx-5 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="pl-5">Subject</th>
                    <th className="text-right">First attempt</th>
                    <th className="text-right">Pass mark</th>
                    <th>Re-exam marks</th>
                    <th className="pr-5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td className="pl-5 font-medium text-slate-900">
                        {r.subject}
                        <span className="block text-xs text-slate-500">{r.exam}</span>
                        <span className={`block text-xs ${r.exam_date ? "text-brand" : "text-amber-600"}`}>{when(r)}</span>
                      </td>
                      <td className="text-right">
                        {r.original_marks ?? "—"}/{r.max_marks}
                      </td>
                      <td className="text-right">{r.pass_marks ?? "—"}</td>
                      <td>
                        {r.status === "pending" ? (
                          <div className="flex items-center gap-1.5">
                            <input className="input w-24 py-1" type="number" min={0} max={r.max_marks} value={marks[r.id] ?? ""} onChange={(e) => setMarks({ ...marks, [r.id]: e.target.value })} aria-label={`${r.subject} marks`} />
                            <button className="btn btn-sm" disabled={marks[r.id] === undefined || marks[r.id] === ""} onClick={() => save(r)}>
                              Save
                            </button>
                            <button className="btn-ghost btn-sm" onClick={() => save(r, true)}>
                              Absent
                            </button>
                          </div>
                        ) : (
                          <span className="font-semibold">{r.status === "absent" ? "Absent" : `${r.marks}/${r.max_marks}`}</span>
                        )}
                      </td>
                      <td className="pr-5">
                        <Badge tone={r.status === "passed" ? "green" : r.status === "pending" ? "amber" : "red"}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">The student moves as soon as every re-exam is marked: all cleared → promoted; otherwise → stays in {items[0].class_name}.</p>
          </SectionCard>
        ))
      )}
    </div>
  );
}

const when = (r: any) =>
  r.exam_date
    ? `${fmtDate(r.exam_date, { weekday: "short", day: "numeric", month: "short" })}${r.start_time ? ` · ${String(r.start_time).slice(0, 5)}` : ""}${r.room ? ` · ${r.room}` : ""}`
    : "Not scheduled yet";

/** One date, time and room for every student re-sitting the same subject. */
function ScheduleBySubject({ rows, onSaved, onError }: { rows: any[]; onSaved: (n: number) => void; onError: (m: string | null) => void }) {
  const groups = new Map<string, any[]>();
  for (const r of rows) groups.set(`${r.exam_id}:${r.subject}`, [...(groups.get(`${r.exam_id}:${r.subject}`) ?? []), r]);
  const [form, setForm] = useState<Record<string, { date: string; time: string; room: string }>>({});
  const save = async (key: string, items: any[]) => {
    const f = form[key];
    onError(null);
    try {
      const r = await api("/promotion/supplementary/schedule", { body: { ids: items.map((x) => x.id), examDate: f.date, startTime: f.time || null, room: f.room || null } });
      onSaved(r.updated);
    } catch (x) {
      onError((x as Error).message);
    }
  };
  return (
    <SectionCard title="Schedule re-exams" icon="calendar">
      <div className="-mx-5 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="pl-5">Subject</th>
              <th>Students</th>
              <th>Now</th>
              <th className="pr-5">Set date, time and room</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([key, items]) => {
              const first = items[0];
              const same = items.every((x) => x.exam_date === first.exam_date && x.start_time === first.start_time && x.room === first.room);
              const f = form[key] ?? { date: first.exam_date ?? "", time: first.start_time ? String(first.start_time).slice(0, 5) : "", room: first.room ?? "" };
              const set = (patch: Partial<typeof f>) => setForm({ ...form, [key]: { ...f, ...patch } });
              return (
                <tr key={key}>
                  <td className="pl-5">
                    <p className="font-semibold text-slate-900">{first.subject}</p>
                    <p className="text-xs text-slate-500">{first.exam}</p>
                  </td>
                  <td className="max-w-[14rem] text-xs text-slate-600">
                    <span className="font-semibold text-slate-900">{items.length}</span> · {items.map((x) => x.student).join(", ")}
                  </td>
                  <td className="text-xs">{same ? when(first) : "Different dates"}</td>
                  <td className="pr-5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input className="input w-36 py-1" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} aria-label={`${first.subject} date`} />
                      <input className="input w-24 py-1" type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} aria-label={`${first.subject} time`} />
                      <input className="input w-28 py-1" placeholder="Room" value={f.room} onChange={(e) => set({ room: e.target.value })} aria-label={`${first.subject} room`} />
                      <button className="btn btn-sm" disabled={!f.date} onClick={() => save(key, items)}>
                        Save
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function Rules() {
  const { can } = useAuth();
  const r = useApi<any>("/promotion/rules");
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = f ?? r.data?.rules;
  if (r.loading && !r.data) return <Spinner />;
  if (!v) return <ErrorNote message={r.error} />;
  const edit = can("tenant.manage");
  const set = (patch: any) => {
    setF({ ...v, ...patch });
    setMsg(null);
  };
  const save = async () => {
    setErr(null);
    try {
      const out = await api("/promotion/rules", { method: "PUT", body: v });
      setF(out.rules);
      setMsg("Rules saved.");
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const num = (s: string) => (s === "" ? null : Number(s));
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="When final results are declared" icon="award">
        <label className="flex items-start gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-brand" disabled={!edit} checked={v.autoPromote} onChange={(e) => set({ autoPromote: e.target.checked })} />
          <span>
            <span className="block text-sm font-semibold text-slate-900">Promote automatically</span>
            <span className="block text-xs text-slate-500">
              As soon as a final exam's results are declared, students are promoted, sent to supplementary exams or kept back by these rules. When off, review and run it yourself from "Run promotion".
            </span>
          </span>
        </label>
      </SectionCard>
      <SectionCard title="Rules" icon="sliders">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Supplementary up to" hint="Failed subjects allowed a re-exam (0 = none)">
            <input className="input" type="number" min={0} max={10} disabled={!edit} value={v.maxSupplementarySubjects} onChange={(e) => set({ maxSupplementarySubjects: Number(e.target.value) })} />
          </Field>
          <Field label="Minimum attendance %" hint="Blank = no rule">
            <input className="input" type="number" min={0} max={100} disabled={!edit} value={v.minAttendance ?? ""} onChange={(e) => set({ minAttendance: num(e.target.value) })} />
          </Field>
          <Field label="Minimum overall %" hint="Blank = pass marks only">
            <input className="input" type="number" min={0} max={100} disabled={!edit} value={v.minPercent ?? ""} onChange={(e) => set({ minPercent: num(e.target.value) })} />
          </Field>
        </div>
        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          <li>
            <Badge tone="green">Promote</Badge> passed every subject (each paper's pass mark){v.minPercent != null && ` and at least ${v.minPercent}% overall`}
            {v.minAttendance != null && `, with ${v.minAttendance}% attendance`}.
          </li>
          <li>
            <Badge tone="amber">Supplementary</Badge> failed in {v.maxSupplementarySubjects === 0 ? "— (off)" : `1–${v.maxSupplementarySubjects} subject${v.maxSupplementarySubjects > 1 ? "s" : ""}`}; promoted if every re-exam is cleared.
          </li>
          <li>
            <Badge tone="red">Same class</Badge> failed in more subjects{v.minAttendance != null || v.minPercent != null ? ", or below the minimums" : ""}.
          </li>
          <li>
            <Badge tone="slate">Decide later</Badge> any marks missing.
          </li>
        </ul>
        {edit && (
          <div className="mt-4 space-y-2">
            <ErrorNote message={err} />
            <SuccessNote message={msg} />
            <button className="btn" onClick={save}>
              <Icon name="check" size={16} /> Save rules
            </button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
