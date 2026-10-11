import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { Empty, ErrorNote, PageTitle, Spinner } from "../components/ui";

export function ParentPage() {
  const children = useApi("/parents/children");
  const versions = useApi("/curriculum/versions");
  const [form, setForm] = useState({ name: "", email: "", password: "", curriculumVersionId: "", relationship: "guardian" });
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/parents/children", { body: { ...form, curriculumVersionId: form.curriculumVersionId || versions.data?.versions[0]?.id } });
      setShowForm(false);
      setForm({ ...form, name: "", email: "", password: "" });
      children.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (children.loading) return <Spinner />;
  return (
    <div className="space-y-6">
      <PageTitle title="Children" subtitle="Progress, upcoming exams and weekly reports." action={<button className="btn" onClick={() => setShowForm(!showForm)}>+ Add child</button>} />
      {showForm && (
        <form onSubmit={add} className="card grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Child's name</label>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Syllabus</label>
            <select className="input" value={form.curriculumVersionId} onChange={(e) => setForm({ ...form, curriculumVersionId: e.target.value })}>
              {versions.data?.versions.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {v.board} {v.grade} ({v.academic_year})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Child's login email</label>
            <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Password for the child</label>
            <input className="input" type="password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <p className="text-xs text-slate-500 md:col-span-2">By adding your child you consent, as their guardian, to AI Gurukul processing their learning data to provide tutoring and reports. You can revoke this at any time.</p>
          <ErrorNote message={error} />
          <button className="btn md:col-span-2">Create student account</button>
        </form>
      )}
      {children.data?.children.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {children.data.children.map((c: any) => (
            <Link key={c.student_id} to={`/children/${c.student_id}`} className="card hover:ring-brand">
              <p className="text-lg font-medium">{c.name}</p>
              <p className="text-sm text-slate-500">{c.email}</p>
              <p className="mt-2 text-xs text-slate-400">Consent: {c.consent_status}</p>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="No children added yet">Add your child to create their student login and follow their progress.</Empty>
      )}
    </div>
  );
}
