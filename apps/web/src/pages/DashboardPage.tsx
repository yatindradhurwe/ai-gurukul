import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "../components/icons";
import { Avatar, Badge, Donut, Empty, ErrorNote, Progress, SectionCard, Spinner, StatCard, fmtDate, fmtDateTime, inr, pct100, toneForPercent } from "../components/ui";
import { BadgeShelf, CelebrationToast, GoalsCard, Leaderboard, LevelCard, useCelebrations, type Engagement } from "../components/Rewards";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

interface Slot {
  id: string;
  class_name: string;
  subject: string;
  room: string | null;
  start_time: string;
  end_time: string;
}

function Schedule({ slots, empty }: { slots: Slot[]; empty: string }) {
  if (!slots.length) return <p className="text-sm text-slate-500">{empty}</p>;
  const now = new Date().toTimeString().slice(0, 5);
  return (
    <ol className="relative space-y-3 border-l-2 border-slate-100 pl-5">
      {slots.map((s) => {
        const current = s.start_time <= now && now < s.end_time;
        return (
          <li key={s.id} className="relative">
            <span className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full ring-4 ring-surface ${current ? "bg-brand" : s.end_time <= now ? "bg-slate-300" : "bg-amber-400"}`} />
            <div className={`rounded-xl px-3 py-2 ${current ? "bg-brand-soft" : ""}`}>
              <p className="text-xs font-semibold text-slate-500">
                {s.start_time} – {s.end_time} {current && <span className="ml-1 text-brand">· now</span>}
              </p>
              <p className="text-sm font-semibold text-slate-900">{s.subject}</p>
              <p className="text-xs text-slate-500">
                {s.class_name}
                {s.room && ` · ${s.room}`}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function QuickAction({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-2 rounded-xl bg-white/15 px-3 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/25">
      <Icon name={icon} size={16} /> {label}
    </Link>
  );
}

function WeekBars({ days }: { days: { date: string; rate: number | null }[] }) {
  if (!days.length) return <p className="text-sm text-slate-500">No attendance marked in the last 7 days.</p>;
  return (
    <div className="flex h-40 items-end gap-3">
      {days.map((d) => (
        <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-[11px] font-semibold text-slate-600">{pct100(d.rate)}</span>
          <div className="flex h-28 w-full items-end overflow-hidden rounded-lg bg-slate-100">
            <div className={`w-full rounded-lg ${d.rate == null ? "" : d.rate >= 75 ? "bg-emerald-500" : d.rate >= 50 ? "bg-amber-500" : "bg-rose-500"}`} style={{ height: `${d.rate ?? 0}%` }} />
          </div>
          <span className="text-[11px] text-slate-500">{fmtDate(d.date, { weekday: "short" })}</span>
        </div>
      ))}
    </div>
  );
}

const YEAR_RESULT: Record<string, { label: string; tone: "green" | "amber" | "red" | "slate" | "sky" }> = {
  promoted: { label: "Promoted", tone: "green" },
  passed_out: { label: "Passed out", tone: "green" },
  detained: { label: "Same class", tone: "red" },
  left: { label: "Left school", tone: "slate" },
};

/** A child's promotion picture for parents: re-exams due, a decision pending, and each year's result. */
function ChildStanding({ c }: { c: any }) {
  const [more, setMore] = useState(false);
  const supp: any[] = c.supplementary ?? [];
  const years: any[] = c.promotions ?? [];
  if (!supp.length && !c.awaitingPromotion && !years.length) return null;
  const latest = years[0];
  return (
    <div className="mt-3 space-y-2">
      {supp.length > 0 && (
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <Icon name="file" size={15} /> Supplementary exam{supp.length > 1 ? "s" : ""}
          </p>
          <ul className="mt-1.5 space-y-1 text-xs text-amber-900">
            {supp.map((x, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-1">
                <span>
                  <span className="font-semibold">{x.subject}</span> · first attempt {x.original_marks ?? "—"}/{x.max_marks}
                  {x.pass_marks != null && ` (pass ${x.pass_marks})`}
                </span>
                {x.status === "pending" ? (
                  <Badge tone="amber">{x.exam_date ? `on ${fmtDate(x.exam_date)}` : "date to be announced"}</Badge>
                ) : (
                  <Badge tone={x.status === "passed" ? "green" : "red"}>{x.status === "absent" ? "absent" : `${x.status} · ${x.marks}/${x.max_marks}`}</Badge>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-amber-800">
            Clearing every re-exam promotes {c.name.split(" ")[0]} to {supp[0].target_class ?? "the next class"}; otherwise they stay in {supp[0].class_name}.
          </p>
        </div>
      )}
      {!supp.length && c.awaitingPromotion && (
        <div className="rounded-xl bg-sky-50 p-3 text-xs text-sky-900 ring-1 ring-sky-200">
          <span className="font-semibold">{c.awaitingPromotion}</span> results are out. The school will confirm promotion soon.
        </div>
      )}
      {latest && (
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">
              {latest.year_name}: {latest.class_name}
              {latest.promoted_to_class_name && ` → ${latest.promoted_to_class_name}`}
            </p>
            <Badge tone={YEAR_RESULT[latest.result]?.tone ?? "slate"}>{YEAR_RESULT[latest.result]?.label ?? latest.result}</Badge>
          </div>
          {latest.remarks && <p className="mt-1 text-xs text-slate-500">{latest.remarks}</p>}
          {years.length > 1 && (
            <>
              <button className="mt-1.5 text-xs font-semibold text-brand" onClick={() => setMore(!more)}>
                {more ? "Hide earlier years" : `Earlier years (${years.length - 1})`}
              </button>
              {more && (
                <ul className="mt-1.5 space-y-1 text-xs text-slate-600">
                  {years.slice(1).map((y, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span>
                        {y.year_name}: {y.class_name}
                        {y.promoted_to_class_name && ` → ${y.promoted_to_class_name}`}
                      </span>
                      <span className="font-medium">{YEAR_RESULT[y.result]?.label ?? y.result}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DashboardPage() {
  const { user, can, tenant, info } = useAuth();
  const dash = useApi<any>("/dashboard");
  const isStudent = !!info?.studentProfileId;
  const reward = useApi<Engagement>(isStudent ? "/engagement/me" : null);
  const { news: toast, dismiss } = useCelebrations(reward.data);
  const feeSummary = useApi<any>(dash.data?.fees ? "/fees/summary" : null).data?.totals;
  const syllabus = useApi<any>(isStudent ? "/academics/student" : null).data?.subjects as any[] | undefined;
  const news = useApi<any>("/announcements");

  if (dash.loading && !dash.data) return <Spinner />;
  const d = dash.data ?? {};
  const org = d.organization;
  const teaching = d.teaching;
  const student = d.student;
  const children: any[] | undefined = d.children;
  const fees = d.fees;
  const library = d.library;
  const transport = d.transport;
  const hostel = d.hostel;
  const attention = d.attention;
  const latest = (news.data?.announcements ?? []).slice(0, 4);

  const actions: { to: string; icon: IconName; label: string }[] = [];
  if (can("classes.manage")) actions.push({ to: "/attendance", icon: "checkSquare", label: "Mark attendance" }, { to: "/assignments", icon: "clipboard", label: "New assignment" });
  if (can("announcements.manage")) actions.push({ to: "/announcements", icon: "megaphone", label: "Post notice" });
  if (can("members.manage")) actions.push({ to: "/people", icon: "users", label: "Invite people" });
  if (can("tutor.use")) actions.push({ to: "/tutor", icon: "sparkles", label: "Ask AI teacher" });
  if (can("planner.self")) actions.push({ to: "/today", icon: "target", label: "My study plan" });
  if (can("reports.children")) actions.push({ to: "/report-card", icon: "chart", label: "Report card" }, { to: "/fees", icon: "card", label: "Fees" });
  if (can("fees.manage")) actions.push({ to: "/fees?tab=invoices", icon: "card", label: "Collect fees" });
  if (can("library.manage")) actions.push({ to: "/library", icon: "book", label: "Issue a book" });
  if (can("exams.manage")) actions.push({ to: "/exams", icon: "file", label: "Exams" });

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section
        className={`relative overflow-hidden rounded-[2rem] p-6 text-white shadow-lift animate-fade-up md:p-8 ${
          isStudent ? "bg-gradient-to-br from-amber-400 via-orange-400 to-pink-500" : "bg-gradient-to-br from-brand via-indigo-500 to-violet-500"
        }`}
      >
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute -bottom-20 right-24 h-48 w-48 rounded-full bg-amber-300/20 blur-2xl" />
        <div className="relative">
          <p className="text-sm text-white/80">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight md:text-4xl">
            {greeting()}, {user?.name.split(" ")[0]}
          </h1>
          <p className="mt-1 text-white/90">
            {isStudent ? "Ready for today's learning adventure? Complete your quests to earn XP!" : tenant ? `Welcome back to ${tenant.name}.` : "Welcome back."}
          </p>
          {actions.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {actions.slice(0, 4).map((a) => (
                <QuickAction key={a.to + a.label} {...a} />
              ))}
            </div>
          )}
        </div>
      </section>
      <ErrorNote message={dash.error} />

      {attention && (
        <div className="flex flex-wrap items-center gap-2 rounded-[1.6rem] bg-white p-3 shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
          <span className="flex items-center gap-2 px-2 text-sm font-semibold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-100 text-rose-600 animate-wiggle">
              <Icon name="bell" size={16} />
            </span>
            Needs your attention
          </span>
          {attention.leaveToReview > 0 && (
            <Link to="/leave" className="chip bg-amber-100 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-200">
              {attention.leaveToReview} leave request(s) to review
            </Link>
          )}
          {attention.newEnquiries > 0 && (
            <Link to="/admissions" className="chip bg-sky-100 px-3 py-1.5 text-sm text-sky-800 hover:bg-sky-200">
              {attention.newEnquiries} new admission enquir{attention.newEnquiries === 1 ? "y" : "ies"}
            </Link>
          )}
          {attention.meetingsToday > 0 && (
            <Link to="/meetings" className="chip bg-emerald-100 px-3 py-1.5 text-sm text-emerald-800 hover:bg-emerald-200">
              {attention.meetingsToday} parent meeting(s) today
            </Link>
          )}
        </div>
      )}

      {/* Organization overview */}
      {org && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard label="Students" value={org.students} icon="graduation" hint={`${org.parents} parents linked`} />
            <StatCard label="Teachers" value={org.teachers} icon="users" tone="sky" hint={`${org.staff} admin & staff`} />
            <StatCard label="Classes" value={org.classes} icon="layers" tone="amber" hint={org.liveNow ? `${org.liveNow} live right now` : "No class live now"} />
            <StatCard label="Attendance today" value={pct100(org.attendanceToday)} icon="checkSquare" tone={toneForPercent(org.attendanceToday)} hint="Present or late" />
          </div>
          <SectionCard title="Attendance — last 7 days" icon="chart" action={<Link to="/attendance" className="text-xs font-semibold text-brand">Details →</Link>}>
            <WeekBars days={org.attendanceWeek} />
          </SectionCard>
        </>
      )}

      {isStudent && reward.data && (
        <>
          <LevelCard e={reward.data} />
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <BadgeShelf e={reward.data} limit={6} />
            </div>
            <div className="space-y-6">
              <GoalsCard e={reward.data} />
            </div>
          </div>
        </>
      )}

      {(transport || hostel) && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {transport && (
            <>
              <StatCard label="Students on transport" value={transport.riders} icon="bus" tone="amber" hint={`${transport.routes} routes · ${transport.vehicles} buses`} />
            </>
          )}
          {hostel && (
            <>
              <StatCard label="Hostel beds used" value={`${hostel.occupied}/${hostel.beds}`} icon="home" tone="green" hint={`${hostel.beds - hostel.occupied} free in ${hostel.hostels} hostel(s)`} />
            </>
          )}
        </div>
      )}

      {(feeSummary || hostel) && (
        <div className="grid gap-4 md:grid-cols-2">
          {feeSummary && (
            <SectionCard title="Fee collection" icon="card" action={<Link to="/fees" className="text-xs font-semibold text-brand">Fees →</Link>}>
              <Donut value={Number(feeSummary.collected)} total={Number(feeSummary.billed)} label="of billed fees collected" sub={`${inr(feeSummary.collected)} of ${inr(feeSummary.billed)}`} color="#10b981" />
            </SectionCard>
          )}
          {hostel && hostel.beds > 0 && (
            <SectionCard title="Hostel occupancy" icon="home" action={<Link to="/hostel" className="text-xs font-semibold text-brand">Hostel →</Link>}>
              <Donut value={hostel.occupied} total={hostel.beds} label="of beds occupied" sub={`${hostel.occupied} of ${hostel.beds} beds`} color="#f59e0b" />
            </SectionCard>
          )}
        </div>
      )}

      {(fees || library) && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {fees && (
            <>
              <StatCard label="Fees collected this month" value={inr(fees.collected_month_paise)} icon="trending" tone="green" />
              <StatCard label="Fees outstanding" value={inr(fees.outstanding_paise)} icon="card" tone="amber" hint={fees.overdue_students ? `${fees.overdue_students} student(s) overdue` : "No overdue fees"} />
            </>
          )}
          {library && (
            <>
              <StatCard label="Library books on loan" value={library.on_loan} icon="book" tone="sky" hint={`${library.titles} titles in the catalogue`} />
              <StatCard label="Library overdue" value={library.overdue} icon="alert" tone={library.overdue ? "red" : "green"} />
            </>
          )}
        </div>
      )}

      {/* Student overview */}
      {student && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard label="My attendance" value={pct100(student.attendanceRate)} icon="checkSquare" tone={toneForPercent(student.attendanceRate)} />
          <StatCard label="Homework due" value={student.due.length} icon="clipboard" tone={student.due.length ? "amber" : "green"} hint={student.due[0] ? `Next: ${student.due[0].title}` : "All caught up"} />
          <StatCard label="Classes today" value={student.today.length} icon="clock" tone="sky" />
          <StatCard label="Live classes" value={student.sessions.length} icon="video" tone={student.sessions.some((s: any) => s.status === "live") ? "red" : "brand"} hint={student.sessions.some((s: any) => s.status === "live") ? "A class is live now!" : "Scheduled"} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {teaching && (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                <StatCard label="My classes" value={teaching.classes.length} icon="layers" />
                <StatCard label="To grade" value={teaching.toGrade} icon="clipboard" tone={teaching.toGrade ? "amber" : "green"} hint="Submitted assignments" />
                <StatCard label="Attendance pending" value={teaching.attendancePending.length} icon="checkSquare" tone={teaching.attendancePending.length ? "red" : "green"} hint="Classes not marked today" />
              </div>
              {teaching.attendancePending.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
                  <Icon name="alert" size={16} />
                  Attendance not marked today for:
                  {teaching.attendancePending.map((c: any) => (
                    <Link key={c.id} to={`/attendance?classId=${c.id}`} className="chip bg-surface font-semibold text-amber-800 ring-1 ring-amber-200 hover:ring-amber-400">
                      {c.name}
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}

          {(teaching || student) && (
            <SectionCard title="Live classes" icon="video" action={<Link to="/classes" className="text-xs font-semibold text-brand">All classes →</Link>}>
              {(teaching?.sessions ?? student?.sessions ?? []).length ? (
                <ul className="space-y-2">
                  {(teaching?.sessions ?? student?.sessions).map((s: any) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ring-1 ring-slate-100 transition hover:bg-slate-50">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{s.title}</p>
                        <p className="text-xs text-slate-500">{s.class_name}</p>
                      </div>
                      <Link to={`/live/${s.id}`} className={s.status === "live" ? "btn btn-sm" : "btn-ghost btn-sm"}>
                        {s.status === "live" ? (
                          <>
                            <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> Join live
                          </>
                        ) : teaching ? (
                          "Open & start"
                        ) : (
                          "Waiting room"
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No live classes scheduled.</p>
              )}
            </SectionCard>
          )}

          {student && (student.feesDuePaise > 0 || student.books.overdue > 0 || student.bus || student.room) && (
            <div className="flex flex-wrap gap-3">
              {student.bus && (
                <Link to="/transport" className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200 transition hover:-translate-y-0.5">
                  <Icon name="bus" size={16} /> {student.bus.route} · pickup {student.bus.pickup_time} at {student.bus.stop}
                </Link>
              )}
              {student.room && (
                <Link to="/hostel" className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200 transition hover:-translate-y-0.5">
                  <Icon name="home" size={16} /> {student.room.hostel} · Room {student.room.room_no}
                </Link>
              )}
              {student.feesDuePaise > 0 && (
                <Link to="/fees" className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
                  <Icon name="card" size={16} /> {inr(student.feesDuePaise)} fees due{student.feesOverdue ? ` · ${student.feesOverdue} overdue` : ""}
                </Link>
              )}
              {student.books.overdue > 0 && (
                <Link to="/library" className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
                  <Icon name="book" size={16} /> {student.books.overdue} library book(s) overdue
                </Link>
              )}
            </div>
          )}

          {syllabus && syllabus.length > 0 && (
            <SectionCard title="In class this week" icon="book" action={<Link to="/syllabus" className="text-xs font-semibold text-brand">Syllabus →</Link>}>
              <ul className="grid gap-2 sm:grid-cols-2">
                {syllabus.map((s) => (
                  <li key={s.id} className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-brand">{s.subject}</p>
                    <p className="text-sm font-semibold text-slate-900">{s.now?.title ?? (s.total ? "All done! 🎉" : "Plan coming soon")}</p>
                    {s.total > 0 && (
                      <div className="mt-2">
                        <Progress value={(s.completed / s.total) * 100} tone="green" />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {student && student.exams.length > 0 && (
            <SectionCard title="Upcoming exams" icon="file" action={<Link to="/exams" className="text-xs font-semibold text-brand">Date sheet →</Link>}>
              <ul className="divide-y divide-slate-100">
                {student.exams.map((p: any) => (
                  <li key={p.id}>
                    <Link to={`/exams/${p.exam_id}`} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{p.subject}</p>
                        <p className="text-xs text-slate-500">
                          {p.exam} · {p.start_time}
                          {p.room && ` · ${p.room}`}
                        </p>
                      </div>
                      <Badge tone="brand">{fmtDate(p.date, { weekday: "short", day: "numeric", month: "short" })}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {student && (
            <SectionCard title="Homework due" icon="clipboard" action={<Link to="/assignments" className="text-xs font-semibold text-brand">All assignments →</Link>}>
              {student.due.length ? (
                <ul className="divide-y divide-slate-100">
                  {student.due.map((a: any) => {
                    const overdue = a.due_at && new Date(a.due_at) < new Date();
                    return (
                      <li key={a.id}>
                        <Link to={`/assignments/${a.id}`} className="flex items-center justify-between gap-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{a.title}</p>
                            <p className="text-xs text-slate-500">{a.class_name}</p>
                          </div>
                          <Badge tone={overdue ? "red" : "amber"}>{a.due_at ? `${overdue ? "Overdue" : "Due"} ${fmtDate(a.due_at)}` : "No due date"}</Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Nothing due. Great work!</p>
              )}
            </SectionCard>
          )}

          {children && (
            <SectionCard title="My children" icon="heart">
              {children.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {children.map((c) => (
                    <div key={c.student_id} className="rounded-2xl p-4 ring-1 ring-slate-200">
                      <div className="flex items-center gap-3">
                        <Avatar name={c.name} size={40} />
                        <div>
                          <p className="font-semibold text-slate-900">
                            {c.name}
                            {c.classes?.length > 0 && <span className="ml-2 chip bg-brand-soft text-brand">{c.classes.join(", ")}</span>}
                          </p>
                          <p className="text-xs text-slate-500">
                            {c.pending} assignment(s) pending
                            {Number(c.fees_due_paise) > 0 && ` · ${inr(c.fees_due_paise)} fees due`}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="mb-1 flex justify-between text-xs text-slate-500">
                          <span>Attendance</span>
                          <span className="font-semibold">{pct100(c.attendanceRate)}</span>
                        </div>
                        <Progress value={c.attendanceRate ?? 0} tone={c.attendanceRate == null ? "brand" : c.attendanceRate >= 75 ? "green" : "amber"} />
                      </div>
                      <ChildStanding c={c} />
                      <div className="mt-3 flex gap-2">
                        <Link to={`/report-card?studentId=${c.student_id}`} className="btn-ghost btn-sm">
                          Report card
                        </Link>
                        <Link to={`/children/${c.student_id}`} className="btn-ghost btn-sm">
                          Progress
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No children linked yet" icon="heart">
                  <Link to="/children" className="text-brand underline">
                    Add your child
                  </Link>{" "}
                  to follow their progress.
                </Empty>
              )}
            </SectionCard>
          )}

          {!org && !teaching && !student && !children && !fees && !library && !transport && !hostel && (
            <Empty title="Welcome to AI Gurukul" icon="sparkles">
              Use the menu to explore courses and announcements.
            </Empty>
          )}
        </div>

        <div className="space-y-6">
          {isStudent && reward.data && <Leaderboard e={reward.data} />}

          {(teaching || student) && (
            <SectionCard title="Today's timetable" icon="clock" action={<Link to="/timetable" className="text-xs font-semibold text-brand">Week →</Link>}>
              <Schedule slots={teaching?.today ?? student?.today ?? []} empty="No periods scheduled today." />
            </SectionCard>
          )}

          <SectionCard title="Announcements" icon="megaphone" action={<Link to="/announcements" className="text-xs font-semibold text-brand">View all →</Link>}>
            {latest.length ? (
              <ul className="space-y-3">
                {latest.map((a: any) => (
                  <li key={a.id} className="rounded-xl p-3 ring-1 ring-slate-100">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {a.pinned && <Icon name="pin" size={13} className="mr-1 inline text-amber-500" />}
                        {a.title}
                      </p>
                      {!a.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand" title="Unread" />}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{a.body}</p>
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      {a.author} · {fmtDateTime(a.created_at)}
                      {a.class_name && ` · ${a.class_name}`}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No announcements yet.</p>
            )}
          </SectionCard>
        </div>
      </div>
      <CelebrationToast message={toast} onClose={dismiss} />
    </div>
  );
}
