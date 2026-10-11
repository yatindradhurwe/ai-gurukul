import { Link } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Progress, Spinner, pct } from "../components/ui";

export function ResultsPage() {
  const progress = useApi("/academic/syllabus-progress");
  const recs = useApi("/academic/recommendations");
  const tests = useApi("/assessments");

  if (progress.loading) return <Spinner />;
  return (
    <div className="space-y-6">
      <PageTitle title="Results" subtitle="Syllabus coverage, mastery and what to work on next." />
      <ErrorNote message={progress.error} />

      <section className="card">
        <h2 className="label">Tests</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {tests.data?.assessments.map((a: any) => (
            <li key={a.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-slate-500">
                  {a.question_count} questions · {a.max_marks} marks
                </p>
              </div>
              <Link to={`/results/quiz/${a.id}`} className="btn-ghost">
                Start
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {recs.data?.items.length > 0 && (
        <section className="card">
          <h2 className="label">Focus areas</h2>
          <ul className="mt-2 space-y-3">
            {recs.data.items.map((r: any) => (
              <li key={r.topicId} className="text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{r.topic}</p>
                  <span className="text-xs text-slate-500">{pct(r.mastery)}</span>
                </div>
                <p className="text-slate-500">{r.reason}</p>
                {r.lessonId && (
                  <Link to={`/learn/lessons/${r.lessonId}`} className="text-xs text-brand underline">
                    Open lesson
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="label">Syllabus progress</h2>
        <p className="mt-1 text-sm text-slate-500">
          {progress.data?.coveredTopics} of {progress.data?.totalTopics} topics covered
        </p>
        <ul className="mt-4 space-y-4">
          {progress.data?.chapters.map((c: any) => (
            <li key={c.chapterId}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{c.chapter}</span>
                <span className="text-slate-500">{c.averageMastery == null ? "not assessed" : `avg mastery ${pct(c.averageMastery)}`}</span>
              </div>
              <Progress value={c.averageMastery == null ? 0 : c.averageMastery * 100} tone={(c.averageMastery ?? 0) >= 0.8 ? "green" : "amber"} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
