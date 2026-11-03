import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { Empty, ErrorNote, PageTitle, Progress, Spinner } from "../components/ui";
import { useApi } from "../lib/useApi";
import { minutes, subjectStyle } from "./CoursePage";

interface Course {
  curriculumVersionId: string;
  board: string;
  grade: string;
  gradeSequence: number;
  academicYear: string | null;
  subjectId: string;
  subject: string;
  code: string;
  chapters: number;
  topics: number;
  lessons: number;
  minutes: number;
  mine: boolean;
  completedLessons: number | null;
}

/** Courses catalog: every subject of every class, grouped class by class. A student's own class comes first. */
export function LearnPage() {
  const catalog = useApi<{ tracksProgress: boolean; courses: Course[] }>("/curriculum/catalog");
  const cont = useApi<any>(catalog.data?.tracksProgress ? "/courses/continue" : null);
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [q, setQ] = useState("");

  const courses = catalog.data?.courses ?? [];
  const tracks = !!catalog.data?.tracksProgress;
  const grades = useMemo(() => [...new Set(courses.map((c) => c.grade))], [courses]);
  const subjects = useMemo(() => [...new Set(courses.map((c) => c.subject))].sort(), [courses]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = courses.filter(
      (c) => (!grade || c.grade === grade) && (!subject || c.subject === subject) && (!needle || `${c.subject} ${c.grade} ${c.board}`.toLowerCase().includes(needle)),
    );
    const byClass = new Map<string, { key: string; label: string; mine: boolean; courses: Course[] }>();
    for (const c of shown) {
      let g = byClass.get(c.curriculumVersionId);
      if (!g) byClass.set(c.curriculumVersionId, (g = { key: c.curriculumVersionId, label: `${c.grade} · ${c.board}${c.academicYear ? ` · ${c.academicYear}` : ""}`, mine: c.mine, courses: [] }));
      g.courses.push(c);
    }
    return [...byClass.values()].sort((a, b) => Number(b.mine) - Number(a.mine));
  }, [courses, grade, subject, q]);

  if (catalog.loading && !catalog.data) return <Spinner />;

  return (
    <div className="space-y-5">
      <PageTitle title="Courses" icon="book" subtitle="Every subject, class by class — open a course to study it topic by topic." />
      <ErrorNote message={catalog.error} />

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

      {!courses.length ? (
        <Empty title="No course content yet" icon="book">
          Approved chapters and lessons for each class appear here.
        </Empty>
      ) : (
        <>
          <div className="card flex flex-wrap items-center gap-3">
            <select className="input w-auto" value={grade} onChange={(e) => setGrade(e.target.value)} aria-label="Class">
              <option value="">All classes</option>
              {grades.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <select className="input w-auto" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
              <option value="">All subjects</option>
              {subjects.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input className="input max-w-xs flex-1" placeholder="Search courses" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <span className="ml-auto text-sm text-slate-500">
              {groups.reduce((n, g) => n + g.courses.length, 0)} courses · {groups.length} class{groups.length === 1 ? "" : "es"}
            </span>
          </div>

          {groups.map((g) => (
            <section key={g.key} className="space-y-3 animate-fade-up">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-900">
                <Icon name="graduation" size={18} className="text-slate-400" /> {g.label}
                {g.mine && <span className="chip bg-brand/10 text-brand">Your class</span>}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {g.courses.map((c) => (
                  <CourseCard key={c.subjectId} c={c} tracks={tracks && c.mine} />
                ))}
              </div>
            </section>
          ))}
          {!groups.length && <p className="text-sm text-slate-500">No course matches these filters.</p>}
        </>
      )}
    </div>
  );
}

function CourseCard({ c, tracks }: { c: Course; tracks: boolean }) {
  const style = subjectStyle(c.subject);
  const done = c.completedLessons ?? 0;
  return (
    <Link to={`/learn/course/${c.curriculumVersionId}/${c.subjectId}`} className="card group flex flex-col gap-3 transition hover:-translate-y-0.5 hover:shadow-lift">
      <div className="flex items-center gap-3">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md ${style.ring}`}>
          <Icon name="book" size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{c.subject}</p>
          <p className="truncate text-xs text-slate-500">{c.grade}</p>
        </div>
        <Icon name="chevronRight" size={18} className="shrink-0 text-slate-300 transition group-hover:text-slate-500" />
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <span className={`chip ${style.soft}`}>{c.chapters} chapters</span>
        <span className="chip bg-slate-100 text-slate-600">{c.topics} topics</span>
        <span className="chip bg-slate-100 text-slate-600">{c.lessons} lessons</span>
        {c.minutes > 0 && <span className="chip bg-slate-100 text-slate-600">about {minutes(c.minutes)}</span>}
      </div>
      {tracks && c.lessons > 0 && (
        <div>
          <Progress value={(done / c.lessons) * 100} tone="green" />
          <p className="mt-1 text-xs text-slate-500">
            {done} of {c.lessons} lessons finished
          </p>
        </div>
      )}
    </Link>
  );
}
