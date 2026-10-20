import { Link } from "react-router-dom";
import { Icon, type IconName } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Progress, SectionCard, Spinner, StatCard, fmtDate, fmtDateTime, pct100, toneForPercent } from "../components/ui";
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

export function DashboardPage() {
  const { user, can, tenant } = useAuth();
  const dash = useApi<any>("/dashboard");
  const news = useApi<any>("/announcements");

  if (dash.loading && !dash.data) return <Spinner />;
  const d = dash.data ?? {};
  const org = d.organization;
  const teaching = d.teaching;
  const student = d.student;
  const children: any[] | undefined = d.children;
  const latest = (news.data?.announcements ?? []).slice(0, 4);

  const actions: { to: string; icon: IconName; label: string }[] = [];
  if (can("classes.manage")) actions.push({ to: "/attendance", icon: "checkSquare", label: "Mark attendance" }, { to: "/assignments", icon: "clipboard", label: "New assignment" });
  if (can("announcements.manage")) actions.push({ to: "/announcements", icon: "megaphone", label: "Post notice" });
  if (can("members.manage")) actions.push({ to: "/people", icon: "users", label: "Invite people" });
  if (can("tutor.use")) actions.push({ to: "/tutor", icon: "sparkles", label: "Ask AI teacher" });
  if (can("planner.self")) actions.push({ to: "/today", icon: "target", label: "My study plan" });
  if (can("reports.children")) actions.push({ to: "/report-card", icon: "file", label: "Report card" });

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand via-indigo-500 to-violet-500 p-6 text-white shadow-lift animate-fade-up md:p-8">
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute -bottom-20 right-24 h-48 w-48 rounded-full bg-amber-300/20 blur-2xl" />
        <div className="relative">
          <p className="text-sm text-white/80">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight md:text-4xl">
            {greeting()}, {user?.name.split(" ")[0]}
          </h1>
          <p className="mt-1 text-white/85">{tenant ? `Welcome back to ${tenant.name}.` : "Welcome back."}</p>
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
                          <p className="font-semibold text-slate-900">{c.name}</p>
                          <p className="text-xs text-slate-500">{c.pending} assignment(s) pending</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="mb-1 flex justify-between text-xs text-slate-500">
                          <span>Attendance</span>
                          <span className="font-semibold">{pct100(c.attendanceRate)}</span>
                        </div>
                        <Progress value={c.attendanceRate ?? 0} tone={c.attendanceRate == null ? "brand" : c.attendanceRate >= 75 ? "green" : "amber"} />
                      </div>
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

          {!org && !teaching && !student && !children && (
            <Empty title="Welcome to AI Gurukul" icon="sparkles">
              Use the menu to explore courses and announcements.
            </Empty>
          )}
        </div>

        <div className="space-y-6">
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
    </div>
  );
}
