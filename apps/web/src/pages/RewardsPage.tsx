import { useState } from "react";
import { Icon } from "../components/icons";
import { ACTIVITY_LABELS, BadgeShelf, CelebrationToast, GoalsCard, Leaderboard, LevelCard, WeekChart, useCelebrations, type Engagement } from "../components/Rewards";
import { Empty, ErrorNote, PageTitle, Spinner, fmtDateTime } from "../components/ui";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const EARN: { kind: string; key: string; extra?: string }[] = [
  { kind: "lesson", key: "lesson" },
  { kind: "quiz", key: "quiz", extra: "+ up to 15 for your score" },
  { kind: "assignment", key: "assignment" },
  { kind: "task", key: "task" },
  { kind: "attendance", key: "attendance" },
  { kind: "live", key: "live" },
  { kind: "book", key: "book" },
  { kind: "question", key: "question", extra: "up to 10 a day" },
];

export function RewardsPage() {
  const { can, info } = useAuth();
  const parent = can("reports.children") && !info?.studentProfileId;
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const me = useApi<Engagement>(parent ? (studentId ? `/engagement/me?studentId=${studentId}` : null) : "/engagement/me");
  const { news, dismiss } = useCelebrations(parent ? null : me.data);
  const e = me.data;

  return (
    <div className="space-y-5">
      <PageTitle
        title={parent ? "Rewards" : "My rewards"}
        icon="award"
        subtitle={parent ? "Your child's learning streaks, levels and badges." : "Learn every day to level up, keep your streak and collect badges!"}
        action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />}
      />
      <ErrorNote message={me.error} />
      {parent && !students.loading && !students.options.length && <Empty title="No children linked" icon="heart">Link your child from My children to see their rewards.</Empty>}
      {me.loading && !e ? (
        <Spinner />
      ) : (
        e && (
          <>
            <LevelCard e={e} />
            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                <BadgeShelf e={e} />
                <WeekChart e={e} />
              </div>
              <div className="space-y-5">
                {!parent && <GoalsCard e={e} />}
                <Leaderboard e={e} />
              </div>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70">
                <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
                  <Icon name="gift" size={18} className="text-pink-500" /> How to earn XP
                </h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {EARN.map((x) => (
                    <li key={x.kind} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-brand shadow-sm">
                        <Icon name={ACTIVITY_LABELS[x.kind].icon} size={17} />
                      </span>
                      <span className="flex-1 text-sm">
                        <span className="block font-semibold text-slate-800">{ACTIVITY_LABELS[x.kind].label}</span>
                        {x.extra && <span className="block text-xs text-slate-500">{x.extra}</span>}
                      </span>
                      <span className="chip bg-amber-100 font-bold text-amber-700">+{e.rules[x.key]}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70">
                <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
                  <Icon name="clock" size={18} className="text-sky-500" /> Recent wins
                </h2>
                {e.recent.length ? (
                  <ul className="divide-y divide-slate-100">
                    {e.recent.map((r, i) => (
                      <li key={i} className="flex items-center gap-3 py-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                          <Icon name={ACTIVITY_LABELS[r.kind]?.icon ?? "star"} size={16} />
                        </span>
                        <span className="flex-1 text-sm">
                          <span className="block font-medium text-slate-800">{ACTIVITY_LABELS[r.kind]?.label ?? r.kind}</span>
                          <span className="block text-xs text-slate-500">{fmtDateTime(r.at)}</span>
                        </span>
                        <span className="text-sm font-bold text-emerald-600">+{r.xp}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">Nothing yet — finish a lesson or ask the AI teacher a question to earn your first XP!</p>
                )}
              </section>
            </div>
          </>
        )
      )}
      <CelebrationToast message={news} onClose={dismiss} />
    </div>
  );
}
