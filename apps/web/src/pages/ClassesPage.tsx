import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { Empty, ErrorNote, PageTitle, Spinner } from "../components/ui";

export function ClassesPage() {
  const { can } = useAuth();
  const classes = useApi("/classes");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const manage = can("classes.manage");

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api("/classes", { body: { name } });
      setName("");
      await classes.reload();
      setSelected(r.class.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (classes.loading && !classes.data) return <Spinner />;
  const list = classes.data?.classes ?? [];

  return (
    <div className="space-y-6">
      <PageTitle title="Live classes" icon="video" subtitle={manage ? "Live classes taught by your AI teacher, with doubt clearing for every student." : "Join live classes and ask the AI teacher your doubts."} />
      <ErrorNote message={error ?? classes.error} />
      {manage && (
        <form onSubmit={create} className="card flex gap-2">
          <input className="input" placeholder="New class name, e.g. 8-A Science" required value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn">Create class</button>
        </form>
      )}
      {!classes.error && list.length === 0 && <Empty title="No classes yet">{manage ? "Create a class, add students and schedule a live AI lesson." : "Your teacher hasn't added you to a class yet."}</Empty>}
      <div className="grid gap-4 md:grid-cols-2">
        {list.map((c: any) => (
          <div key={c.id} className={`card ${selected === c.id ? "ring-2 ring-brand" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-lg font-medium">{c.name}</p>
                <p className="text-xs text-slate-500">
                  {c.teacher} · {c.students} students
                </p>
              </div>
              {manage && (
                <button className="btn-ghost" onClick={() => setSelected(selected === c.id ? null : c.id)}>
                  Manage
                </button>
              )}
            </div>
            <ul className="mt-3 space-y-2">
              {(c.sessions ?? []).map((s: any) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">
                    {s.status === "live" && <span className="mr-1 text-red-600">●</span>}
                    {s.title}
                  </span>
                  <Link to={`/live/${s.id}`} className={s.status === "live" ? "btn" : "btn-ghost"}>
                    {s.status === "live" ? "Join live" : manage ? "Open" : "Waiting room"}
                  </Link>
                </li>
              ))}
              {!(c.sessions ?? []).length && <li className="text-sm text-slate-500">No upcoming sessions.</li>}
            </ul>
          </div>
        ))}
      </div>
      {manage && selected && <ManageClass classId={selected} onChanged={classes.reload} />}
    </div>
  );
}

function ManageClass({ classId, onChanged }: { classId: string; onChanged: () => void }) {
  const detail = useApi(`/classes/${classId}`);
  const members = useApi("/tenants/current/members");
  const chapters = useApi("/curriculum/chapters");
  const [chapterId, setChapterId] = useState("");
  const topics = useApi(chapterId ? `/curriculum/topics?chapterId=${chapterId}` : null);
  const [lessonId, setLessonId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const enrolled = new Set((detail.data?.students ?? []).map((s: any) => s.student_id));
  const candidates = (members.data?.members ?? []).filter((m: any) => m.student_profile_id && !enrolled.has(m.student_profile_id));

  async function enrol() {
    try {
      await api(`/classes/${classId}/enrollments`, { body: { studentIds: picked } });
      setPicked([]);
      detail.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function schedule(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/classes/${classId}/sessions`, { body: { lessonId } });
      detail.reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (detail.loading && !detail.data) return <Spinner />;
  return (
    <div className="card space-y-5">
      <h2 className="font-medium">Manage {detail.data?.class.name}</h2>
      <ErrorNote message={error} />
      <section>
        <p className="label">Students ({detail.data?.students?.length ?? 0})</p>
        <p className="mt-1 text-sm text-slate-600">{(detail.data?.students ?? []).map((s: any) => s.name).join(", ") || "None yet."}</p>
        {candidates.length > 0 && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              {candidates.map((m: any) => (
                <label key={m.student_profile_id} className={`chip cursor-pointer px-3 py-1 ring-1 ${picked.includes(m.student_profile_id) ? "bg-brand-soft text-brand ring-brand" : "ring-slate-200"}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={picked.includes(m.student_profile_id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.student_profile_id] : p.filter((x) => x !== m.student_profile_id)))}
                  />
                  {m.name}
                </label>
              ))}
            </div>
            <button className="btn-ghost" disabled={!picked.length} onClick={enrol}>
              Add {picked.length || ""} to class
            </button>
          </div>
        )}
      </section>
      <section>
        <p className="label">Schedule a live AI lesson</p>
        <form onSubmit={schedule} className="mt-2 grid gap-2 md:grid-cols-3">
          <select className="input" value={chapterId} onChange={(e) => (setChapterId(e.target.value), setLessonId(""))} required>
            <option value="">Chapter…</option>
            {chapters.data?.chapters.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select className="input" value={lessonId} onChange={(e) => setLessonId(e.target.value)} required>
            <option value="">Lesson…</option>
            {topics.data?.topics.flatMap((t: any) =>
              (t.lessons ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              )),
            )}
          </select>
          <button className="btn">Schedule</button>
        </form>
      </section>
      <section>
        <p className="label">Sessions</p>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {(detail.data?.sessions ?? []).map((s: any) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span>
                {s.title} <span className="text-xs text-slate-400">· {s.status}</span>
              </span>
              <Link to={`/live/${s.id}`} className="btn-ghost">
                {s.status === "scheduled" ? "Open & start" : "Open"}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
