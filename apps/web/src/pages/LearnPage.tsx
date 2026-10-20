import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { Empty, ErrorNote, PageTitle, Progress, Spinner } from "../components/ui";
import { useApi } from "../lib/useApi";

interface Lesson {
  id: string;
  title: string;
  status: "in_progress" | "completed" | null;
}
interface Topic {
  id: string;
  title: string;
  sequence: number;
  difficulty: number;
  estimatedMinutes: number;
  lessons: Lesson[];
  mastery: number | null;
}
interface Chapter {
  id: string;
  title: string;
  sequence: number;
  topics: Topic[];
}
interface Subject {
  id: string;
  name: string;
  chapters: Chapter[];
}

const SUBJECT_STYLES = [
  { ring: "from-indigo-500 to-violet-500", soft: "bg-indigo-50 text-indigo-700" },
  { ring: "from-emerald-500 to-teal-500", soft: "bg-emerald-50 text-emerald-700" },
  { ring: "from-amber-500 to-orange-500", soft: "bg-amber-50 text-amber-700" },
  { ring: "from-sky-500 to-cyan-500", soft: "bg-sky-50 text-sky-700" },
  { ring: "from-rose-500 to-pink-500", soft: "bg-rose-50 text-rose-700" },
];

const topicState = (t: Topic) =>
  t.lessons.length && t.lessons.every((l) => l.status === "completed") ? "done" : t.lessons.some((l) => l.status) ? "started" : "new";

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}` : `${m} min`);

function chapterStats(c: Chapter) {
  const done = c.topics.filter((t) => topicState(t) === "done").length;
  return { done, total: c.topics.length, minutes: c.topics.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0) };
}

export function LearnPage() {
  const [version, setVersion] = useState("");
  const course = useApi<any>(`/curriculum/overview${version ? `?curriculumVersionId=${version}` : ""}`);
  const cont = useApi<any>(course.data?.tracksProgress ? "/courses/continue" : null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const subjects: Subject[] = course.data?.subjects ?? [];
  const subjectIndex = Math.max(0, subjects.findIndex((s) => s.id === subjectId));
  const subject = subjects[subjectIndex];
  const style = SUBJECT_STYLES[subjectIndex % SUBJECT_STYLES.length];
  const tracks = !!course.data?.tracksProgress;

  const chapters = useMemo(() => {
    if (!subject) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return subject.chapters;
    return subject.chapters
      .map((c) => (c.title.toLowerCase().includes(needle) ? c : { ...c, topics: c.topics.filter((t) => t.title.toLowerCase().includes(needle)) }))
      .filter((c) => c.title.toLowerCase().includes(needle) || c.topics.length);
  }, [subject, q]);

  if (course.loading && !course.data) return <Spinner />;
  const all = subject?.chapters.flatMap((c) => c.topics) ?? [];
  const doneTopics = all.filter((t) => topicState(t) === "done").length;
  const lessonCount = all.reduce((n, t) => n + t.lessons.length, 0);
  const versionLabel = (v: any) => `${v.board} · ${v.grade}${v.academic_year ? ` · ${v.academic_year}` : ""}`;
  const current = course.data?.versions?.find((v: any) => v.id === course.data?.curriculumVersionId);

  return (
    <div className="space-y-5">
      <PageTitle
        title="Courses"
        icon="book"
        subtitle={current ? `${versionLabel(current)} — open a chapter, pick a topic, and read its lesson.` : "Your syllabus, chapter by chapter."}
        action={
          !tracks &&
          (course.data?.versions?.length ?? 0) > 1 && (
            <select className="input w-auto" value={version || course.data?.curriculumVersionId || ""} onChange={(e) => setVersion(e.target.value)} aria-label="Curriculum">
              {course.data.versions.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                </option>
              ))}
            </select>
          )
        }
      />
      <ErrorNote message={course.error} />

      {tracks && cont.data?.lesson && (
        <Link
          to={`/learn/lessons/${cont.data.lesson.id}`}
          className="group flex flex-wrap items-center gap-4 rounded-[1.75rem] bg-gradient-to-r from-brand via-violet-500 to-fuchsia-500 p-5 text-white shadow-lift transition hover:-translate-y-0.5 animate-fade-up"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20">
            <Icon name="play" size={26} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/80">{cont.data.lesson.status === "not_started" ? "Start here" : "Continue where you left off"}</p>
            <p className="truncate text-lg font-semibold">{cont.data.lesson.title}</p>
            <p className="truncate text-sm text-white/80">{cont.data.lesson.topic}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 text-sm font-semibold text-brand transition group-hover:gap-2">
            {cont.data.lesson.status === "not_started" ? "Start" : "Continue"} <Icon name="arrowRight" size={16} />
          </span>
        </Link>
      )}

      {!subjects.length ? (
        <Empty title="No course content yet" icon="book">
          Approved chapters and lessons for your class appear here.
        </Empty>
      ) : (
        <>
          {subjects.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {subjects.map((s, i) => {
                const on = i === subjectIndex;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSubjectId(s.id);
                      setOpen(null);
                    }}
                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${on ? "bg-slate-900 text-white shadow-md" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="card flex flex-wrap items-center gap-5 animate-fade-up">
            <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md ${style.ring}`}>
              <Icon name="book" size={28} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-xl font-semibold text-slate-900">{subject.name}</h2>
              <p className="text-sm text-slate-500">
                {subject.chapters.length} chapters · {all.length} topics · {lessonCount} lessons · about {minutes(all.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0))}
              </p>
              {tracks && (
                <div className="mt-2 max-w-md">
                  <Progress value={all.length ? (doneTopics / all.length) * 100 : 0} tone="green" />
                  <p className="mt-1 text-xs text-slate-500">
                    {doneTopics} of {all.length} topics finished
                  </p>
                </div>
              )}
            </div>
            <input className="input max-w-xs" placeholder="Search chapters and topics" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          </div>

          {tracks && (
            <div className="flex flex-wrap gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <StateDot state="done" /> Finished
              </span>
              <span className="inline-flex items-center gap-1.5">
                <StateDot state="started" /> Started
              </span>
              <span className="inline-flex items-center gap-1.5">
                <StateDot state="new" /> Not started
              </span>
            </div>
          )}

          <ol className="relative space-y-3">
            {chapters.map((c) => {
              const st = chapterStats(c);
              const finished = tracks && st.total > 0 && st.done === st.total;
              const isOpen = open === c.id || !!q.trim();
              return (
                <li key={c.id} className="card overflow-hidden p-0 animate-fade-up">
                  <button className="flex w-full items-center gap-4 p-4 text-left sm:p-5" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={isOpen}>
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-base font-bold ${finished ? "bg-emerald-500 text-white" : `${style.soft}`}`}
                      aria-hidden
                    >
                      {finished ? <Icon name="check" size={20} /> : c.sequence}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-slate-500">Chapter {c.sequence}</p>
                      <p className="font-semibold text-slate-900">{c.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {st.total} topic{st.total === 1 ? "" : "s"}
                        {st.minutes > 0 && ` · about ${minutes(st.minutes)}`}
                        {tracks && st.total > 0 && ` · ${st.done}/${st.total} done`}
                      </p>
                    </div>
                    {tracks && st.total > 0 && (
                      <div className="hidden w-28 sm:block">
                        <Progress value={(st.done / st.total) * 100} tone="green" />
                      </div>
                    )}
                    <Icon name="chevronDown" size={18} className={`shrink-0 text-slate-400 transition ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                  {isOpen && (
                    <ul className="border-t border-slate-100 bg-slate-50/60">
                      {c.topics.map((t) => (
                        <TopicRow key={t.id} t={t} tracks={tracks} />
                      ))}
                      {!c.topics.length && <li className="px-5 py-4 text-sm text-slate-500">No topics in this chapter yet.</li>}
                    </ul>
                  )}
                </li>
              );
            })}
            {!chapters.length && <p className="text-sm text-slate-500">Nothing matches “{q}”.</p>}
          </ol>
        </>
      )}
    </div>
  );
}

