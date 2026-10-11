import { Link, useParams } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Spinner, pct } from "../components/ui";

export function ChildReportPage() {
  const { studentId } = useParams();
  const report = useApi(`/parents/children/${studentId}/report`);
  const progress = useApi(`/academic/syllabus-progress?studentId=${studentId}`);

  if (report.loading) return <Spinner />;
  if (report.error) return <ErrorNote message={report.error} />;
  const r = report.data;
  return (
    <div className="space-y-6">
      <Link to="/children" className="text-sm text-slate-500">
        ← Children
      </Link>
      <PageTitle title={`${r.student.name}'s weekly report`} subtitle={`${r.period.from} to ${r.period.to}`} />
      <div className="grid gap-4 md:grid-cols-4">
        <Tile label="Tasks completed" value={`${r.studyTasks.completed}/${r.studyTasks.planned}`} />
        <Tile label="Minutes studied" value={r.studyTasks.minutes_studied} />
        <Tile label="Topics mastered" value={`${r.mastery.topicsMastered}/${r.mastery.topicsAssessed}`} />
        <Tile label="Average mastery" value={pct(r.mastery.averageMeasured)} />
      </div>
      {r.activePlan && (
        <section className="card text-sm">
          <h2 className="label">Study plan</h2>
          <p className="mt-2">
            Version {r.activePlan.version} · {r.activePlan.feasible ? "fits the available time" : `about ${r.activePlan.gap_minutes} minutes short — consider discussing priorities`}
          </p>
          {r.activePlan.last_change && <p className="text-slate-500">Last change: {r.activePlan.last_change}</p>}
        </section>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="label">Upcoming exams</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {r.upcomingExams.map((e: any, i: number) => (
              <li key={i} className="flex justify-between">
                <span>{e.title}</span>
                <span className="text-slate-500">{e.exam_date}</span>
              </li>
            ))}
            {!r.upcomingExams.length && <li className="text-slate-500">None scheduled.</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="label">Recent tests</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {r.recentAssessments.map((a: any, i: number) => (
              <li key={i} className="flex justify-between">
                <span>{a.title}</span>
                <span className="text-slate-500">
                  {a.score}/{a.max_score}
                </span>
              </li>
            ))}
            {!r.recentAssessments.length && <li className="text-slate-500">No tests yet.</li>}
          </ul>
        </section>
      </div>
      {progress.data && (
        <section className="card">
          <h2 className="label">Syllabus</h2>
          <p className="mt-1 text-sm text-slate-500">
            {progress.data.coveredTopics} of {progress.data.totalTopics} topics covered
          </p>
        </section>
      )}
    </div>
  );
}

const Tile = ({ label, value }: { label: string; value: string | number }) => (
  <div className="card text-center">
    <p className="text-2xl font-semibold">{value}</p>
    <p className="text-xs text-slate-500">{label}</p>
  </div>
);
