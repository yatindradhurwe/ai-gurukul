import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { celebrate } from "../lib/celebrate";
import { Icon, type IconName } from "./icons";
import { Avatar } from "./ui";

export interface Engagement {
  student: { id: string; name: string };
  xp: number;
  todayXp: number;
  weekXp: number;
  level: { number: number; name: string; floorXp: number; nextXp: number; progress: number };
  streak: { current: number; best: number };
  goals: { id: string; label: string; value: number; target: number }[];
  badges: { id: string; name: string; description: string; icon: string; target: number; value: number; earned: boolean }[];
  week: { date: string; xp: number }[];
  recent: { at: string; kind: string; xp: number }[];
  leaderboard: { studentId: string; name: string; xp: number; me: boolean; rank: number }[];
  rules: Record<string, number>;
}

const BADGE_COLORS = ["from-amber-300 to-orange-500", "from-emerald-300 to-teal-500", "from-sky-300 to-indigo-500", "from-pink-300 to-rose-500", "from-violet-300 to-purple-500", "from-lime-300 to-green-500"];

export const ACTIVITY_LABELS: Record<string, { label: string; icon: IconName }> = {
  lesson: { label: "Finished a lesson", icon: "book" },
  quiz: { label: "Completed a quiz", icon: "target" },
  assignment: { label: "Submitted homework", icon: "clipboard" },
  task: { label: "Finished a study task", icon: "calendar" },
  question: { label: "Asked the AI teacher", icon: "sparkles" },
  doubt: { label: "Asked a doubt in class", icon: "video" },
  attendance: { label: "Came to school", icon: "checkSquare" },
  book: { label: "Returned a library book", icon: "book" },
  live: { label: "Joined a live class", icon: "video" },
};

/** Remember what the student had last time; celebrate new badges and level-ups. */
export function useCelebrations(e: Engagement | null) {
  const [news, setNews] = useState<string | null>(null);
  useEffect(() => {
    if (!e) return;
    const key = `ag.rewards.${e.student.id}`;
    let prev: { level: number; badges: string[] } | null = null;
    try {
      prev = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      prev = null;
    }
    const earned = e.badges.filter((b) => b.earned).map((b) => b.id);
    if (prev) {
      const fresh = e.badges.filter((b) => b.earned && !prev!.badges.includes(b.id));
      if (e.level.number > prev.level) setNews(`Level up! You're now level ${e.level.number} — ${e.level.name}.`);
      else if (fresh.length) setNews(`New badge: ${fresh.map((b) => b.name).join(", ")}!`);
      if (e.level.number > prev.level || fresh.length) celebrate();
    }
    try {
      localStorage.setItem(key, JSON.stringify({ level: e.level.number, badges: earned }));
    } catch {
      /* storage unavailable: no celebration memory */
    }
  }, [e]);
  return { news, dismiss: () => setNews(null) };
}

export function CelebrationToast({ message, onClose }: { message: string | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <div className="fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-md items-center gap-3 rounded-3xl bg-gradient-to-r from-amber-400 via-orange-400 to-pink-500 p-4 text-white shadow-lift animate-pop">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/25 animate-wiggle">
        <Icon name="trophy" size={24} />
      </span>
      <p className="flex-1 font-semibold">{message}</p>
      <button className="rounded-xl p-1 text-white/80 hover:bg-white/20" onClick={onClose} aria-label="Close">
        <Icon name="x" />
      </button>
    </div>
  );
}