function StateDot({ state }: { state: "done" | "started" | "new" }) {
  if (state === "done")
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Icon name="check" size={12} />
      </span>
    );
  if (state === "started") return <span className="h-5 w-5 rounded-full border-[3px] border-amber-400 bg-amber-100" />;
  return <span className="h-5 w-5 rounded-full border-2 border-slate-300 bg-white" />;
}

function TopicRow({ t, tracks }: { t: Topic; tracks: boolean }) {
  const state = topicState(t);
  const lesson = t.lessons.find((l) => l.status !== "completed") ?? t.lessons[0];
  const label = !tracks ? "Open lesson" : state === "done" ? "Review" : state === "started" ? "Continue" : "Start";
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 sm:px-5">
      {tracks ? <StateDot state={state} /> : <span className="h-5 w-5 text-center text-xs font-semibold text-slate-400">{t.sequence}</span>}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">{t.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Icon name="clock" size={12} /> {minutes(t.estimatedMinutes ?? 0)}
          </span>
          <span className="inline-flex items-center gap-1" title={`Difficulty ${t.difficulty} of 5`}>
            Level
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} className={`h-1.5 w-1.5 rounded-full ${n <= t.difficulty ? "bg-brand" : "bg-slate-200"}`} />
            ))}
          </span>
          {t.mastery != null && (
            <span className={`chip ${t.mastery >= 0.75 ? "bg-emerald-50 text-emerald-700" : t.mastery >= 0.5 ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>
              {Math.round(t.mastery * 100)}% mastery
            </span>
          )}
        </p>
      </div>
      {lesson ? (
        <Link to={`/learn/lessons/${lesson.id}`} className={state === "done" && tracks ? "btn-ghost btn-sm" : "btn btn-sm"}>
          {label} <Icon name="arrowRight" size={14} />
        </Link>
      ) : (
        <span className="text-xs text-slate-400">Lesson coming soon</span>
      )}
    </li>
  );
}
