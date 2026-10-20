import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, SuccessNote, fmtDateTime, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { celebrate } from "../lib/celebrate";
import { useAuth } from "../lib/auth";
import { ClassPicker, StudentPicker, useClasses, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STATE: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: "amber", label: "To do" },
  overdue: { tone: "red", label: "Overdue" },
  submitted: { tone: "sky", label: "Submitted" },
  graded: { tone: "green", label: "Graded" },
};

export function AssignmentsPage() {
  const { can } = useAuth();
  const staff = can("classes.manage");
  const parent = can("reports.children");
  const { classes } = useClasses();
  const students = useStudentOptions();
  const [params, setParams] = useSearchParams();
  const classId = params.get("classId") ?? "";
  const [studentId, setStudentId] = useState<string | null>(params.get("studentId"));
  const [open, setOpen] = useState(false);

  const query = new URLSearchParams();
  if (classId) query.set("classId", classId);
  if (parent && studentId) query.set("studentId", studentId);
  const path = parent && !studentId ? null : `/assignments?${query}`;
  const list = useApi<any>(path);
  const rows: any[] = list.data?.assignments ?? [];

  return (
    <div className="space-y-5">
      <PageTitle
        title="Assignments"
        icon="clipboard"
        subtitle={staff ? "Set homework, collect submissions and grade them." : parent ? "Homework set for your child and how it went." : "Your homework and projects."}
        action={
          <>
            {parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />}
            {classes.length > 0 && <ClassPicker allowAll value={classId} onChange={(id) => setParams(id ? { classId: id } : {})} classes={classes} />}
            {staff && (
              <button className="btn" onClick={() => setOpen(true)} disabled={!classes.length}>
                <Icon name="plus" size={16} /> New assignment
              </button>
            )}
          </>
        }
      />
      <ErrorNote message={list.error} />
      {parent && !students.loading && !students.options.length && <Empty title="No children linked" icon="heart">Link your child from My children to see their assignments.</Empty>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        path &&
        rows.length === 0 && (
          <Empty title="No assignments yet" icon="clipboard">
            {staff ? (classes.length ? "Create the first assignment for one of your classes." : "Create a class first, then set assignments for it.") : "When your teacher sets homework it shows up here."}
          </Empty>
        )
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((a) => {
          const st = STATE[a.state];
          const done = a.students ? Math.round((a.submitted / a.students) * 100) : 0;
          return (
            <Link key={a.id} to={`/assignments/${a.id}${parent && studentId ? `?studentId=${studentId}` : ""}`} className="card card-hover block animate-fade-up">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-brand">{a.class_name}</p>
                  <h2 className="mt-0.5 truncate text-base font-semibold text-slate-900">{a.title}</h2>
                </div>
                {st && <Badge tone={st.tone}>{st.label}</Badge>}
                {staff && a.status === "closed" && <Badge>Closed</Badge>}
              </div>
              {a.description && <p className="mt-2 line-clamp-2 text-sm text-slate-500">{a.description}</p>}
              <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Icon name="clock" size={14} /> {a.due_at ? `Due ${fmtDateTime(a.due_at)}` : "No due date"}
                </span>
                <span>
                  {a.graded_at ? (
                    <span className="font-semibold text-emerald-700">
                      {Number(a.points)}/{Number(a.max_points)} pts
                    </span>
                  ) : (
                    `${Number(a.max_points)} pts`
                  )}
                </span>
              </div>
              {staff && (
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-slate-500">
                    <span>
                      {a.submitted}/{a.students} submitted
                    </span>
                    <span>{a.graded} graded</span>
                  </div>
                  <Progress value={done} tone={done === 100 ? "green" : "brand"} />
                </div>
              )}
            </Link>
          );
        })}
      </div>
      {staff && <NewAssignment open={open} onClose={() => setOpen(false)} classes={classes} defaultClass={classId} onCreated={list.reload} />}
    </div>
  );
}

