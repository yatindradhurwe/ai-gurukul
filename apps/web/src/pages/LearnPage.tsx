import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Spinner } from "../components/ui";

export function LearnPage() {
  const chapters = useApi("/curriculum/chapters");
  const [open, setOpen] = useState<string | null>(null);
  const topics = useApi(open ? `/curriculum/topics?chapterId=${open}` : null);

  if (chapters.loading) return <Spinner />;
  return (
    <div>
      <PageTitle title="Courses" icon="book" subtitle="Your syllabus, chapter by chapter." />
      <ErrorNote message={chapters.error} />
      <div className="space-y-3">
        {chapters.data?.chapters.map((c: any) => (
          <div key={c.id} className="card p-0">
            <button className="flex w-full items-center justify-between p-5 text-left" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              <div>
                <p className="text-xs text-slate-500">
                  {c.subject} · Chapter {c.sequence}
                </p>
                <p className="font-medium">{c.title}</p>
              </div>
              <span className="text-sm text-slate-400">
                {c.topic_count} topics {open === c.id ? "▴" : "▾"}
              </span>
            </button>
            {open === c.id && (
              <div className="border-t border-slate-100 px-5 pb-4">
                {topics.loading ? (
                  <Spinner />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {topics.data?.topics.map((t: any) => (
                      <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                        <div>
                          <p className="text-sm font-medium">{t.title}</p>
                          <p className="text-xs text-slate-500">
                            ~{t.estimated_minutes} min · difficulty {t.difficulty}/5
                          </p>
                        </div>
                        {t.lessons?.[0] && (
                          <Link to={`/learn/lessons/${t.lessons[0].id}`} className="btn-ghost">
                            Open lesson
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
