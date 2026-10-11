import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { AvatarFace } from "../components/AvatarFace";
import { ErrorNote, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { AvatarVoice, listen, recognitionSupported, type AvatarState, type MouthShape } from "../lib/avatarVoice";
import { connectLive, type LiveEvent } from "../lib/liveStream";

/** End with exactly one punctuation mark. */
const sentence = (t: string) => (/[.!?।]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
/** Drop citation markers and markdown bullets before the avatar reads text aloud. */
const forSpeech = (t: string) => t.replace(/\[S\d+\]/g, "").replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, " ").trim();

interface Segment {
  index: number;
  total: number;
  title: string;
  text: string;
}

interface Doubt {
  id: string;
  studentName: string;
  question: string;
  answer: string | null;
  status: "answered" | "escalated" | "resolved" | "private";
  sourceRefs?: { ref: string; title: string; excerpt: string }[];
  mine?: boolean;
}

/**
 * Live AI classroom. The avatar teaches the lesson segment by segment; any
 * student can ask a doubt by voice or text and the avatar answers it out loud
 * for the whole class, then returns to the lesson. The teacher can pause,
 * speak through the avatar, answer escalated doubts and end the class.
 */
export function ClassroomPage() {
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"teacher" | "student">("student");
  const [session, setSession] = useState<any>(null);
  const [current, setCurrent] = useState<Segment | null>(null);
  const [doubts, setDoubts] = useState<Doubt[]>([]);
  const [feed, setFeed] = useState<{ id: number; text: string }[]>([]);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [joined, setJoined] = useState(false);
  const [shape, setShape] = useState<MouthShape>("rest");
  const [avState, setAvState] = useState<AvatarState>("idle");
  const [caption, setCaption] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "reconnecting" | "polling">("connecting");
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [listening, setListening] = useState(false);
  const [attendance, setAttendance] = useState<any[]>([]);

  const voiceRef = useRef<AvatarVoice | null>(null);
  const currentRef = useRef<Segment | null>(null);
  const sessionRef = useRef<any>(null);
  const joinedRef = useRef(false);
  const roleRef = useRef<"teacher" | "student">("student");
  const stopListenRef = useRef<(() => void) | null>(null);

  currentRef.current = current;
  sessionRef.current = session;
  joinedRef.current = joined;
  roleRef.current = role;

  const teaching = () => sessionRef.current?.status === "live" && sessionRef.current?.mode === "teaching";

  /** Ask the server to move on once this client has finished speaking the segment. */
  const requestAdvance = useCallback(
    (index: number, attempt = 0) => {
      const delay = roleRef.current === "teacher" ? 300 : 800 + Math.random() * 1500;
      window.setTimeout(async () => {
        if (currentRef.current?.index !== index || !teaching()) return;
        try {
          await api(`/live/sessions/${id}/advance`, { body: { expectedSegment: index, manual: false } });
        } catch (e) {
          if (e instanceof ApiError && e.code === "too_early" && attempt < 4) requestAdvance(index, attempt + 1);
        }
      }, delay + attempt * 2500);
    },
    [id],
  );

  const teachSegment = useCallback(
    async (seg: Segment | null) => {
      const voice = voiceRef.current;
      if (!seg || !voice || !joinedRef.current || !teaching()) return;
      // Never cut off an answer; a newer segment replaces an older one.
      const finished = await voice.speak({ text: seg.text, kind: "segment" }, { interrupt: voice.speakingKind !== "answer" && voice.speakingKind !== "teacher" });
      if (finished && currentRef.current?.index === seg.index) requestAdvance(seg.index);
    },
    [requestAdvance],
  );

  /** Answers and teacher messages interrupt the lesson, then the current part is replayed. */
  const speakInterruption = useCallback(
    async (text: string, kind: "answer" | "teacher") => {
      const voice = voiceRef.current;
      if (!voice || !joinedRef.current) return;
      const finished = await voice.speak({ text, kind }, { interrupt: voice.speakingKind === "segment" });
      if (finished && voice.speakingKind === null && teaching()) teachSegment(currentRef.current);
    },
    [teachSegment],
  );

  const upsertDoubt = (d: Doubt) => setDoubts((all) => (all.some((x) => x.id === d.id) ? all.map((x) => (x.id === d.id ? { ...x, ...d } : x)) : [...all, d]));

  const handleEvent = useCallback(
    (e: LiveEvent) => {
      const p = e.payload;
      switch (e.type) {
        case "session.started":
          setSession((s: any) => ({ ...s, status: "live", mode: "teaching" }));
          sessionRef.current = { ...sessionRef.current, status: "live", mode: "teaching" };
          break;
        case "segment":
          setCurrent(p);
          currentRef.current = p;
          teachSegment(p);
          break;
        case "doubt.answered":
        case "doubt.escalated":
          upsertDoubt({ id: p.questionId, studentName: p.studentName, question: p.question, answer: p.answer, status: e.type === "doubt.answered" ? "answered" : "escalated", sourceRefs: p.sourceRefs });
          setAvState((s) => (s === "thinking" ? "idle" : s));
          speakInterruption(`${p.studentName} asked: ${sentence(p.question)} ${forSpeech(p.answer)}`, "answer");
          break;
        case "doubt.resolved":
          upsertDoubt({ id: p.questionId, studentName: p.studentName, question: p.question, answer: p.answer, status: "resolved" });
          speakInterruption(`Your teacher answered ${p.studentName}'s question. ${forSpeech(p.answer)}`, "answer");
          break;
        case "doubt.private":
          upsertDoubt({ id: p.questionId, studentName: "You", question: p.question, answer: p.answer, status: "private", mine: true });
          setAvState((s) => (s === "thinking" ? "idle" : s));
          break;
        case "teacher.message":
          setFeed((f) => [...f, { id: e.id, text: `${p.teacherName}: ${p.text}` }]);
          speakInterruption(p.text, "teacher");
          break;
        case "safety.alert":
          setAlerts((a) => [...a, `Safety alert: ${p.studentName} sent a sensitive message (${p.flags.join(", ")}). Please follow up privately.`]);
          break;
        case "session.paused":
          sessionRef.current = { ...sessionRef.current, mode: "paused" };
          setSession((s: any) => ({ ...s, mode: "paused" }));
          voiceRef.current?.stop();
          break;
        case "session.resumed":
          sessionRef.current = { ...sessionRef.current, mode: "teaching" };
          setSession((s: any) => ({ ...s, mode: "teaching" }));
          setCurrent(p);
          currentRef.current = p;
          teachSegment(p);
          break;
        case "lesson.completed":
          sessionRef.current = { ...sessionRef.current, mode: "qa" };
          setSession((s: any) => ({ ...s, mode: "qa" }));
          break;
        case "session.ended":
          sessionRef.current = { ...sessionRef.current, status: "ended" };
          setSession((s: any) => ({ ...s, status: "ended" }));
          voiceRef.current?.stop();
          break;
      }
    },
    [teachSegment, speakInterruption],
  );

  useEffect(() => {
    let disconnect = () => {};
    (async () => {
      try {
        const st = await api(`/live/sessions/${id}`);
        setRole(st.role);
        setSession(st.session);
        setCurrent(st.current);
        setDoubts(
          st.questions.map((q: any) => ({ id: q.id, studentName: q.mine ? "You" : q.student_name, question: q.content, answer: q.answer, status: q.status, sourceRefs: q.source_refs, mine: q.mine })),
        );
        disconnect = connectLive(id!, st.lastEventId, handleEvent, setStreamStatus);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      disconnect();
      voiceRef.current?.stop();
      stopListenRef.current?.();
    };
  }, [id, handleEvent]);

  // Teacher: refresh attendance while the class is live.
  useEffect(() => {
    if (role !== "teacher" || session?.status !== "live") return;
    const load = () => api(`/live/sessions/${id}/attendance`).then((r) => setAttendance(r.attendance)).catch(() => {});
    load();
    const t = window.setInterval(load, 15000);
    return () => clearInterval(t);
  }, [role, session?.status, id]);

  function join() {
    const voice = new AvatarVoice(session?.language ?? "en", { onShape: setShape, onState: setAvState, onCaption: setCaption });
    voice.muted = muted;
    voiceRef.current = voice;
    joinedRef.current = true;
    setJoined(true);
    // The click is the user gesture browsers require before audio can play.
    if (teaching()) teachSegment(currentRef.current);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    if (voiceRef.current) voiceRef.current.muted = next;
  }

  async function ask(content: string, inputMode: "text" | "voice") {
    if (!content.trim()) return;
    setAsking(true);
    setError(null);
    setAvState("thinking");
    try {
      await api(`/live/sessions/${id}/questions`, { body: { content, inputMode } });
      setInput("");
    } catch (e) {
      setAvState("idle");
      setError(e instanceof ApiError && e.code === "quota_exceeded" ? "Your plan's monthly doubt limit has been reached." : (e as Error).message);
      if (teaching()) teachSegment(currentRef.current);
    } finally {
      setAsking(false);
    }
  }

  function startListening() {
    if (listening) {
      stopListenRef.current?.();
      return;
    }
    // Pause the lesson so the microphone doesn't hear the avatar.
    if (voiceRef.current?.speakingKind === "segment") voiceRef.current.stop();
    setListening(true);
    setAvState("listening");
    let gotFinal = false;
    stopListenRef.current = listen(session?.language ?? "en", {
      onInterim: setInput,
      onFinal: (t) => {
        gotFinal = true;
        ask(t, "voice");
      },
      onError: (m) => setError(m),
      onEnd: () => {
        setListening(false);
        setAvState((s) => (s === "listening" ? "idle" : s));
        if (!gotFinal && teaching()) teachSegment(currentRef.current);
      },
    });
  }

  const teacherAction = (path: string, body?: object) => api(`/live/sessions/${id}/${path}`, { body: body ?? {} }).catch((e) => setError((e as Error).message));

  if (loading) return <Spinner />;
  if (!session) return <ErrorNote message={error ?? "Class not found"} />;

  const isTeacher = role === "teacher";
  const live = session.status === "live";
  const progress = current ? Math.round(((current.index + 1) / current.total) * 100) : 0;
  const escalated = doubts.filter((d) => d.status === "escalated");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to="/classes" className="text-sm text-slate-500">
            ← Classes
          </Link>
          <h1 className="text-2xl font-semibold">{session.title}</h1>
          <p className="text-sm text-slate-500">{session.class_name}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`chip ${live ? "bg-red-50 text-red-600" : session.status === "ended" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-700"}`}>
            {live ? "● LIVE" : session.status}
            {live && session.mode === "paused" && " · paused"}
            {live && session.mode === "qa" && " · doubt time"}
          </span>
          <span className="chip bg-slate-100 text-slate-500">{streamStatus === "live" ? "connected" : streamStatus}</span>
        </div>
      </div>
      <ErrorNote message={error} />
      {alerts.map((a, i) => (
        <div key={i} className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          {a}
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Stage */}
        <div className="space-y-4 lg:col-span-3">
          <div className="card overflow-hidden bg-gradient-to-b from-indigo-50 to-white p-0">
            <div className="flex flex-col items-center px-4 pt-4">
              <AvatarFace shape={shape} state={avState} size={240} />
              <div className="mt-2 min-h-[4.5rem] w-full rounded-xl bg-slate-900/90 px-4 py-3 text-center text-base leading-snug text-white" aria-live="polite">
                {caption ?? <span className="text-slate-400">{live ? (joined ? "…" : "Join the class to hear your AI teacher") : session.status === "ended" ? "This class has ended." : "Waiting for the teacher to start the class."}</span>}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-slate-500">{current ? `Part ${current.index + 1} of ${current.total} · ${current.title}` : "Lesson not started"}</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div className="flex gap-2">
                {!joined && live && (
                  <button className="btn" onClick={join}>
                    🔊 Join class
                  </button>
                )}
                {joined && (
                  <button className="btn-ghost" onClick={toggleMute} aria-pressed={muted}>
                    {muted ? "🔇 Unmute" : "🔊 Mute"}
                  </button>
                )}
              </div>
            </div>
          </div>

          {current && (
            <div className="card">
              <p className="label">On the board</p>
              <p className="mt-2 leading-relaxed">{current.text}</p>
            </div>
          )}

          {isTeacher && (
            <div className="card space-y-3">
              <p className="label">Teacher controls</p>
              <div className="flex flex-wrap gap-2">
                {session.status === "scheduled" && (
                  <button className="btn" onClick={() => teacherAction("start")}>
                    ▶ Start live class
                  </button>
                )}
                {live && session.mode === "teaching" && (
                  <button className="btn-ghost" onClick={() => teacherAction("pause")}>
                    ⏸ Pause avatar
                  </button>
                )}
                {live && session.mode === "paused" && (
                  <button className="btn-ghost" onClick={() => teacherAction("resume")}>
                    ▶ Resume
                  </button>
                )}
                {live && session.mode === "teaching" && current && (
                  <button className="btn-ghost" onClick={() => teacherAction("advance", { expectedSegment: current.index, manual: true })}>
                    ⏭ Next part
                  </button>
                )}
                {live && (
                  <button className="btn-ghost text-red-600" onClick={() => confirm("End this class for everyone?") && teacherAction("end")}>
                    ⏹ End class
                  </button>
                )}
              </div>
              {live && <SayBox onSay={(text) => teacherAction("say", { text })} />}
              {live && (
                <p className="text-xs text-slate-500">
                  {attendance.filter((a) => a.online).length} online · {attendance.length} joined
                </p>
              )}
            </div>
          )}
        </div>

        {/* Doubts */}
        <div className="space-y-4 lg:col-span-2">
          {isTeacher && escalated.length > 0 && (
            <div className="card space-y-3 ring-amber-300">
              <p className="label text-amber-700">Doubts for you ({escalated.length})</p>
              {escalated.map((d) => (
                <ResolveBox key={d.id} doubt={d} onResolve={(answer) => teacherAction(`questions/${d.id}/resolve`, { answer })} />
              ))}
            </div>
          )}

          <div className="card flex max-h-[32rem] flex-col">
            <p className="label">Class doubts</p>
            <ul className="mt-2 flex-1 space-y-3 overflow-y-auto text-sm">
              {doubts.length === 0 && feed.length === 0 && <li className="text-slate-500">No doubts yet. {isTeacher ? "" : "Ask anything — the AI teacher answers for the whole class."}</li>}
              {feed.map((f) => (
                <li key={`f${f.id}`} className="rounded-xl bg-indigo-50 px-3 py-2 text-indigo-900">
                  📣 {f.text}
                </li>
              ))}
              {doubts.map((d) => (
                <li key={d.id} className={`rounded-xl px-3 py-2 ${d.status === "private" ? "bg-rose-50" : "bg-slate-50"}`}>
                  <p className="font-medium">
                    {d.studentName}: <span className="font-normal">{d.question}</span>
                  </p>
                  {d.answer && <p className="mt-1 text-slate-600">🧑‍🏫 {d.answer}</p>}
                  {d.status === "escalated" && <p className="mt-1 text-xs text-amber-700">Waiting for the teacher</p>}
                  {d.status === "resolved" && <p className="mt-1 text-xs text-emerald-700">Answered by the teacher</p>}
                  {d.status === "private" && <p className="mt-1 text-xs text-rose-700">Only you can see this.</p>}
                  {d.sourceRefs && d.sourceRefs.length > 0 && (
                    <details className="mt-1 text-xs text-slate-500">
                      <summary className="cursor-pointer">Sources</summary>
                      {d.sourceRefs.map((s) => (
                        <p key={s.ref} className="mt-1">
                          [{s.ref}] {s.title}
                        </p>
                      ))}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {!isTeacher && live && (
            <form
              className="card space-y-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                ask(input, "text");
              }}
            >
              <p className="label">Ask a doubt</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={startListening}
                  disabled={asking || !joined}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-white ${listening ? "animate-pulse bg-emerald-500" : "bg-brand"} disabled:opacity-40`}
                  aria-label={listening ? "Stop listening" : "Ask by voice"}
                  title={recognitionSupported() ? "Ask by voice" : "Voice input isn't supported in this browser"}
                >
                  🎤
                </button>
                <input className="input" placeholder={listening ? "Listening…" : "Type your doubt…"} value={input} onChange={(e) => setInput(e.target.value)} maxLength={500} disabled={asking} />
                <button className="btn" disabled={asking || !input.trim()}>
                  Ask
                </button>
              </div>
              {!joined && <p className="text-xs text-slate-500">Join the class to use voice.</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function SayBox({ onSay }: { onSay: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        await onSay(text);
        setText("");
      }}
    >
      <input className="input" placeholder="Say something to the class through the avatar…" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      <button className="btn-ghost">Say</button>
    </form>
  );
}

function ResolveBox({ doubt, onResolve }: { doubt: Doubt; onResolve: (answer: string) => Promise<unknown> }) {
  const [answer, setAnswer] = useState("");
  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        if (answer.trim()) await onResolve(answer);
      }}
    >
      <p>
        <span className="font-medium">{doubt.studentName}:</span> {doubt.question}
      </p>
      <div className="flex gap-2">
        <input className="input" placeholder="Your answer (the avatar will read it out)" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <button className="btn-ghost">Send</button>
      </div>
    </form>
  );
}
