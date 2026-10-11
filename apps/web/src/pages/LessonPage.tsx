import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { ErrorNote, InfoNote, Spinner } from "../components/ui";

interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * Lesson view. The avatar video is optional: when it is unavailable (not
 * rendered, provider failure, quota) the lesson is read as text, and captions
 * can be "played" with the browser's speech synthesis as a lightweight voice.
 */
export function LessonPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lesson = useApi(`/courses/lessons/${id}`);
  const playback = useApi(`/avatar/lessons/${id}`);
  const [activeCue, setActiveCue] = useState(-1);
  const [speaking, setSpeaking] = useState(false);
  const [completed, setCompleted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cues: Cue[] = playback.data?.captions ?? [];

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  function speak() {
    if (!("speechSynthesis" in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      setActiveCue(-1);
      return;
    }
    setSpeaking(true);
    cues.forEach((cue, i) => {
      const u = new SpeechSynthesisUtterance(cue.text);
      u.lang = "en-IN";
      u.onstart = () => setActiveCue(i);
      if (i === cues.length - 1) u.onend = () => (setSpeaking(false), setActiveCue(-1));
      window.speechSynthesis.speak(u);
    });
  }

  async function askTutor() {
    const r = await api("/ai/sessions", { body: { lessonId: id } });
    navigate(`/tutor?session=${r.session.id}`);
  }

  async function markComplete() {
    await api(`/courses/lessons/${id}/complete`, { method: "POST" });
    setCompleted(true);
  }

  if (lesson.loading) return <Spinner />;
  if (lesson.error) return <ErrorNote message={lesson.error} />;
  const l = lesson.data.lesson;

  return (
    <div className="space-y-5">
      <Link to="/learn" className="text-sm text-slate-500 hover:text-slate-800">
        ← {l.subject} · {l.chapter}
      </Link>
      <h1 className="text-2xl font-semibold">{l.title}</h1>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <div className="card p-3">
            {playback.data?.mode === "avatar" ? (
              <video
                ref={videoRef}
                src={playback.data.videoUrl}
                controls
                className="aspect-video w-full rounded-xl bg-slate-900"
                onTimeUpdate={(e) => setActiveCue(cues.findIndex((c) => e.currentTarget.currentTime >= c.start && e.currentTarget.currentTime < c.end))}
              />
            ) : (
              <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl bg-gradient-to-br from-indigo-100 to-amber-50 text-center">
                <div className={`mb-2 text-5xl ${speaking ? "animate-pulse" : ""}`}>🧑‍🏫</div>
                <button className="btn" onClick={speak}>
                  {speaking ? "⏹ Stop" : "🔊 Listen to this lesson"}
                </button>
              </div>
            )}
            <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm" aria-live="polite">
              {activeCue >= 0 ? cues[activeCue]?.text : <span className="text-slate-400">Captions appear here during playback.</span>}
            </div>
          </div>
          {playback.data?.mode === "text" && playback.data.reason !== "avatar_not_rendered" && (
            <InfoNote>The video lesson isn't available right now ({playback.data.reason.replace(/_/g, " ")}). You can read or listen to it instead.</InfoNote>
          )}
          <div className="flex flex-wrap gap-2">
            {can("tutor.use") && (
              <button className="btn-ghost" onClick={askTutor}>
                💬 Ask the AI teacher about this
              </button>
            )}
            {can("assessments.take") && (
              <button className="btn-ghost" onClick={markComplete} disabled={completed}>
                {completed ? "✓ Completed" : "Mark as complete"}
              </button>
            )}
          </div>
        </div>
        <article className="card space-y-4 leading-relaxed lg:col-span-3">
          {l.content.split(/\n\s*\n/).map((p: string, i: number) => (
            <p key={i}>{p}</p>
          ))}
        </article>
      </div>
    </div>
  );
}
