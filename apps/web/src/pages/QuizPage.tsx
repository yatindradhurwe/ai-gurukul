import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { ErrorNote, Spinner } from "../components/ui";

export function QuizPage() {
  const { id } = useParams();
  const [quiz, setQuiz] = useState<any>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setQuiz(await api(`/assessments/${id}`));
        setAttemptId((await api(`/assessments/${id}/attempts`, { method: "POST" })).attempt.id);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id]);

  async function submit() {
    try {
      const payload = quiz.questions.map((q: any) => ({ questionId: q.id, answer: answers[q.id] ?? {} }));
      const r = await api(`/attempts/${attemptId}/submit`, { body: { answers: payload } });
      setResult(r);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <ErrorNote message={error} />;
  if (!quiz) return <Spinner />;
  return (
    <div className="space-y-4">
      <Link to="/results" className="text-sm text-slate-500">
        ← Results
      </Link>
      <h1 className="text-2xl font-semibold">{quiz.assessment.title}</h1>
      {result && (
        <div className="card bg-emerald-50 ring-emerald-200">
          <p className="text-lg font-semibold">
            Score: {result.score} / {quiz.assessment.max_marks}
          </p>
          {result.pendingReview > 0 && <p className="text-sm">{result.pendingReview} answer(s) will be marked by your teacher.</p>}
          <p className="mt-1 text-sm text-slate-600">Your topic mastery and recommendations have been updated.</p>
          <Link to="/results" className="btn mt-3">
            See recommendations
          </Link>
        </div>
      )}
      {quiz.questions.map((q: any, i: number) => (
        <fieldset key={q.id} className="card" disabled={!!result}>
          <legend className="sr-only">Question {i + 1}</legend>
          <p className="mb-3 font-medium">
            {i + 1}. {q.prompt} <span className="text-xs font-normal text-slate-400">({q.marks} mark{q.marks > 1 ? "s" : ""})</span>
          </p>
          {q.type === "mcq" ? (
            <div className="space-y-2">
              {q.options.map((o: string, idx: number) => (
                <label key={idx} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ring-1 ${answers[q.id]?.choice === idx ? "bg-brand-soft ring-brand" : "ring-slate-200"}`}>
                  <input type="radio" name={q.id} checked={answers[q.id]?.choice === idx} onChange={() => setAnswers({ ...answers, [q.id]: { choice: idx } })} />
                  {o}
                </label>
              ))}
            </div>
          ) : q.type === "numeric" ? (
            <input className="input max-w-xs" type="number" step="any" onChange={(e) => setAnswers({ ...answers, [q.id]: { value: Number(e.target.value) } })} />
          ) : (
            <textarea className="input" rows={q.type === "descriptive" ? 5 : 1} onChange={(e) => setAnswers({ ...answers, [q.id]: { text: e.target.value } })} />
          )}
        </fieldset>
      ))}
      {!result && (
        <button className="btn" onClick={submit} disabled={!attemptId}>
          Submit answers
        </button>
      )}
    </div>
  );
}