function NewAssignment({ open, onClose, classes, defaultClass, onCreated }: { open: boolean; onClose: () => void; classes: { id: string; name: string }[]; defaultClass: string; onCreated: () => void }) {
  const [form, setForm] = useState({ classId: defaultClass, title: "", description: "", dueAt: "", maxPoints: 10 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/assignments", {
        body: { ...form, classId: form.classId || classes[0]?.id, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null, maxPoints: Number(form.maxPoints) },
      });
      setForm({ ...form, title: "", description: "", dueAt: "" });
      onCreated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New assignment" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Class">
            <select className="input" value={form.classId || classes[0]?.id} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input className="input" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Pressure worksheet" />
          </Field>
        </div>
        <Field label="Instructions">
          <textarea className="input min-h-[7rem]" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What should students do?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due">
            <input className="input" type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
          </Field>
          <Field label="Maximum points">
            <input className="input" type="number" min={1} max={1000} required value={form.maxPoints} onChange={(e) => setForm({ ...form, maxPoints: Number(e.target.value) })} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? "Creating…" : "Create assignment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AssignmentDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const studentId = params.get("studentId");
  const detail = useApi<any>(`/assignments/${id}${studentId ? `?studentId=${studentId}` : ""}`);
  const { can } = useAuth();

  if (detail.loading && !detail.data) return <Spinner />;
  if (!detail.data) return <ErrorNote message={detail.error ?? "Assignment not found"} />;
  const a = detail.data.assignment;
  const overdue = a.due_at && new Date(a.due_at) < new Date();

  return (
    <div className="space-y-5">
      <Link to="/assignments" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <Icon name="chevronLeft" size={16} /> Assignments
      </Link>
      <div className="card animate-fade-up">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-brand">{a.class_name}</p>
            <h1 className="mt-1 font-display text-2xl font-semibold text-slate-900">{a.title}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={overdue ? "red" : "amber"}>
              <Icon name="clock" size={12} /> {a.due_at ? `Due ${fmtDateTime(a.due_at)}` : "No due date"}
            </Badge>
            <Badge tone="brand">{Number(a.max_points)} points</Badge>
            {a.status === "closed" && <Badge>Closed</Badge>}
          </div>
        </div>
        {a.description && <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-slate-700">{a.description}</p>}
        {detail.data.staff && <StaffControls assignment={a} onChanged={detail.reload} />}
      </div>
      {detail.data.staff ? (
        <Submissions assignment={a} rows={detail.data.submissions} onGraded={detail.reload} />
      ) : (
        <MySubmission assignment={a} submission={detail.data.submission} canSubmit={can("classes.attend") && !studentId} onSubmitted={detail.reload} />
      )}
    </div>
  );
}

function StaffControls({ assignment, onChanged }: { assignment: any; onChanged: () => void }) {
  const toggle = async () => {
    await api(`/assignments/${assignment.id}`, { method: "PATCH", body: { status: assignment.status === "closed" ? "published" : "closed" } });
    onChanged();
  };
  const remove = async () => {
    if (!confirm("Delete this assignment and all submissions?")) return;
    await api(`/assignments/${assignment.id}`, { method: "DELETE" });
    window.location.assign("/assignments");
  };
  return (
    <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4">
      <button className="btn-ghost btn-sm" onClick={toggle}>
        {assignment.status === "closed" ? "Reopen submissions" : "Close submissions"}
      </button>
      <button className="btn-danger btn-sm" onClick={remove}>
        <Icon name="trash" size={14} /> Delete
      </button>
    </div>
  );
}

function MySubmission({ assignment, submission, canSubmit, onSubmitted }: { assignment: any; submission: any; canSubmit: boolean; onSubmitted: () => void }) {
  const [content, setContent] = useState(submission?.content ?? "");
  const [linkUrl, setLinkUrl] = useState(submission?.link_url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const graded = !!submission?.graded_at;
  const editable = canSubmit && !graded && assignment.status !== "closed";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/assignments/${assignment.id}/submit`, { body: { content, linkUrl: linkUrl || null } });
      setOk(submission ? "Submission updated." : "Submitted! +25 XP — your teacher will grade it.");
      if (!submission) celebrate();
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <SectionCard title={graded ? "Your submission" : "Submit your work"} icon="send" className="lg:col-span-2">
        {editable ? (
          <form onSubmit={submit} className="space-y-3">
            <textarea className="input min-h-[10rem]" required value={content} onChange={(e) => setContent(e.target.value)} placeholder="Type your answer here…" />
            <Field label="Link (optional)" hint="Google Drive, a document or a video link.">
              <input className="input" type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" />
            </Field>
            <ErrorNote message={error} />
            <SuccessNote message={ok} />
            <button className="btn">{submission ? "Update submission" : "Submit"}</button>
          </form>
        ) : submission ? (
          <div className="space-y-2">
            <p className="whitespace-pre-line rounded-xl bg-slate-50 p-4 text-sm text-slate-700">{submission.content}</p>
            {submission.link_url && (
              <a className="inline-flex items-center gap-1 text-sm text-brand underline" href={submission.link_url} target="_blank" rel="noreferrer">
                <Icon name="link" size={14} /> {submission.link_url}
              </a>
            )}
            <p className="text-xs text-slate-500">Submitted {fmtDateTime(submission.submitted_at)}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{assignment.status === "closed" ? "Submissions are closed." : "Not submitted yet."}</p>
        )}
      </SectionCard>
      <SectionCard title="Grade" icon="award">
        {graded ? (
          <div>
            <p className="text-4xl font-bold text-slate-900">
              {Number(submission.points)}
              <span className="text-lg font-medium text-slate-400">/{Number(assignment.max_points)}</span>
            </p>
            {submission.feedback && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">“{submission.feedback}”</p>}
            <p className="mt-2 text-xs text-slate-500">Graded {fmtDateTime(submission.graded_at)}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{submission ? "Waiting for your teacher to grade." : "Submit to get a grade."}</p>
        )}
      </SectionCard>
    </div>
  );
}

function Submissions({ assignment, rows, onGraded }: { assignment: any; rows: any[]; onGraded: () => void }) {
  const [grading, setGrading] = useState<any>(null);
  const submitted = rows.filter((r) => r.submission).length;
  return (
    <SectionCard title={`Submissions · ${submitted}/${rows.length}`} icon="users">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No students in this class yet.</p>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="pl-5">Student</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Points</th>
                <th className="pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.student_id}>
                  <td className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} size={28} />
                      <span className="font-medium text-slate-900">{r.name}</span>
                    </div>
                  </td>
                  <td>{r.submission ? r.submission.graded_at ? <Badge tone="green">Graded</Badge> : <Badge tone="sky">Submitted</Badge> : <Badge tone="amber">Missing</Badge>}</td>
                  <td className="text-slate-500">{r.submission ? fmtDateTime(r.submission.submitted_at) : "—"}</td>
                  <td className="font-semibold">{r.submission?.graded_at ? `${Number(r.submission.points)}/${Number(assignment.max_points)}` : "—"}</td>
                  <td className="pr-5 text-right">
                    {r.submission && (
                      <button className="btn-ghost btn-sm" onClick={() => setGrading(r)}>
                        {r.submission.graded_at ? "Edit grade" : "Grade"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {grading && <GradeModal assignment={assignment} row={grading} onClose={() => setGrading(null)} onSaved={onGraded} />}
    </SectionCard>
  );
}

function GradeModal({ assignment, row, onClose, onSaved }: { assignment: any; row: any; onClose: () => void; onSaved: () => void }) {
  const [points, setPoints] = useState<number>(row.submission.points != null ? Number(row.submission.points) : Number(assignment.max_points));
  const [feedback, setFeedback] = useState(row.submission.feedback ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/assignments/${assignment.id}/submissions/${row.submission.id}/grade`, { body: { points: Number(points), feedback: feedback || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Grade ${row.name}`} wide>
      <form onSubmit={save} className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="whitespace-pre-line text-sm text-slate-700">{row.submission.content}</p>
          {row.submission.link_url && (
            <a className="mt-2 inline-flex items-center gap-1 text-sm text-brand underline" href={row.submission.link_url} target="_blank" rel="noreferrer">
              <Icon name="link" size={14} /> Open link
            </a>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={`Points (out of ${Number(assignment.max_points)})`}>
            <input className="input" type="number" min={0} max={Number(assignment.max_points)} step="0.5" required value={points} onChange={(e) => setPoints(Number(e.target.value))} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Feedback">
              <input className="input" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Well explained! Check question 3." />
            </Field>
          </div>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Save grade</button>
        </div>
      </form>
    </Modal>
  );
}
