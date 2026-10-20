import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon, type IconName } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, pct100, toneForPercent, DAYS, type Tone } from "../components/ui";
import { api, apiBlob } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";

const ROLE: Record<string, string> = { tenant_owner: "Principal", tenant_admin: "Admin", teacher: "Teacher", staff: "Office / HR", accountant: "Accounts", librarian: "Librarian", transport_manager: "Transport", warden: "Warden", content_reviewer: "Reviewer" };
const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);

export const ACTIVITY_CATEGORIES: { value: string; label: string; icon: IconName; tone: Tone }[] = [
  { value: "sport", label: "Sport", icon: "trophy", tone: "green" },
  { value: "pt", label: "PT / Physical education", icon: "flame", tone: "amber" },
  { value: "club", label: "Club", icon: "users", tone: "sky" },
  { value: "arts", label: "Arts", icon: "star", tone: "brand" },
  { value: "music", label: "Music", icon: "sparkles", tone: "brand" },
  { value: "other", label: "Other", icon: "layers", tone: "slate" },
];
const category = (v: string) => ACTIVITY_CATEGORIES.find((c) => c.value === v) ?? ACTIVITY_CATEGORIES[5];

const RESULT_TONE: Record<string, Tone> = { pass: "green", fail: "red", pending: "slate" };
const fileSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const groupByGrade = <T extends { grade_number: number | null }>(rows: T[]) => {
  const by = new Map<number | null, T[]>();
  for (const r of rows) by.set(r.grade_number, [...(by.get(r.grade_number) ?? []), r]);
  return by;
};

// ---------------------------------------------------------------------------
// Principal / admin: the school directory
// ---------------------------------------------------------------------------
type Tab = "overview" | "staff" | "classes" | "students" | "activities" | "documents" | "settings";

export function DirectoryPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "overview";
  return (
    <div className="space-y-5">
      <PageTitle title="School directory" icon="users" subtitle="All staff, Class 1 to 12, every student's profile, reports, documents and activities." />
      <div className="overflow-x-auto">
        <Tabs
          value={tab}
          onChange={(t) => setParams({ tab: t })}
          options={[
            { value: "overview", label: "Overview" },
            { value: "staff", label: "Teachers & staff" },
            { value: "classes", label: "Classes 1–12" },
            { value: "students", label: "Students" },
            { value: "activities", label: "Sports & activities" },
            { value: "documents", label: "Documents" },
            { value: "settings", label: "Settings" },
          ]}
        />
      </div>
      {tab === "overview" && <Overview />}
      {tab === "staff" && <StaffDirectory />}
      {tab === "classes" && <ClassGrid />}
      {tab === "students" && <StudentList />}
      {tab === "activities" && <ActivityList />}
      {tab === "documents" && <AllDocuments />}
      {tab === "settings" && <DirectorySettings />}
    </div>
  );
}