export function LevelCard({ e, compact }: { e: Engagement; compact?: boolean }) {
  const toNext = e.level.nextXp - e.xp;
  return (
    <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 p-6 text-white shadow-lift animate-fade-up">
      <div className="absolute -right-10 -top-10 h-44 w-44 rounded-full bg-white/15 blur-xl" />
      <div className="absolute -bottom-16 left-1/3 h-40 w-40 rounded-full bg-amber-300/30 blur-2xl" />
      <div className="relative flex flex-wrap items-center gap-5">
        <div className="relative animate-float">
          <div className="flex h-20 w-20 items-center justify-center rounded-[1.6rem] bg-white/20 ring-4 ring-white/30 backdrop-blur">
            <Icon name="star" size={40} className="fill-amber-300 text-amber-200" />
          </div>
          <span className="absolute -bottom-2 -right-2 flex h-9 w-9 items-center justify-center rounded-full bg-amber-400 text-sm font-black text-amber-950 ring-4 ring-violet-500">{e.level.number}</span>
        </div>
        <div className="min-w-[12rem] flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/70">Level {e.level.number}</p>
          <p className="font-display text-3xl font-semibold">{e.level.name}</p>
          <div className="mt-3 h-3.5 overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-yellow-200 transition-all duration-700" style={{ width: `${Math.max(4, e.level.progress)}%` }} />
          </div>
          <p className="mt-1.5 text-sm text-white/85">
            <b>{e.xp} XP</b> · {toNext} XP to level {e.level.number + 1}
          </p>
        </div>
        <div className="flex gap-3">
          <div className="rounded-3xl bg-white/15 px-4 py-3 text-center backdrop-blur">
            <Icon name="flame" size={26} className={`mx-auto ${e.streak.current ? "fill-orange-300 text-orange-200" : "text-white/60"}`} />
            <p className="mt-1 text-2xl font-black leading-none">{e.streak.current}</p>
            <p className="text-[11px] font-semibold text-white/75">day streak</p>
          </div>
          {!compact && (
            <div className="rounded-3xl bg-white/15 px-4 py-3 text-center backdrop-blur">
              <Icon name="trending" size={26} className="mx-auto text-emerald-200" />
              <p className="mt-1 text-2xl font-black leading-none">{e.weekXp}</p>
              <p className="text-[11px] font-semibold text-white/75">XP this week</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function GoalsCard({ e }: { e: Engagement }) {
  const done = e.goals.filter((g) => g.value >= g.target).length;
  const links: Record<string, string> = { xp: "/today", learn: "/learn", ask: "/tutor" };
  return (
    <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Icon name="target" size={18} className="text-rose-500" /> Today's quests
        </h2>
        <span className={`chip ${done === e.goals.length ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
          {done}/{e.goals.length} done
        </span>
      </div>
      <ul className="space-y-2.5">
        {e.goals.map((g) => {
          const ok = g.value >= g.target;
          return (
            <li key={g.id}>
              <Link to={links[g.id] ?? "/"} className={`flex items-center gap-3 rounded-2xl p-3 transition ${ok ? "bg-emerald-50" : "bg-slate-50 hover:bg-amber-50"}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ok ? "bg-emerald-500 text-white animate-pop" : "bg-white text-slate-400 ring-1 ring-slate-200"}`}>
                  <Icon name={ok ? "check" : "star"} size={18} />
                </span>
                <span className="flex-1">
                  <span className={`block text-sm font-semibold ${ok ? "text-emerald-800" : "text-slate-800"}`}>{g.label}</span>
                  {g.target > 1 && (
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <span className="block h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" style={{ width: `${(g.value / g.target) * 100}%` }} />
                    </span>
                  )}
                </span>
                {!ok && <Icon name="chevronRight" size={16} className="text-slate-400" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BadgeShelf({ e, limit }: { e: Engagement; limit?: number }) {
  const sorted = [...e.badges].sort((a, b) => Number(b.earned) - Number(a.earned) || b.value / b.target - a.value / a.target);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return (
    <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Icon name="award" size={18} className="text-amber-500" /> Badges
          <span className="chip bg-amber-100 text-amber-700">
            {e.badges.filter((b) => b.earned).length}/{e.badges.length}
          </span>
        </h2>
        {limit && (
          <Link to="/rewards" className="text-xs font-semibold text-brand">
            See all →
          </Link>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {shown.map((b, i) => (
          <div key={b.id} className="group text-center" title={`${b.name}: ${b.description}`}>
            <div
              className={`mx-auto flex h-16 w-16 items-center justify-center rounded-[1.4rem] shadow-md transition group-hover:-translate-y-1 ${
                b.earned ? `bg-gradient-to-br ${BADGE_COLORS[i % BADGE_COLORS.length]} text-white` : "bg-slate-100 text-slate-300"
              }`}
            >
              <Icon name={b.icon as IconName} size={28} />
            </div>
            <p className={`mt-2 text-xs font-bold ${b.earned ? "text-slate-900" : "text-slate-400"}`}>{b.name}</p>
            {!b.earned && (
              <div className="mx-auto mt-1 h-1.5 w-14 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${(b.value / b.target) * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function Leaderboard({ e }: { e: Engagement }) {
  const medals = ["bg-amber-400 text-amber-950", "bg-slate-300 text-slate-800", "bg-orange-300 text-orange-950"];
  return (
    <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
        <Icon name="trophy" size={18} className="text-amber-500" /> Class top learners
      </h2>
      <p className="mb-3 text-xs text-slate-500">XP earned in the last 7 days</p>
      {e.leaderboard.length <= 1 ? (
        <p className="text-sm text-slate-500">Join a class to see how your classmates are doing.</p>
      ) : (
        <ol className="space-y-1.5">
          {e.leaderboard.map((r) => (
            <li key={r.studentId} className={`flex items-center gap-3 rounded-2xl px-3 py-2 ${r.me ? "bg-brand-soft ring-1 ring-brand/30" : ""}`}>
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${medals[r.rank - 1] ?? "bg-slate-100 text-slate-600"}`}>{r.rank}</span>
              <Avatar name={r.me ? e.student.name : r.name} size={30} />
              <span className={`flex-1 text-sm ${r.me ? "font-bold text-brand" : "font-medium text-slate-800"}`}>{r.name}</span>
              <span className="text-sm font-bold text-slate-900">{r.xp} XP</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WeekChart({ e }: { e: Engagement }) {
  const max = Math.max(50, ...e.week.map((d) => d.xp));
  const today = e.week[e.week.length - 1]?.date;
  return (
    <section className="rounded-[2rem] bg-white p-5 shadow-soft ring-1 ring-slate-200/70 animate-fade-up">
      <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900">
        <Icon name="chart" size={18} className="text-sky-500" /> This week
      </h2>
      <div className="flex h-36 items-end gap-2.5">
        {e.week.map((d) => (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
            <span className="text-[11px] font-bold text-slate-600">{d.xp || ""}</span>
            <div className="flex h-24 w-full items-end overflow-hidden rounded-xl bg-slate-100">
              <div
                className={`w-full rounded-xl transition-all duration-700 ${d.date === today ? "bg-gradient-to-t from-fuchsia-500 to-violet-400" : "bg-gradient-to-t from-sky-400 to-indigo-300"}`}
                style={{ height: `${(d.xp / max) * 100}%` }}
              />
            </div>
            <span className={`text-[11px] font-semibold ${d.date === today ? "text-brand" : "text-slate-500"}`}>{new Date(`${d.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" })}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
