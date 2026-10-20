import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { ErrorNote, Progress, Spinner, TaskChip } from "../components/ui";

export function StudentHome() {
  const { user } = useAuth();
  const dash = useApi("/academic/dashboard");
  const cont = useApi("/courses/continue");

  async function toggle(task: any) {
    await api(`/academic/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "completed" ? "pending" : "completed" } });
    dash.reload();
  }

  if (dash.loading && !dash.data) return <Spinner />;
  const d = dash.data;
  const done = d?.todayTasks.filter((t: any) => t.status === "completed").length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-900">Namaste, {user?.name.split(" ")[0]} 👋</h1>
        <p className="text-sm text-slate-500">Here's your day.</p>
      </div>
      <ErrorNote message={dash.error} />

      <div className="grid gap-4 md:grid-cols-2">
        {/* 1. Continue learning */}
        <section className="card">
          <h2 className="label">Continue learning</h2>
          {cont.data?.lesson ? (
            <>
              <p className="mt-2 text-lg font-medium">{cont.data.lesson.title}</p>
              <p className="text-sm text-slate-500">{cont.data.lesson.topic}</p>
              <Link to={`/learn/lessons/${cont.data.lesson.id}`} className="btn mt-4">
                ▶ Resume lesson
              </Link>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No lessons yet.</p>
          )}
        </section>

        {/* 4. Next exam */}
        <section className="card">
          <h2 className="label">Next exam</h2>
          {d?.nextExam ? (
            <>
              <div className="mt-2 flex items-baseline justify-between">
                <p className="text-lg font-medium">{d.nextExam.title}</p>
                <p className="text-2xl font-semibold text-brand">{d.nextExam.daysLeft}d</p>
              </div>
              <p className="text-sm text-slate-500">
                {d.nextExam.subject} · {d.nextExam.exam_date}
              </p>
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs text-slate-500">
                  <span>Readiness</span>
                  <span>{d.nextExam.readiness}%</span>
                </div>
                <Progress value={d.nextExam.readiness} tone={d.nextExam.readiness >= 70 ? "green" : "amber"} />
                <p className="mt-2 text-xs text-slate-500">{d.nextExam.readinessExplanation}</p>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              No exam scheduled. <Link to="/plan" className="text-brand underline">Add one</Link> to get a study plan.
            </p>
          )}
        </section>
      </div>

      {/* 2. Today's plan */}
      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="label">Today's study plan</h2>
          {d?.todayTasks.length > 0 && (
            <span className="text-xs text-slate-500">
              {done}/{d.todayTasks.length} done
            </span>
          )}
        </div>
        {d?.overdueTasks > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            {d.overdueTasks} earlier task(s) are pending. <Link to="/plan" className="underline">Recalculate your plan</Link> so nothing piles up.
          </p>
        )}
        {d?.todayTasks.length ? (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.todayTasks.map((t: any) => (
              <li key={t.id} className="flex items-center gap-3 py-3">
                <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--brand))]" checked={t.status === "completed"} onChange={() => toggle(t)} aria-label={`Mark ${t.title} done`} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm ${t.status === "completed" ? "text-slate-400 line-through" : ""}`}>{t.title}</p>
                </div>
                <TaskChip type={t.task_type} />
                <span className="w-14 text-right text-xs text-slate-500">{t.duration_minutes} min</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-500">Nothing scheduled today{d?.activePlan ? " — enjoy a break or revise." : "."}</p>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 3. Ask AI Teacher */}
        <section className="card bg-gradient-to-br from-brand to-indigo-400 text-white ring-0">
          <h2 className="text-xs font-medium uppercase tracking-wide text-white/80">Stuck on something?</h2>
          <p className="mt-2 text-lg font-medium">Ask your AI teacher</p>
          <p className="text-sm text-white/80">Answers come from your approved course material, with sources.</p>
          <Link to="/tutor" className="mt-4 inline-flex rounded-xl bg-surface px-4 py-2 text-sm font-medium text-brand">
            Ask a question →
          </Link>
        </section>

        <section className="card">
          <h2 className="label">Recommended for you</h2>
          {d?.recommendations.length ? (
            <ul className="mt-2 space-y-3">
              {d.recommendations.map((r: any) => (
                <li key={r.topicId} className="text-sm">
                  <p className="font-medium">{r.topic}</p>
                  <p className="text-slate-500">{r.reason}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              Take the <Link to="/results" className="text-brand underline">diagnostic quiz</Link> to get personalised recommendations.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