function Overview() {
  const s = useApi<any>("/directory/summary");
  const classes = useApi<any>("/directory/classes");
  const sum = s.data?.summary;
  const by = groupByGrade<any>(classes.data?.classes ?? []);
  return (
    <div className="space-y-5">
      <ErrorNote message={s.error ?? classes.error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Staff" value={sum?.staff ?? "—"} icon="users" />
        <StatCard label="Teachers" value={sum?.teachers ?? "—"} icon="graduation" tone="sky" />
        <StatCard label="Students" value={sum?.students ?? "—"} icon="heart" tone="green" />
        <StatCard label="Class sections" value={sum?.classes ?? "—"} icon="layers" tone="amber" />
        <StatCard label="Activities" value={sum?.activities ?? "—"} icon="trophy" tone="brand" />
        <StatCard label="Documents" value={sum?.documents ?? "—"} icon="folder" tone="slate" />
      </div>
      <SectionCard title="Students by class" icon="chart">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {GRADES.map((g) => {
            const rows = by.get(g) ?? [];
            const n = rows.reduce((t: number, c: any) => t + c.students, 0);
            return (
              <Link key={g} to={`?tab=classes#grade-${g}`} className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200/70 transition hover:bg-white hover:shadow-sm">
                <p className="text-xs font-semibold text-slate-500">Class {g}</p>
                <p className="text-xl font-bold text-slate-900">{n}</p>
                <p className="text-xs text-slate-500">{rows.length ? `${rows.length} section${rows.length > 1 ? "s" : ""}` : "No sections"}</p>
              </Link>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}

function StaffDirectory() {
  const list = useApi<any>("/directory/staff");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("all");
  const rows: any[] = (list.data?.staff ?? []).filter(
    (s: any) => (role === "all" || s.roles.includes(role)) && (!q || `${s.name} ${s.email} ${s.designation ?? ""} ${s.department ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search name, email, department" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[12rem]" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
          <option value="all">All roles</option>
          {Object.entries(ROLE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title="No staff found" icon="users">Invite teachers and staff from People.</Empty>
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Name</th>
                  <th>Designation</th>
                  <th>Subjects taught</th>
                  <th>Class teacher</th>
                  <th>Activities</th>
                  <th className="pr-5 text-right">Docs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.user_id}>
                    <td className="pl-5">
                      <Link to={`/directory/staff/${s.user_id}`} className="flex items-center gap-2.5">
                        <Avatar name={s.name} size={32} />
                        <div>
                          <p className="font-semibold text-slate-900 hover:text-brand">{s.name}</p>
                          <p className="text-xs text-slate-500">{s.roles.map((r: string) => ROLE[r] ?? r).join(", ")}</p>
                        </div>
                      </Link>
                    </td>
                    <td>
                      <p>{s.designation || "—"}</p>
                      {s.department && <p className="text-xs text-slate-500">{s.department}</p>}
                    </td>
                    <td className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {s.subjects.length ? s.subjects.map((x: any) => <Badge key={x.id} tone="sky">{x.className} · {x.subject}</Badge>) : <span className="text-slate-400">—</span>}
                      </div>
                    </td>
                    <td>{s.class_teacher_of.map((c: any) => c.name).join(", ") || "—"}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {s.activities.length ? s.activities.map((a: any) => <Badge key={a.id} tone={category(a.category).tone}>{a.name}</Badge>) : <span className="text-slate-400">—</span>}
                      </div>
                    </td>
                    <td className="pr-5 text-right">{s.documents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ClassGrid() {
  const list = useApi<any>("/directory/classes");
  const [setup, setSetup] = useState<number[] | null>(null);
  const by = groupByGrade<any>(list.data?.classes ?? []);
  const other = by.get(null) ?? [];
  if (list.loading && !list.data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" onClick={() => setSetup(GRADES)}>
          <Icon name="plus" size={16} /> Set up classes and sections
        </button>
        <p className="text-sm text-slate-500">Create sections (A, B, C…) for any of Class 1 to 12, each with its subjects. Existing sections are left as they are.</p>
      </div>
      <ErrorNote message={list.error} />
      {GRADES.map((g) => (
        <GradeRow key={g} label={`Class ${g}`} id={`grade-${g}`} classes={by.get(g) ?? []} onAdd={() => setSetup([g])} />
      ))}
      {other.length > 0 && <GradeRow label="Other classes and batches" id="grade-other" classes={other} />}
      {setup && <SetupClasses grades={setup} existing={list.data?.classes ?? []} onClose={() => setSetup(null)} onDone={list.reload} />}
      <p className="text-xs text-slate-500">
        Sections are placed by their grade from <Link className="text-brand" to="/academics/setup">Academic setup</Link>, or by a name that starts with the class number (for example "8-A").
      </p>
    </div>
  );
}

function GradeRow({ label, id, classes, onAdd }: { label: string; id: string; classes: any[]; onAdd?: () => void }) {
  const students = classes.reduce((t, c) => t + c.students, 0);
  return (
    <section id={id} className="card scroll-mt-24">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title">
          <Icon name="graduation" size={16} className="text-brand" /> {label}
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {classes.length} section{classes.length === 1 ? "" : "s"} · {students} student{students === 1 ? "" : "s"}
          </span>
          {onAdd && (
            <button className="btn-ghost btn-sm" onClick={onAdd}>
              <Icon name="plus" size={14} /> Add section
            </button>
          )}
        </div>
      </div>
      {!classes.length ? (
        <p className="text-sm text-slate-400">No sections yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {classes.map((c) => (
            <ClassCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClassCard({ c, extra }: { c: any; extra?: ReactNode }) {
  return (
    <Link to={`/directory/classes/${c.id}`} className="block rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70 transition hover:bg-white hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-slate-900">{c.name}</p>
          <p className="text-xs text-slate-500">Class teacher: {c.class_teacher}</p>
        </div>
        <Badge tone="brand">{c.students} students</Badge>
      </div>
      {c.subjects?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {c.subjects.map((s: any) => (
            <span key={s.id} className="chip bg-white text-slate-600 ring-1 ring-slate-200" title={s.teacher ? `Teacher: ${s.teacher}` : "No teacher assigned"}>
              {s.subject}
            </span>
          ))}
        </div>
      )}
      {extra}
    </Link>
  );
}

function SetupClasses({ grades: initial, existing, onClose, onDone }: { grades: number[]; existing: any[]; onClose: () => void; onDone: () => void }) {
  const defaults = useApi<any>("/directory/default-subjects");
  const staff = useApi<any>("/directory/staff");
  const single = initial.length === 1;
  const nextSection = single ? String.fromCharCode(65 + existing.filter((c) => c.grade_number === initial[0]).length) : "A, B";
  const [grades, setGrades] = useState<number[]>(initial);
  const [sections, setSections] = useState(nextSection);
  const [board, setBoard] = useState("CBSE");
  const [teacherId, setTeacherId] = useState("");
  const [subjects, setSubjects] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const subjectsFor = (g: number) => subjects[g] ?? (defaults.data?.subjects[g] ?? []).join(", ");
  // Grades share a subject list in bands, so edit one list per band rather than twelve.
  const bands = [
    { label: "Class 1–2", grades: [1, 2] },
    { label: "Class 3–5", grades: [3, 4, 5] },
    { label: "Class 6–8", grades: [6, 7, 8] },
    { label: "Class 9–10", grades: [9, 10] },
    { label: "Class 11–12", grades: [11, 12] },
  ].filter((b) => b.grades.some((g) => grades.includes(g)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
      const r = await api("/directory/classes/setup", {
        body: {
          grades,
          sections: list(sections),
          board,
          classTeacherId: teacherId || null,
          subjects: Object.fromEntries(grades.map((g) => [String(g), list(subjectsFor(g))])),
        },
      });
      setDone(`${r.created} section${r.created === 1 ? "" : "s"} created with ${r.subjects} subjects.${r.skipped.length ? ` Already there: ${r.skipped.join(", ")}.` : ""}`);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={single ? `Add a section to Class ${initial[0]}` : "Set up classes and sections"} wide>
      {done ? (
        <div className="space-y-4">
          <SuccessNote message={done} />
          <p className="text-sm text-slate-500">Next, assign subject teachers and books on each section's page, and link syllabi in Academic setup.</p>
          <div className="flex justify-end">
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          {!single && (
            <div>
              <span className="label">Classes</span>
              <div className="flex flex-wrap gap-1.5">
                {GRADES.map((g) => {
                  const on = grades.includes(g);
                  return (
                    <button
                      type="button"
                      key={g}
                      onClick={() => setGrades(on ? grades.filter((x) => x !== g) : [...grades, g].sort((a, b) => a - b))}
                      className={`h-9 w-9 rounded-xl text-sm font-semibold ring-1 transition ${on ? "bg-brand text-white ring-brand" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Sections" hint="Comma-separated, e.g. A, B, C">
              <input className="input" required value={sections} onChange={(e) => setSections(e.target.value)} />
            </Field>
            <Field label="Board">
              <input className="input" value={board} onChange={(e) => setBoard(e.target.value)} />
            </Field>
            <Field label="Class teacher" hint="Change it per section later">
              <select className="input" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
                <option value="">Me (for now)</option>
                {(staff.data?.staff ?? []).map((s: any) => (
                  <option key={s.user_id} value={s.user_id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="space-y-3">
            <span className="label">Subjects</span>
            {bands.map((b) => (
              <Field key={b.label} label={b.label}>
                <input
                  className="input"
                  value={subjectsFor(b.grades.find((g) => grades.includes(g))!)}
                  onChange={(e) => setSubjects({ ...subjects, ...Object.fromEntries(b.grades.map((g) => [g, e.target.value])) })}
                />
              </Field>
            ))}
          </div>
          <ErrorNote message={err} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy || !grades.length}>
              {busy ? "Creating…" : "Create sections"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function StudentList() {
  const classes = useApi<any>("/directory/classes");
  const [classId, setClassId] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const qs = new URLSearchParams();
  if (classId) qs.set("classId", classId);
  if (search) qs.set("q", search);
  const list = useApi<any>(`/directory/students?${qs}`);
  const rows: any[] = list.data?.students ?? [];
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <select className="input max-w-[14rem]" value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Class">
          <option value="">All classes</option>
          {(classes.data?.classes ?? []).map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input className="input max-w-xs" placeholder="Name, email or admission no." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-ghost">Search</button>
      </form>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <Spinner /> : <StudentTable rows={rows} />}
    </div>
  );
}

function StudentTable({ rows, showClasses = true }: { rows: any[]; showClasses?: boolean }) {
  if (!rows.length) return <Empty title="No students" icon="heart">Students appear here once they join and are enrolled in a class.</Empty>;
  return (
    <div className="card p-0">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="pl-5">Student</th>
              <th>Admission no.</th>
              {showClasses && <th>Class</th>}
              <th>Guardian</th>
              <th className="text-right">Attendance</th>
              <th className="pr-5 text-right">Marks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.student_id}>
                <td className="pl-5">
                  <Link to={`/directory/students/${s.student_id}`} className="flex items-center gap-2.5">
                    <Avatar name={s.name} size={30} />
                    <div>
                      <p className="font-semibold text-slate-900 hover:text-brand">{s.name}</p>
                      <p className="text-xs text-slate-500">{s.email}</p>
                    </div>
                  </Link>
                </td>
                <td>{s.admission_no || "—"}</td>
                {showClasses && <td>{s.classes?.map((c: any) => c.name).join(", ") || <span className="text-slate-400">Not enrolled</span>}</td>}
                <td>
                  <p>{s.guardian_name || "—"}</p>
                  {s.guardian_phone && <p className="text-xs text-slate-500">{s.guardian_phone}</p>}
                </td>
                <td className="text-right">
                  <Badge tone={toneForPercent(s.attendance_rate)}>{pct100(s.attendance_rate)}</Badge>
                </td>
                <td className="pr-5 text-right">
                  {s.percent == null ? "—" : (
                    <span className="font-semibold">
                      {pct100(s.percent)} <span className="text-xs text-slate-500">{s.grade}</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AllDocuments() {
  const list = useApi<any>("/directory/documents");
  const [q, setQ] = useState("");
  const rows: any[] = (list.data?.documents ?? []).filter((d: any) => !q || `${d.title} ${d.category} ${d.owner_name} ${d.file_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="text-sm text-slate-500">Upload documents from a student's or staff member's profile.</p>
      </div>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title="No documents yet" icon="folder">Open a student or staff profile and upload certificates, ID proofs or records.</Empty>
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Document</th>
                  <th>Belongs to</th>
                  <th>Category</th>
                  <th>Who can see</th>
                  <th>Uploaded</th>
                  <th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="pl-5">
                      <p className="font-semibold text-slate-900">{d.title}</p>
                      <p className="text-xs text-slate-500">
                        {d.file_name} · {fileSize(d.size_bytes)}
                      </p>
                    </td>
                    <td>
                      <Link className="hover:text-brand" to={d.owner_type === "student" ? `/directory/students/${d.student_id}` : `/directory/staff/${d.staff_id}`}>
                        {d.owner_name}
                      </Link>
                      <p className="text-xs text-slate-500">{d.owner_type === "student" ? "Student" : "Staff"}</p>
                    </td>
                    <td>{d.category}</td>
                    <td>
                      <VisibilityBadge v={d.visibility} />
                    </td>
                    <td>
                      {fmtDate(d.created_at)}
                      <p className="text-xs text-slate-500">{d.uploaded_by_name}</p>
                    </td>
                    <td className="pr-5">
                      <FileButtons doc={d} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DirectorySettings() {
  const s = useApi<any>("/directory/settings");
  const [form, setForm] = useState<any>(null);
  const [newCat, setNewCat] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = form ?? s.data?.settings;
  if (s.loading && !s.data) return <Spinner />;
  if (!v) return <ErrorNote message={s.error} />;
  const set = (patch: any) => {
    setForm({ ...v, ...patch });
    setMsg(null);
  };
  const save = async () => {
    setErr(null);
    try {
      const r = await api("/directory/settings", { method: "PUT", body: v });
      setForm(r.settings);
      setMsg("Settings saved.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const Toggle = ({ k, label, hint }: { k: string; label: string; hint: string }) => (
    <label className="flex items-start gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-brand" checked={!!v[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="What teachers can do" icon="shield">
        <div className="space-y-3">
          <Toggle k="teachersCanViewDocuments" label="View student documents" hint="Teachers see documents marked “Teachers and admins” for students in their classes and activities." />
          <Toggle k="teachersCanUploadDocuments" label="Upload student documents" hint="Teachers can add documents to their students' profiles. They can delete only what they uploaded." />
          <Toggle k="teachersCanSeeContacts" label="See parent contact details" hint="Guardian phone, email and address on student profiles." />
        </div>
      </SectionCard>
      <SectionCard title="Uploads" icon="folder">
        <div className="space-y-4">
          <Field label="Largest file (MB)" hint="Between 1 and 10 MB. PDF, images, Word, Excel and text files are accepted.">
            <input className="input max-w-[8rem]" type="number" min={1} max={10} value={v.maxUploadMb} onChange={(e) => set({ maxUploadMb: Number(e.target.value) })} />
          </Field>
          <div>
            <span className="label">Document categories</span>
            <div className="flex flex-wrap gap-1.5">
              {v.documentCategories.map((c: string) => (
                <span key={c} className="chip bg-slate-100 text-slate-700">
                  {c}
                  <button type="button" className="text-slate-400 hover:text-red-600" aria-label={`Remove ${c}`} onClick={() => set({ documentCategories: v.documentCategories.filter((x: string) => x !== c) })}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input className="input max-w-xs" placeholder="Add a category" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
              <button
                type="button"
                className="btn-ghost"
                disabled={!newCat.trim()}
                onClick={() => {
                  set({ documentCategories: [...v.documentCategories, newCat.trim()] });
                  setNewCat("");
                }}
              >
                <Icon name="plus" size={14} /> Add
              </button>
            </div>
          </div>
        </div>
      </SectionCard>
      <div className="space-y-3 lg:col-span-2">
        <ErrorNote message={err} />
        <SuccessNote message={msg} />
        <button className="btn" onClick={save}>
          <Icon name="check" size={16} /> Save settings
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Class detail: subjects, roster, class report, exam reports
// ---------------------------------------------------------------------------
export function DirectoryClassPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const admin = can("directory.manage");
  const d = useApi<any>(`/directory/classes/${id}`);
  const [tab, setTab] = useState<"subjects" | "students" | "report" | "exams">("subjects");
  const [editing, setEditing] = useState(false);
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <ErrorNote message={d.error} />;
  const { class: c, subjects, students, report, exams } = d.data;
  return (
    <div className="space-y-5">
      <BackLink />
      <PageTitle
        title={c.name}
        icon="graduation"
        subtitle={[c.grade_number ? `Class ${c.grade_number}` : null, c.section ? `Section ${c.section}` : null, c.board, c.academic_year].filter(Boolean).join(" · ") || "Class"}
        action={
          <>
            <Link className="btn-ghost" to={`/report-card`}>
              <Icon name="printer" size={16} /> Report cards
            </Link>
            {admin && (
              <button className="btn-ghost" onClick={() => setEditing(true)}>
                <Icon name="sliders" size={16} /> Edit section
              </button>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Students" value={students.length} icon="users" hint={`Class teacher: ${c.class_teacher}`} />
        <StatCard label="Attendance" value={pct100(report.attendance.rate)} icon="checkSquare" tone={toneForPercent(report.attendance.rate)} hint={`${report.attendance.days} days marked`} />
        <StatCard label="Class average" value={pct100(report.average)} icon="chart" tone={toneForPercent(report.average)} hint="Across the gradebook" />
        <StatCard label="Homework handed in" value={report.assignments.expected ? pct100((report.assignments.submissions / report.assignments.expected) * 100) : "—"} icon="clipboard" tone="sky" hint={`${report.assignments.total} assignments`} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "subjects", label: `Subjects & books (${subjects.length})` },
          { value: "students", label: `Students (${students.length})` },
          { value: "report", label: "Class report" },
          { value: "exams", label: `Exam reports (${exams.length})` },
        ]}
      />
      {tab === "subjects" && <SubjectList cls={c} subjects={subjects} onChange={d.reload} />}
      {tab === "students" && <StudentTable rows={students} showClasses={false} />}
      {editing && <EditSection c={c} onClose={() => setEditing(false)} onSaved={d.reload} />}
      {tab === "report" && <ClassReport items={report.gradeItems} />}
      {tab === "exams" && <ExamReports exams={exams} students={students} />}
    </div>
  );
}

const BOOK_KINDS: Record<string, string> = { textbook: "Textbook", workbook: "Workbook", reference: "Reference", lab_manual: "Lab manual", other: "Other" };
const CHAPTER_TONE: Record<string, Tone> = { completed: "green", in_progress: "amber", planned: "slate" };

function SubjectList({ cls, subjects, onChange }: { cls: any; subjects: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const admin = can("directory.manage");
  const staff = useApi<any>(admin ? "/directory/staff" : null);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const addSubject = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`/academics/classes/${cls.id}/subjects`, { body: { subject: adding.trim() } });
      setAdding("");
      onChange();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      {!subjects.length && <Empty title="No subjects yet" icon="book">{admin ? "Add the subjects taught in this section below." : "The principal hasn't added subjects to this section yet."}</Empty>}
      {subjects.map((s) => (
        <SubjectCard key={s.id} cls={cls} s={s} admin={admin} teachers={staff.data?.staff ?? []} onChange={onChange} />
      ))}
      {admin && (
        <form className="card flex flex-wrap items-end gap-2" onSubmit={addSubject}>
          <Field label="Add a subject">
            <input className="input min-w-[14rem]" value={adding} placeholder="e.g. Computer Science" onChange={(e) => setAdding(e.target.value)} />
          </Field>
          <button className="btn" disabled={!adding.trim()}>
            <Icon name="plus" size={16} /> Add
          </button>
          <div className="w-full">
            <ErrorNote message={err} />
          </div>
        </form>
      )}
    </div>
  );
}

function SubjectCard({ cls, s, admin, teachers, onChange }: { cls: any; s: any; admin: boolean; teachers: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const editBooks = can("directory.manage") || can("academics.manage");
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = s.chapters.filter((u: any) => u.status === "completed").length;
  const current = s.chapters.find((u: any) => u.status !== "completed");
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <section className="card animate-fade-up">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <Icon name="book" size={20} />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{s.subject}</h3>
            <p className="text-sm text-slate-500">
              {s.teacher ?? "No teacher assigned"} · {s.periods_per_week} periods a week
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {admin && (
            <select
              className="input w-auto"
              value={s.teacher_id ?? ""}
              aria-label={`Teacher for ${s.subject}`}
              onChange={(e) => run(() => api(`/academics/class-subjects/${s.id}`, { method: "PATCH", body: { teacherId: e.target.value || null } }))}
            >
              <option value="">No teacher</option>
              {teachers
                .filter((t) => t.roles.some((r: string) => ["teacher", "tenant_admin", "tenant_owner"].includes(r)))
                .map((t) => (
                  <option key={t.user_id} value={t.user_id}>
                    {t.name}
                  </option>
                ))}
            </select>
          )}
          {s.units > 0 && (
            <Link className="btn-ghost btn-sm" to={`/academics/plan/${s.id}`}>
              <Icon name="calendar" size={14} /> Syllabus plan
            </Link>
          )}
          {admin && (
            <button className="btn-danger btn-sm" aria-label={`Remove ${s.subject}`} onClick={() => confirm(`Remove ${s.subject} from ${cls.name}? Its syllabus plan for this section is deleted too.`) && run(() => api(`/academics/class-subjects/${s.id}`, { method: "DELETE" }))}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>
      <ErrorNote message={err} />
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="label mb-0">Books</p>
            {editBooks && cls.grade && (
              <button className="text-xs font-semibold text-brand" onClick={() => setBook({})}>
                + Add book
              </button>
            )}
          </div>
          {!s.books.length ? (
            <p className="text-sm text-slate-500">{cls.grade ? `No books listed for ${cls.grade} ${s.subject}.` : "Set this section's grade in Academic setup to list books."}</p>
          ) : (
            <ul className="space-y-2">
              {s.books.map((b: any) => (
                <li key={b.id} className="flex items-start gap-3 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                  <span className="mt-0.5 text-amber-600">
                    <Icon name="book" size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900">{b.title}</p>
                    <p className="text-xs text-slate-500">
                      {[BOOK_KINDS[b.kind], b.author, b.publisher, b.isbn && `ISBN ${b.isbn}`].filter(Boolean).join(" · ")}
                    </p>
                    {b.note && <p className="mt-1 text-xs text-slate-600">{b.note}</p>}
                    {b.library_book_id && (
                      <p className="mt-1 text-xs">
                        <Badge tone={b.library_available > 0 ? "green" : "red"}>
                          Library: {b.library_available > 0 ? `${b.library_available} available` : "all issued"}
                          {b.library_shelf && ` · shelf ${b.library_shelf}`}
                        </Badge>
                      </p>
                    )}
                  </div>
                  {editBooks && (
                    <button className="btn-ghost btn-sm" onClick={() => setBook(b)} aria-label={`Edit ${b.title}`}>
                      <Icon name="sliders" size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-slate-400">Books are shared by every section of {cls.grade ?? "this class"}.</p>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="label mb-0">Syllabus</p>
            {s.chapters.length > 0 && (
              <span className="text-xs text-slate-500">
                {done}/{s.chapters.length} chapters done
              </span>
            )}
          </div>
          {!s.chapters.length ? (
            <p className="text-sm text-slate-500">
              No syllabus linked.{" "}
              {can("academics.manage") && (
                <Link className="text-brand" to="/academics/setup">
                  Add one in Academic setup
                </Link>
              )}
            </p>
          ) : (
            <>
              <Progress value={(done / s.chapters.length) * 100} tone="green" />
              {current && (
                <p className="mt-2 text-xs text-slate-600">
                  Now: <span className="font-semibold">{current.title}</span>
                  {current.planned_end && ` · due ${fmtDate(current.planned_end)}`}
                </p>
              )}
              {s.syllabus_source && <p className="mt-1 text-[11px] text-slate-400">{s.syllabus_source}</p>}
              <button className="mt-2 text-xs font-semibold text-brand" onClick={() => setOpen(!open)}>
                {open ? "Hide chapters" : `Show all ${s.chapters.length} chapters`}
              </button>
              {open && (
                <ol className="mt-2 divide-y divide-slate-100 text-sm">
                  {s.chapters.map((u: any) => (
                    <li key={u.id} className="flex items-start justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">
                          {u.sequence}. {u.title}
                        </p>
                        {u.topics && <p className="text-xs text-slate-500">{u.topics}</p>}
                        <p className="text-[11px] text-slate-400">
                          {u.planned_start ? `${fmtDate(u.planned_start)} – ${fmtDate(u.planned_end)}` : "Not scheduled"}
                          {u.term_sequence && ` · Term ${u.term_sequence}`} · {u.est_periods} periods
                        </p>
                      </div>
                      <Badge tone={CHAPTER_TONE[u.status]}>{u.status.replace("_", " ")}</Badge>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
      {book && <BookForm book={book} cls={cls} subject={s.subject} onClose={() => setBook(null)} onSaved={onChange} />}
    </section>
  );
}

function BookForm({ book, cls, subject, onClose, onSaved }: { book: any; cls: any; subject: string; onClose: () => void; onSaved: () => void }) {
  const library = useApi<any>("/library/books");
  const [f, setF] = useState({
    title: book.title ?? "",
    kind: book.kind ?? "textbook",
    author: book.author ?? "",
    publisher: book.publisher ?? "",
    isbn: book.isbn ?? "",
    note: book.note ?? "",
    libraryBookId: book.library_book_id ?? "",
    sequence: book.sequence ?? 1,
  });
  const [err, setErr] = useState<string | null>(null);
  const body = { ...f, grade: book.grade ?? cls.grade, subject: book.subject ?? subject, board: book.id ? book.board : null, libraryBookId: f.libraryBookId || null, isbn: f.isbn || null };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(book.id ? `/directory/books/${book.id}` : "/directory/books", { method: book.id ? "PUT" : "POST", body });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${book.title} from ${body.grade} ${body.subject}?`)) return;
    try {
      await api(`/directory/books/${book.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const books: any[] = library.data?.books ?? [];
  return (
    <Modal open onClose={onClose} title={book.id ? "Edit book" : `Add a book · ${body.grade} ${body.subject}`}>
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Title">
          <input className="input" required value={f.title} placeholder="e.g. Science — Textbook for Class VIII" onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(BOOK_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Publisher">
            <input className="input" value={f.publisher} placeholder="NCERT" onChange={(e) => setF({ ...f, publisher: e.target.value })} />
          </Field>
          <Field label="Author">
            <input className="input" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />
          </Field>
          <Field label="ISBN">
            <input className="input" value={f.isbn} onChange={(e) => setF({ ...f, isbn: e.target.value })} />
          </Field>
        </div>
        <Field label="Library copy" hint="Link a library title to show how many copies are available">
          <select className="input" value={f.libraryBookId} onChange={(e) => setF({ ...f, libraryBookId: e.target.value })}>
            <option value="">Not in the library</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
                {b.author && ` — ${b.author}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <input className="input" value={f.note} placeholder="e.g. Chapters 1–8 for Term 1" onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        <ErrorNote message={err} />
        <div className="flex justify-between gap-2">
          {book.id ? (
            <button type="button" className="btn-danger" onClick={remove}>
              <Icon name="trash" size={14} /> Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function EditSection({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const staff = useApi<any>("/directory/staff");
  const [name, setName] = useState(c.name);
  const [teacherId, setTeacherId] = useState(c.teacher_id);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/directory/classes/${c.id}`, { method: "PATCH", body: { name, classTeacherId: teacherId } });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete section ${c.name}? Only empty sections can be deleted.`)) return;
    try {
      await api(`/directory/classes/${c.id}`, { method: "DELETE" });
      history.back();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${c.name}`}>
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Name">
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Class teacher">
          <select className="input" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            {!(staff.data?.staff ?? []).some((s: any) => s.user_id === teacherId) && <option value={teacherId}>{c.class_teacher}</option>}
            {(staff.data?.staff ?? []).map((s: any) => (
              <option key={s.user_id} value={s.user_id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-slate-500">Board, grade, section and academic year are set in Academic setup.</p>
        <ErrorNote message={err} />
        <div className="flex justify-between gap-2">
          <button type="button" className="btn-danger" onClick={remove}>
            <Icon name="trash" size={14} /> Delete section
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ClassReport({ items }: { items: any[] }) {
  if (!items.length) return <Empty title="No marks yet" icon="chart">Tests, projects and exam papers entered in the gradebook show up here.</Empty>;
  return (
    <div className="card p-0">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="pl-5">Assessment</th>
              <th>Term</th>
              <th>Date</th>
              <th className="text-right">Max</th>
              <th className="text-right">Marked</th>
              <th className="text-right">Average</th>
              <th className="pr-5 text-right">Highest</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td className="pl-5">
                  <p className="font-semibold text-slate-900">{i.title}</p>
                  <p className="text-xs capitalize text-slate-500">{i.category}</p>
                </td>
                <td>{i.term}</td>
                <td>{fmtDate(i.date)}</td>
                <td className="text-right">{i.max_marks}</td>
                <td className="text-right">{i.scored}</td>
                <td className="text-right">
                  <Badge tone={toneForPercent(i.average_percent)}>{pct100(i.average_percent)}</Badge>
                </td>
                <td className="pr-5 text-right">{i.highest ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExamReports({ exams, students }: { exams: any[]; students: any[] }) {
  const names = new Map(students.map((s) => [s.student_id, s.name]));
  const [open, setOpen] = useState<string | null>(exams[0]?.id ?? null);
  if (!exams.length) return <Empty title="No exams yet" icon="file">Exams published with papers for this class appear here.</Empty>;
  return (
    <div className="space-y-3">
      {exams.map((e) => (
        <div key={e.id} className="card">
          <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <div>
              <p className="font-semibold text-slate-900">{e.name}</p>
              <p className="text-xs text-slate-500">
                {e.term} · {e.subjects.join(", ")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={e.status === "completed" ? "green" : "amber"}>{e.status === "completed" ? "Results declared" : "In progress"}</Badge>
              <Badge tone="slate">Average {pct100(e.summary.average)}</Badge>
              <Badge tone="green">{e.summary.passed} passed</Badge>
              {e.summary.failed > 0 && <Badge tone="red">{e.summary.failed} failed</Badge>}
              <Icon name="chevronDown" size={16} className={`text-slate-400 transition ${open === e.id ? "rotate-180" : ""}`} />
            </div>
          </button>
          {open === e.id && (
            <div className="-mx-5 mt-4 overflow-x-auto border-t border-slate-100">
              <table className="table">
                <thead>
                  <tr>
                    <th className="pl-5">Student</th>
                    {e.subjects.map((s: string) => (
                      <th key={s} className="text-right">
                        {s}
                      </th>
                    ))}
                    <th className="text-right">Total</th>
                    <th className="text-right">%</th>
                    <th className="pr-5">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...e.students]
                    .sort((a: any, b: any) => (b.percent ?? -1) - (a.percent ?? -1))
                    .map((s: any) => (
                      <tr key={s.student_id}>
                        <td className="pl-5">
                          <Link className="font-semibold text-slate-900 hover:text-brand" to={`/directory/students/${s.student_id}`}>
                            {names.get(s.student_id)}
                          </Link>
                        </td>
                        {e.subjects.map((sub: string) => {
                          const p = s.papers.find((x: any) => x.subject === sub);
                          return (
                            <td key={sub} className={`text-right ${p?.passed === false ? "font-semibold text-red-600" : ""}`}>
                              {p?.marks ?? "—"}
                              {p && <span className="text-xs text-slate-400">/{p.max}</span>}
                            </td>
                          );
                        })}
                        <td className="text-right">
                          {s.total}/{s.max}
                        </td>
                        <td className="text-right font-semibold">{pct100(s.percent)}</td>
                        <td className="pr-5">
                          <Badge tone={RESULT_TONE[s.result]}>{s.result}</Badge>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Student profile
// ---------------------------------------------------------------------------
export function DirectoryStudentPage() {
  const { id } = useParams();
  const d = useApi<any>(`/directory/students/${id}`);
  const [tab, setTab] = useState<"overview" | "marks" | "exams" | "documents">("overview");
  const [editing, setEditing] = useState(false);
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <ErrorNote message={d.error} />;
  const { student: s, parents, classes, attendance, marks, overall, exams, assignments, activities, documents, permissions } = d.data;
  return (
    <div className="space-y-5">
      <BackLink />
      <div className="card flex flex-wrap items-center gap-4 animate-fade-up">
        <Avatar name={s.name} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold text-slate-900">{s.name}</h1>
          <p className="text-sm text-slate-500">
            {classes.map((c: any) => c.name).join(", ") || "Not enrolled in a class"}
            {s.admission_no && ` · Admission no. ${s.admission_no}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-ghost" to={`/report-card?studentId=${s.id}`}>
            <Icon name="printer" size={16} /> Report card
          </Link>
          {permissions.edit && (
            <button className="btn" onClick={() => setEditing(true)}>
              <Icon name="sliders" size={16} /> Edit profile
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Attendance" value={pct100(attendance.rate)} icon="checkSquare" tone={toneForPercent(attendance.rate)} hint={`${attendance.absent} absent · ${attendance.late} late`} />
        <StatCard label="Overall marks" value={pct100(overall.percent)} icon="chart" tone={toneForPercent(overall.percent)} hint={overall.grade ? `Grade ${overall.grade}` : "No marks yet"} />
        <StatCard label="Homework" value={`${assignments.submitted}/${assignments.total}`} icon="clipboard" tone="sky" hint={assignments.averagePercent != null ? `Average ${pct100(assignments.averagePercent)}` : "Submitted"} />
        <StatCard label="Activities" value={activities.length} icon="trophy" tone="amber" hint={activities.map((a: any) => a.name).join(", ") || "None yet"} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: "Profile" },
          { value: "marks", label: "Class reports" },
          { value: "exams", label: `Exam reports (${exams.length})` },
          { value: "documents", label: `Documents (${documents.length})` },
        ]}
      />
      {tab === "overview" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Personal details" icon="file">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Detail label="Email">{s.email}</Detail>
              <Detail label="Admission no.">{s.admission_no}</Detail>
              <Detail label="Date of birth">{s.date_of_birth && fmtDate(s.date_of_birth, { day: "numeric", month: "short", year: "numeric" })}</Detail>
              <Detail label="Blood group">{s.blood_group}</Detail>
              <Detail label="Admitted on">{s.admitted_on && fmtDate(s.admitted_on, { day: "numeric", month: "short", year: "numeric" })}</Detail>
              <Detail label="Guardian">{s.guardian_name}</Detail>
              <Detail label="Guardian phone">{s.guardian_phone}</Detail>
              <Detail label="Address" wide>
                {s.address}
              </Detail>
            </dl>
          </SectionCard>
          <SectionCard title="Parents and guardians" icon="heart">
            {!parents.length ? (
              <p className="text-sm text-slate-500">No parent account linked.</p>
            ) : (
              <ul className="space-y-2">
                {parents.map((p: any) => (
                  <li key={p.id} className="flex items-center gap-3">
                    <Avatar name={p.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900">{p.name}</p>
                      <p className="text-xs capitalize text-slate-500">
                        {p.relationship}
                        {p.email && ` · ${p.email}`}
                      </p>
                    </div>
                    {p.consent_status !== "granted" && <Badge tone="amber">{p.consent_status}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard title="Classes and subjects" icon="book">
            <ul className="space-y-3">
              {classes.map((c: any) => (
                <li key={c.id}>
                  <p className="font-semibold text-slate-900">
                    {c.name} <span className="text-xs font-normal text-slate-500">· Class teacher {c.class_teacher}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.subjects.map((x: any) => (
                      <Badge key={x.subject} tone="sky">
                        {x.subject}
                        {x.teacher && ` · ${x.teacher}`}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
              {!classes.length && <p className="text-sm text-slate-500">Not enrolled in a class.</p>}
            </ul>
          </SectionCard>
          <SectionCard title="Sports and activities" icon="trophy">
            {!activities.length ? (
              <p className="text-sm text-slate-500">Not part of any sport, PT group or club yet.</p>
            ) : (
              <ul className="space-y-2">
                {activities.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-900">{a.name}</p>
                      <p className="text-xs text-slate-500">
                        {category(a.category).label}
                        {a.teacher && ` · ${a.teacher}`}
                        {a.schedule && ` · ${a.schedule}`}
                      </p>
                    </div>
                    {a.role !== "member" && <Badge tone="amber">{a.role}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard title="Recent absences" icon="alert" className="lg:col-span-2">
            {!attendance.recent.length ? (
              <p className="text-sm text-slate-500">No absences or late marks recorded.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {attendance.recent.map((a: any, i: number) => (
                  <li key={i} className="flex items-center justify-between py-2">
                    <span>
                      {fmtDate(a.date, { weekday: "short", day: "numeric", month: "short" })} · {a.class_name}
                      {a.note && <span className="text-slate-500"> — {a.note}</span>}
                    </span>
                    <Badge tone={a.status === "absent" ? "red" : a.status === "late" ? "amber" : "sky"}>{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
      {tab === "marks" && (
        <div className="space-y-4">
          {!marks.length && <Empty title="No classes" icon="chart" />}
          {marks.map((m: any) => (
            <SectionCard key={m.classId} title={m.name} icon="chart" action={m.percent != null && <Badge tone={toneForPercent(m.percent)}>{pct100(m.percent)} · {m.grade}</Badge>}>
              {!m.items.length ? (
                <p className="text-sm text-slate-500">No marks entered yet.</p>
              ) : (
                <div className="-mx-5 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="pl-5">Assessment</th>
                        <th>Term</th>
                        <th>Date</th>
                        <th className="text-right">Marks</th>
                        <th className="pr-5">Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.items.map((i: any) => (
                        <tr key={i.id}>
                          <td className="pl-5">
                            {i.title} <span className="text-xs capitalize text-slate-500">· {i.category}</span>
                          </td>
                          <td>{i.term}</td>
                          <td>{fmtDate(i.date)}</td>
                          <td className="text-right font-semibold">
                            {i.marks ?? "—"}
                            <span className="text-xs font-normal text-slate-400">/{i.max_marks}</span>
                          </td>
                          <td className="pr-5 text-slate-500">{i.remarks || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ))}
        </div>
      )}
      {tab === "exams" && (
        <div className="space-y-4">
          {!exams.length && <Empty title="No exams yet" icon="file">Published exams with papers for this student's classes show here.</Empty>}
          {exams.map((e: any) => (
            <SectionCard
              key={e.id}
              title={`${e.name} · ${e.term}`}
              icon="file"
              action={
                e.result && (
                  <div className="flex gap-1.5">
                    <Badge tone={toneForPercent(e.result.percent)}>
                      {pct100(e.result.percent)}
                      {e.result.grade && ` · ${e.result.grade}`}
                    </Badge>
                    <Badge tone={RESULT_TONE[e.result.result]}>{e.result.result}</Badge>
                  </div>
                )
              }
            >
              {e.result && (
                <div className="-mx-5 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="pl-5">Subject</th>
                        <th className="text-right">Marks</th>
                        <th className="text-right">Pass mark</th>
                        <th className="pr-5">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.result.papers.map((p: any) => (
                        <tr key={p.paperId}>
                          <td className="pl-5">{p.subject}</td>
                          <td className="text-right font-semibold">
                            {p.marks ?? "—"}
                            <span className="text-xs font-normal text-slate-400">/{p.max}</span>
                          </td>
                          <td className="text-right">{p.pass ?? "—"}</td>
                          <td className="pr-5">{p.passed == null ? "—" : <Badge tone={p.passed ? "green" : "red"}>{p.passed ? "pass" : "fail"}</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-slate-500">Class average {pct100(e.classAverage)} · {e.status === "completed" ? "Results declared" : "Results not yet declared to families"}</p>
            </SectionCard>
          ))}
        </div>
      )}
      {tab === "documents" &&
        (permissions.viewDocuments ? (
          <DocumentsPanel ownerType="student" ownerId={s.id} documents={documents} canUpload={permissions.uploadDocuments} admin={permissions.edit} onChange={d.reload} />
        ) : (
          <Empty title="Documents are hidden" icon="shield">Your school has turned off document access for teachers.</Empty>
        ))}
      {editing && <EditStudent s={s} onClose={() => setEditing(false)} onSaved={d.reload} />}
    </div>
  );
}

const Detail = ({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) => (
  <div className={wide ? "col-span-2" : ""}>
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd className="font-medium text-slate-900">{children || "—"}</dd>
  </div>
);

function EditStudent({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    admissionNo: s.admission_no ?? "",
    dateOfBirth: s.date_of_birth ?? "",
    bloodGroup: s.blood_group ?? "",
    guardianName: s.guardian_name ?? "",
    guardianPhone: s.guardian_phone ?? "",
    address: s.address ?? "",
    admittedOn: s.admitted_on ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/directory/students/${s.id}`, { method: "PATCH", body: { ...f, dateOfBirth: f.dateOfBirth || null, admittedOn: f.admittedOn || null } });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const input = (k: keyof typeof f, type = "text") => <input className="input" type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />;
  return (
    <Modal open onClose={onClose} title={`Edit ${s.name}`}>
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Admission no.">{input("admissionNo")}</Field>
          <Field label="Blood group">{input("bloodGroup")}</Field>
          <Field label="Date of birth">{input("dateOfBirth", "date")}</Field>
          <Field label="Admitted on">{input("admittedOn", "date")}</Field>
          <Field label="Guardian name">{input("guardianName")}</Field>
          <Field label="Guardian phone">{input("guardianPhone", "tel")}</Field>
        </div>
        <Field label="Address">
          <textarea className="input" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <ErrorNote message={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Staff profile
// ---------------------------------------------------------------------------
export function DirectoryStaffPage() {
  const { userId } = useParams();
  const { can } = useAuth();
  const d = useApi<any>(`/directory/staff/${userId}`);
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <ErrorNote message={d.error} />;
  const { staff: s, timetable, documents } = d.data;
  const admin = can("directory.manage");
  return (
    <div className="space-y-5">
      <BackLink />
      <div className="card flex flex-wrap items-center gap-4 animate-fade-up">
        <Avatar name={s.name} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold text-slate-900">{s.name}</h1>
          <p className="text-sm text-slate-500">
            {[s.designation, s.department, s.roles.map((r: string) => ROLE[r] ?? r).join(", ")].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Badge tone={s.status === "active" ? "green" : s.status === "left" ? "red" : "amber"}>{s.status.replace("_", " ")}</Badge>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Details" icon="file" action={can("payroll.manage") && <Link className="text-xs font-semibold text-brand" to="/staff">Edit in Staff & payroll</Link>}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Detail label="Email">{s.email}</Detail>
            <Detail label="Phone">{s.phone}</Detail>
            <Detail label="Employee code">{s.employee_code}</Detail>
            <Detail label="Joined">{s.date_joined && fmtDate(s.date_joined, { day: "numeric", month: "short", year: "numeric" })}</Detail>
            <Detail label="Blood group">{s.blood_group}</Detail>
          </dl>
        </SectionCard>
        <SectionCard title="Classes and subjects" icon="book">
          {!s.subjects.length && !s.class_teacher_of.length ? (
            <p className="text-sm text-slate-500">Not assigned to any class or subject.</p>
          ) : (
            <div className="space-y-3">
              {s.class_teacher_of.length > 0 && (
                <div>
                  <span className="label">Class teacher of</span>
                  <div className="flex flex-wrap gap-1">
                    {s.class_teacher_of.map((c: any) => (
                      <Link key={c.id} to={`/directory/classes/${c.id}`}>
                        <Badge tone="brand">{c.name}</Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {s.subjects.length > 0 && (
                <div>
                  <span className="label">Teaches</span>
                  <div className="flex flex-wrap gap-1">
                    {s.subjects.map((x: any) => (
                      <Link key={x.id} to={`/directory/classes/${x.classId}`}>
                        <Badge tone="sky">
                          {x.className} · {x.subject}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </SectionCard>
        <SectionCard title="Sports and activities in charge" icon="trophy">
          {!s.activities.length ? (
            <p className="text-sm text-slate-500">None.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {s.activities.map((a: any) => (
                <Link key={a.id} to={`/directory/activities/${a.id}`}>
                  <Badge tone={category(a.category).tone}>{a.name}</Badge>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>
        <SectionCard title="Weekly timetable" icon="clock">
          {!timetable.length ? (
            <p className="text-sm text-slate-500">No periods in the timetable.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {timetable.map((t: any, i: number) => (
                <li key={i} className="flex justify-between py-1.5">
                  <span>
                    <span className="inline-block w-10 font-semibold text-slate-700">{DAYS[t.day_of_week - 1]}</span>
                    {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)}
                  </span>
                  <span className="text-slate-600">
                    {t.class_name} · {t.subject}
                    {t.room && ` · ${t.room}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
      <SectionCard title="Documents" icon="folder">
        <DocumentsPanel ownerType="staff" ownerId={s.user_id} documents={documents} canUpload={admin} admin={admin} onChange={d.reload} bare />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents: upload, view, download, control who sees them
// ---------------------------------------------------------------------------
const VisibilityBadge = ({ v }: { v: string }) => (v === "admin" ? <Badge tone="red">Principal & admins</Badge> : <Badge tone="green">Teachers & admins</Badge>);

async function openFile(doc: any, download: boolean) {
  const blob = await apiBlob(`/directory/documents/${doc.id}/file`);
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.file_name;
    a.click();
  } else {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function FileButtons({ doc }: { doc: any }) {
  const [err, setErr] = useState<string | null>(null);
  const run = (download: boolean) => openFile(doc, download).catch((e) => setErr((e as Error).message));
  return (
    <div className="flex justify-end gap-1.5">
      <button className="btn-ghost btn-sm" onClick={() => run(false)} title={err ?? "Open"}>
        <Icon name="monitor" size={14} /> View
      </button>
      <button className="btn-ghost btn-sm" onClick={() => run(true)} aria-label={`Download ${doc.title}`}>
        <Icon name="arrowRight" size={14} className="rotate-90" />
      </button>
    </div>
  );
}

function DocumentsPanel({ ownerType, ownerId, documents, canUpload, admin, onChange, bare }: { ownerType: "student" | "staff"; ownerId: string; documents: any[]; canUpload: boolean; admin: boolean; onChange: () => void; bare?: boolean }) {
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (d: any) => {
    setErr(null);
    try {
      await api(`/directory/documents/${d.id}`, { method: "PATCH", body: { visibility: d.visibility === "admin" ? "staff" : "admin" } });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (d: any) => {
    if (!confirm(`Delete “${d.title}”? This can't be undone.`)) return;
    setErr(null);
    try {
      await api(`/directory/documents/${d.id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const body = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{documents.length ? `${documents.length} document${documents.length > 1 ? "s" : ""}` : "No documents yet."}</p>
        {canUpload && (
          <button className="btn" onClick={() => setUploading(true)}>
            <Icon name="plus" size={16} /> Upload document
          </button>
        )}
      </div>
      <ErrorNote message={err} />
      {documents.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Icon name="file" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900">{d.title}</p>
                <p className="text-xs text-slate-500">
                  {d.category} · {d.file_name} · {fileSize(d.size_bytes)} · {fmtDate(d.created_at)} by {d.uploaded_by_name}
                </p>
              </div>
              {admin ? (
                <button className="cursor-pointer" onClick={() => toggle(d)} title="Change who can see this">
                  <VisibilityBadge v={d.visibility} />
                </button>
              ) : (
                <VisibilityBadge v={d.visibility} />
              )}
              <FileButtons doc={d} />
              {(admin || d.uploaded_by === user?.id) && (
                <button className="btn-danger btn-sm" onClick={() => remove(d)} aria-label={`Delete ${d.title}`}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {uploading && <UploadDocument ownerType={ownerType} ownerId={ownerId} admin={admin} onClose={() => setUploading(false)} onDone={onChange} />}
    </div>
  );
  return bare ? body : <div className="card">{body}</div>;
}

function UploadDocument({ ownerType, ownerId, admin, onClose, onDone }: { ownerType: string; ownerId: string; admin: boolean; onClose: () => void; onDone: () => void }) {
  const settings = useApi<any>("/directory/settings");
  const cats: string[] = settings.data?.settings.documentCategories ?? ["Other"];
  const maxMb: number = settings.data?.settings.maxUploadMb ?? 5;
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [cat, setCat] = useState("");
  const [visibility, setVisibility] = useState("staff");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (file.size > maxMb * 1024 * 1024) return setErr(`Files can be at most ${maxMb} MB`);
    setBusy(true);
    setErr(null);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("Could not read the file"));
        r.readAsDataURL(file);
      });
      await api("/directory/documents", {
        body: { ownerType, ownerId, title: title.trim() || file.name, category: cat || cats[0], visibility, fileName: file.name, mimeType: file.type || "application/octet-stream", data },
      });
      onDone();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Upload document">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="File" hint={`PDF, image, Word, Excel or text · up to ${maxMb} MB`}>
          <input
            className="input"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.doc,.docx,.xls,.xlsx"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </Field>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Category">
          <select className="input" value={cat || cats[0]} onChange={(e) => setCat(e.target.value)}>
            {cats.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {admin && (
          <Field label="Who can see it">
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="staff">Teachers and admins</option>
              <option value="admin">Principal and admins only</option>
            </select>
          </Field>
        )}
        <ErrorNote message={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!file || busy}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sports, PT and co-curricular activities
// ---------------------------------------------------------------------------
function ActivityList() {
  const list = useApi<any>("/directory/activities");
  const [editing, setEditing] = useState<any>(null);
  const rows: any[] = list.data?.activities ?? [];
  return (
    <div className="space-y-4">
      {list.data?.canManage && (
        <button className="btn" onClick={() => setEditing({})}>
          <Icon name="plus" size={16} /> New activity
        </button>
      )}
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title="No activities yet" icon="trophy">Add sports teams, PT groups, clubs and arts, and choose a teacher in charge.</Empty>
      ) : (
        <ActivityCards rows={rows} onEdit={list.data?.canManage ? setEditing : undefined} />
      )}
      {editing && <ActivityForm a={editing} onClose={() => setEditing(null)} onSaved={list.reload} />}
    </div>
  );
}

function ActivityCards({ rows, onEdit }: { rows: any[]; onEdit?: (a: any) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((a) => {
        const c = category(a.category);
        return (
          <div key={a.id} className="card flex flex-col gap-2">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <Icon name={c.icon} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <Link to={`/directory/activities/${a.id}`} className="font-semibold text-slate-900 hover:text-brand">
                  {a.name}
                </Link>
                <p className="text-xs text-slate-500">
                  {c.label} · {a.members} member{a.members === 1 ? "" : "s"}
                </p>
              </div>
              {onEdit && (
                <button className="btn-ghost btn-sm" onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`}>
                  <Icon name="sliders" size={14} />
                </button>
              )}
            </div>
            <p className="text-sm text-slate-600">
              <Icon name="users" size={14} className="mr-1 inline text-slate-400" />
              {a.teacher ?? "No teacher in charge"}
            </p>
            {(a.schedule || a.venue) && (
              <p className="text-sm text-slate-600">
                <Icon name="clock" size={14} className="mr-1 inline text-slate-400" />
                {[a.schedule, a.venue].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActivityForm({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const staff = useApi<any>("/directory/staff");
  const [f, setF] = useState({ name: a.name ?? "", category: a.category ?? "sport", teacherId: a.teacher_id ?? "", schedule: a.schedule ?? "", venue: a.venue ?? "", description: a.description ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, teacherId: f.teacherId || null };
      await api(a.id ? `/directory/activities/${a.id}` : "/directory/activities", { method: a.id ? "PATCH" : "POST", body });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete ${a.name} and its member list?`)) return;
    try {
      await api(`/directory/activities/${a.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={a.id ? `Edit ${a.name}` : "New activity"}>
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Name">
          <input className="input" required value={f.name} placeholder="e.g. Football U-14, PT – Class 6, Robotics club" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {ACTIVITY_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Teacher in charge">
            <select className="input" value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value })}>
              <option value="">Not assigned</option>
              {(staff.data?.staff ?? []).map((s: any) => (
                <option key={s.user_id} value={s.user_id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Schedule">
            <input className="input" value={f.schedule} placeholder="Mon, Wed 7:30–8:15" onChange={(e) => setF({ ...f, schedule: e.target.value })} />
          </Field>
          <Field label="Venue">
            <input className="input" value={f.venue} placeholder="Main ground" onChange={(e) => setF({ ...f, venue: e.target.value })} />
          </Field>
        </div>
        <Field label="Description">
          <textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <ErrorNote message={err} />
        <div className="flex justify-between gap-2">
          {a.id ? (
            <button type="button" className="btn-danger" onClick={remove}>
              <Icon name="trash" size={14} /> Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function DirectoryActivityPage() {
  const { id } = useParams();
  const d = useApi<any>(`/directory/activities/${id}`);
  const classes = useApi<any>("/directory/classes");
  const [classId, setClassId] = useState("");
  const [role, setRole] = useState("member");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <ErrorNote message={d.error} />;
  const { activity: a, members } = d.data;
  const c = category(a.category);
  const addClass = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      const r = await api(`/directory/activities/${a.id}/members`, { body: { classId, role } });
      setMsg(`${r.added} student${r.added === 1 ? "" : "s"} added.`);
      d.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const remove = async (studentId: string) => {
    try {
      await api(`/directory/activities/${a.id}/members/${studentId}`, { method: "DELETE" });
      d.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      <BackLink />
      <PageTitle title={a.name} icon={c.icon} subtitle={[c.label, a.teacher && `In charge: ${a.teacher}`, a.schedule, a.venue].filter(Boolean).join(" · ")} />
      {a.description && <p className="max-w-3xl text-sm text-slate-600">{a.description}</p>}
      <SectionCard title="Add students" icon="plus">
        <form className="flex flex-wrap items-end gap-2" onSubmit={addClass}>
          <Field label="From class">
            <select className="input min-w-[12rem]" required value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Choose a class</option>
              {(classes.data?.classes ?? []).map((x: any) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.students})
                </option>
              ))}
            </select>
          </Field>
          <Field label="As">
            <input className="input max-w-[10rem]" value={role} onChange={(e) => setRole(e.target.value)} />
          </Field>
          <button className="btn" disabled={!classId}>
            Add whole class
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">Add individual students from the list below, or add a whole class at once (for PT). Students already in the activity are kept.</p>
        <div className="mt-3 space-y-2">
          <ErrorNote message={err} />
          <SuccessNote message={msg} />
        </div>
      </SectionCard>
      <AddStudentPicker activityId={a.id} onAdded={d.reload} existing={new Set(members.map((m: any) => m.student_id))} />
      <SectionCard title={`Members (${members.length})`} icon="users">
        {!members.length ? (
          <p className="text-sm text-slate-500">No members yet.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Student</th>
                  <th>Class</th>
                  <th>Role</th>
                  <th>Joined</th>
                  <th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {members.map((m: any) => (
                  <tr key={m.student_id}>
                    <td className="pl-5">
                      <Link className="font-semibold text-slate-900 hover:text-brand" to={`/directory/students/${m.student_id}`}>
                        {m.name}
                      </Link>
                      {m.admission_no && <p className="text-xs text-slate-500">{m.admission_no}</p>}
                    </td>
                    <td>{m.classes || "—"}</td>
                    <td className="capitalize">{m.role}</td>
                    <td>{fmtDate(m.joined_at)}</td>
                    <td className="pr-5 text-right">
                      <button className="btn-danger btn-sm" onClick={() => remove(m.student_id)} aria-label={`Remove ${m.name}`}>
                        <Icon name="x" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function AddStudentPicker({ activityId, existing, onAdded }: { activityId: string; existing: Set<string>; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const list = useApi<any>(search ? `/directory/students?q=${encodeURIComponent(search)}` : null);
  const [err, setErr] = useState<string | null>(null);
  const add = async (studentId: string) => {
    try {
      await api(`/directory/activities/${activityId}/members`, { body: { studentIds: [studentId] } });
      onAdded();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <SectionCard title="Find a student" icon="heart">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <input className="input max-w-xs" placeholder="Name or admission no." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-ghost" disabled={!q.trim()}>
          Search
        </button>
      </form>
      <ErrorNote message={err ?? list.error} />
      {list.data && (
        <ul className="mt-3 divide-y divide-slate-100">
          {list.data.students.slice(0, 20).map((s: any) => (
            <li key={s.student_id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="font-semibold text-slate-900">{s.name}</span> <span className="text-slate-500">{s.classes.map((c: any) => c.name).join(", ")}</span>
              </span>
              {existing.has(s.student_id) ? (
                <Badge tone="green">Member</Badge>
              ) : (
                <button className="btn-ghost btn-sm" onClick={() => add(s.student_id)}>
                  <Icon name="plus" size={14} /> Add
                </button>
              )}
            </li>
          ))}
          {!list.data.students.length && <li className="py-2 text-sm text-slate-500">No students found.</li>}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Teacher: my classes, subjects and activities
// ---------------------------------------------------------------------------
export function MyClassesPage() {
  const d = useApi<any>("/directory/my-teaching");
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <ErrorNote message={d.error} />;
  const { subjects, classTeacherOf, activities } = d.data;
  const studentsTaught = new Map<string, number>();
  for (const s of subjects) studentsTaught.set(s.class_id, s.students);
  for (const c of classTeacherOf) studentsTaught.set(c.id, c.students);
  const bySubject = new Map<string, any[]>();
  for (const s of subjects) bySubject.set(s.subject, [...(bySubject.get(s.subject) ?? []), s]);
  return (
    <div className="space-y-5">
      <PageTitle title="My classes" icon="graduation" subtitle="The classes and subjects you were hired to teach, plus the sports, PT and activities you run." />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Subjects taught" value={bySubject.size} icon="book" hint={[...bySubject.keys()].join(", ") || "None assigned"} />
        <StatCard label="Class sections" value={studentsTaught.size} icon="layers" tone="sky" />
        <StatCard label="Students" value={[...studentsTaught.values()].reduce((t, n) => t + n, 0)} icon="users" tone="green" />
        <StatCard label="Activities in charge" value={activities.length} icon="trophy" tone="amber" />
      </div>
      {classTeacherOf.length > 0 && (
        <SectionCard title="Class teacher of" icon="star">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {classTeacherOf.map((c: any) => (
              <ClassCard key={c.id} c={{ ...c, class_teacher: "You" }} />
            ))}
          </div>
        </SectionCard>
      )}
      <SectionCard title="Subjects I teach" icon="book">
        {!subjects.length ? (
          <p className="text-sm text-slate-500">No subjects assigned yet. The principal assigns subjects in Academic setup.</p>
        ) : (
          <div className="space-y-4">
            {[...bySubject.entries()].map(([subject, rows]) => (
              <div key={subject}>
                <p className="label">{subject}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rows
                    .sort((a, b) => (a.grade_number ?? 99) - (b.grade_number ?? 99) || a.class_name.localeCompare(b.class_name))
                    .map((s) => (
                      <div key={s.id} className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
                        <div className="flex items-start justify-between gap-2">
                          <Link to={`/directory/classes/${s.class_id}`} className="font-semibold text-slate-900 hover:text-brand">
                            {s.class_name}
                          </Link>
                          <Badge tone="brand">{s.students} students</Badge>
                        </div>
                        <p className="text-xs text-slate-500">{s.periods_per_week} periods a week</p>
                        {s.units > 0 && (
                          <div className="mt-2">
                            <Progress value={(s.units_done / s.units) * 100} tone="green" />
                            <p className="mt-1 text-[11px] text-slate-500">
                              Syllabus {s.units_done}/{s.units} units
                            </p>
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <Link className="btn-ghost btn-sm" to={`/directory/classes/${s.class_id}`}>
                            Books, syllabus & students
                          </Link>
                          <Link className="btn-ghost btn-sm" to={`/academics/plan/${s.id}`}>
                            Syllabus plan
                          </Link>
                          <Link className="btn-ghost btn-sm" to="/attendance">
                            Attendance
                          </Link>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Sports, PT and co-curricular activities" icon="trophy">
        {!activities.length ? <p className="text-sm text-slate-500">You are not in charge of any activity.</p> : <ActivityCards rows={activities} />}
      </SectionCard>
    </div>
  );
}

const BackLink = () => (
  <button className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900" onClick={() => history.back()}>
    <Icon name="chevronLeft" size={16} /> Back
  </button>
);
