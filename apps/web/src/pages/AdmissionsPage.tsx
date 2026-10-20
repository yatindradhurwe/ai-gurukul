import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, ErrorNote, Field, Modal, PageTitle, Spinner, SuccessNote, fmtDate, fmtDateTime, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useClasses } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STAGES: { id: string; label: string; tone: Tone; bar: string }[] = [
  { id: "enquiry", label: "Enquiry", tone: "sky", bar: "from-sky-400 to-sky-500" },
  { id: "applied", label: "Applied", tone: "brand", bar: "from-indigo-400 to-indigo-500" },
  { id: "interview", label: "Interview", tone: "amber", bar: "from-amber-400 to-amber-500" },
  { id: "offered", label: "Offered", tone: "green", bar: "from-emerald-400 to-emerald-500" },
  { id: "admitted", label: "Admitted", tone: "green", bar: "from-teal-400 to-emerald-600" },
  { id: "rejected", label: "Not admitted", tone: "red", bar: "from-rose-400 to-rose-500" },
];

export function AdmissionsPage() {
  const { tenant } = useAuth();
  const [search, setSearch] = useState("");
  const list = useApi<any>(`/admissions${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`);
  const [open, setOpen] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const apps: any[] = list.data?.applications ?? [];
  const link = `${window.location.origin}/apply/${tenant?.slug ?? ""}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Admissions"
        icon="graduation"
        subtitle="From first enquiry to admitted student."
        action={
          <>
            <button className="btn-ghost" onClick={copy}>
              <Icon name={copied ? "check" : "link"} size={16} /> {copied ? "Link copied" : "Copy public form link"}
            </button>
            <button className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> New application
            </button>
          </>
        }
      />
      <input className="input max-w-md" placeholder="Search by student, parent or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2">
          <div className="grid min-w-[72rem] grid-cols-6 gap-3">
            {STAGES.map((st) => {
              const items = apps.filter((a) => a.status === st.id);
              return (
                <div key={st.id} className="rounded-[1.6rem] bg-slate-100/70 p-2.5">
                  <div className="mb-2 flex items-center justify-between px-1.5 pt-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-600">{st.label}</p>
                    <span className="chip bg-white text-slate-600 shadow-sm">{list.data?.counts?.[st.id] ?? 0}</span>
                  </div>
                  <div className={`mb-2 h-1 rounded-full bg-gradient-to-r ${st.bar}`} />
                  <div className="space-y-2">
                    {items.map((a) => (
                      <button key={a.id} onClick={() => setOpen(a)} className="block w-full rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-md">
                        <div className="flex items-center gap-2">
                          <Avatar name={a.student_name} size={28} />
                          <p className="truncate text-sm font-semibold text-slate-900">{a.student_name}</p>
                        </div>
                        <p className="mt-1.5 text-xs text-slate-500">
                          {a.grade_applying} · {a.parent_name}
                        </p>
                        <div className="mt-2 flex items-center justify-between">
                          {a.source === "website" ? <Badge tone="sky">Online</Badge> : <Badge>Office</Badge>}
                          <span className="text-[10px] text-slate-400">{fmtDate(a.created_at)}</span>
                        </div>
                      </button>
                    ))}
                    {items.length === 0 && <p className="px-2 py-4 text-center text-xs text-slate-400">None</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {open && <ApplicationModal app={open} onClose={() => setOpen(null)} onChanged={() => (list.reload(), setOpen(null))} />}
      {adding && <ApplicationForm onClose={() => setAdding(false)} onSaved={list.reload} />}
    </div>
  );
}

function ApplicationModal({ app, onClose, onChanged }: { app: any; onClose: () => void; onChanged: () => void }) {
  const { classes } = useClasses();
  const [notes, setNotes] = useState(app.notes ?? "");
  const [admit, setAdmit] = useState({ studentEmail: "", password: "", classId: "", bloodGroup: "", createParent: true, parentPassword: "" });
  const [admitting, setAdmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const move = async (status: string) => {
    setError(null);
    try {
      await api(`/admissions/${app.id}`, { method: "PATCH", body: { status, notes } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  async function doAdmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api(`/admissions/${app.id}/admit`, {
        body: { ...admit, classId: admit.classId || null, bloodGroup: admit.bloodGroup || null, parentPassword: admit.createParent ? admit.parentPassword : null },
      });
      setDone(`Admitted with number ${r.admissionNo}.${r.parentLinked ? (r.parentCreated ? " A parent account was created." : " Linked to the existing parent account.") : ""}`);
      window.setTimeout(onChanged, 1800);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const stage = STAGES.find((s) => s.id === app.status)!;
  const final = app.status === "admitted";

  return (
    <Modal open onClose={onClose} title={app.student_name} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stage.tone}>{stage.label}</Badge>
          <span className="text-sm text-slate-500">
            Applying for <b>{app.grade_applying}</b>
            {app.date_of_birth && ` · born ${fmtDate(app.date_of_birth, { day: "numeric", month: "short", year: "numeric" })}`}
          </span>
        </div>
        <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
          <p>
            <span className="label">Parent</span>
            {app.parent_name}
          </p>
          <p>
            <span className="label">Contact</span>
            <a className="text-brand" href={`tel:${app.parent_phone}`}>
              {app.parent_phone}
            </a>{" "}
            ·{" "}
            <a className="text-brand" href={`mailto:${app.parent_email}`}>
              {app.parent_email}
            </a>
          </p>
          {app.previous_school && (
            <p>
              <span className="label">Previous school</span>
              {app.previous_school}
            </p>
          )}
          {app.address && (
            <p>
              <span className="label">Address</span>
              {app.address}
            </p>
          )}
          {app.message && (
            <p className="sm:col-span-2">
              <span className="label">Message</span>“{app.message}”
            </p>
          )}
          <p className="text-xs text-slate-400 sm:col-span-2">Received {fmtDateTime(app.created_at)}</p>
        </div>
        {!final && (
          <>
            <Field label="Office notes">
              <textarea className="input min-h-[4rem]" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {STAGES.filter((s) => !["admitted", app.status].includes(s.id)).map((s) => (
                <button key={s.id} className={s.id === "rejected" ? "btn-danger btn-sm" : "btn-ghost btn-sm"} onClick={() => move(s.id)}>
                  Move to {s.label}
                </button>
              ))}
              {app.status !== "rejected" && (
                <button className="btn btn-sm ml-auto" onClick={() => setAdmitting(!admitting)}>
                  <Icon name="graduation" size={14} /> Admit
                </button>
              )}
            </div>
          </>
        )}
        {admitting && !final && (
          <form onSubmit={doAdmit} className="space-y-4 rounded-2xl bg-emerald-50/70 p-4 ring-1 ring-emerald-200">
            <p className="text-sm font-semibold text-emerald-800">Create {app.student_name}'s login</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Student email">
                <input className="input" type="email" required value={admit.studentEmail} onChange={(e) => setAdmit({ ...admit, studentEmail: e.target.value })} />
              </Field>
              <Field label="Starting password" hint="At least 8 characters; ask them to change it.">
                <input className="input" required minLength={8} value={admit.password} onChange={(e) => setAdmit({ ...admit, password: e.target.value })} />
              </Field>
              <Field label="Class">
                <select className="input" value={admit.classId} onChange={(e) => setAdmit({ ...admit, classId: e.target.value })}>
                  <option value="">Assign later</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Blood group (optional)">
                <input className="input" maxLength={5} value={admit.bloodGroup} onChange={(e) => setAdmit({ ...admit, bloodGroup: e.target.value })} placeholder="B+" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4" checked={admit.createParent} onChange={(e) => setAdmit({ ...admit, createParent: e.target.checked })} />
              Create a parent login for {app.parent_email} if they don't have one
            </label>
            {admit.createParent && (
              <Field label="Parent's starting password">
                <input className="input" minLength={8} required value={admit.parentPassword} onChange={(e) => setAdmit({ ...admit, parentPassword: e.target.value })} />
              </Field>
            )}
            <button className="btn">Admit student</button>
          </form>
        )}
        <SuccessNote message={done} />
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}

const EMPTY = { studentName: "", dateOfBirth: "", gradeApplying: "", parentName: "", parentEmail: "", parentPhone: "", address: "", previousSchool: "", message: "" };

function ApplicationFields({ form, setForm }: { form: typeof EMPTY; setForm: (f: typeof EMPTY) => void }) {
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Student's full name">
        <input className="input" required minLength={2} maxLength={120} value={form.studentName} onChange={set("studentName")} />
      </Field>
      <Field label="Date of birth">
        <input className="input" type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} />
      </Field>
      <Field label="Applying for">
        <input className="input" required maxLength={40} list="grades" value={form.gradeApplying} onChange={set("gradeApplying")} placeholder="e.g. Class 6" />
        <datalist id="grades">
          {["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)].map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
      <Field label="Previous school (optional)">
        <input className="input" maxLength={160} value={form.previousSchool} onChange={set("previousSchool")} />
      </Field>
      <Field label="Parent / guardian name">
        <input className="input" required minLength={2} maxLength={120} value={form.parentName} onChange={set("parentName")} />
      </Field>
      <Field label="Phone">
        <input className="input" type="tel" required minLength={6} maxLength={20} value={form.parentPhone} onChange={set("parentPhone")} />
      </Field>
      <Field label="Email">
        <input className="input" type="email" required value={form.parentEmail} onChange={set("parentEmail")} />
      </Field>
      <Field label="Address (optional)">
        <input className="input" maxLength={400} value={form.address} onChange={set("address")} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Anything else? (optional)">
          <textarea className="input min-h-[4rem]" maxLength={2000} value={form.message} onChange={set("message")} />
        </Field>
      </div>
    </div>
  );
}

const clean = (f: typeof EMPTY) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === "" && !["studentName", "gradeApplying", "parentName", "parentEmail", "parentPhone"].includes(k) ? null : v]));

function ApplicationForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/admissions", { body: clean(form) });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New application" wide>
      <form onSubmit={submit} className="space-y-4">
        <ApplicationFields form={form} setForm={setForm} />
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Save application</button>
        </div>
      </form>
    </Modal>
  );
}

/** Public admission form at /apply/:slug — no sign-in needed. */
export function PublicApplyPage() {
  const { slug } = useParams();
  const school = useApi<any>(`/public/admissions/${slug}`);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/public/admissions/${slug}`, { body: clean(form) });
      setRef(r.reference);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const s = school.data?.school;
  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand via-violet-500 to-fuchsia-500 text-white shadow-md">
            <Icon name="graduation" size={26} />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Admissions open</p>
            <h1 className="font-display text-3xl font-semibold text-slate-900">{s?.name ?? "School"}</h1>
          </div>
        </div>
        {school.error ? (
          <ErrorNote message="This admission form isn't available. Please check the link with the school." />
        ) : ref ? (
          <div className="rounded-[2rem] bg-white p-8 text-center shadow-lift ring-1 ring-slate-200 animate-pop">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <Icon name="check" size={32} />
            </div>
            <h2 className="mt-4 font-display text-2xl font-semibold text-slate-900">Thank you!</h2>
            <p className="mt-2 text-slate-600">We've received your enquiry. The admissions office will contact you soon.</p>
            <p className="mt-4 inline-block rounded-xl bg-slate-100 px-4 py-2 font-mono text-sm font-bold text-slate-800">Reference {ref}</p>
            {(s?.supportPhone || s?.supportEmail) && <p className="mt-4 text-sm text-slate-500">Questions? {[s.supportPhone, s.supportEmail].filter(Boolean).join(" · ")}</p>}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5 rounded-[2rem] bg-white p-6 shadow-lift ring-1 ring-slate-200 sm:p-8">
            <p className="text-slate-600">Tell us a little about your child and we'll get in touch to take the next step.</p>
            <ApplicationFields form={form} setForm={setForm} />
            <ErrorNote message={error} />
            <button className="btn w-full py-3 text-base" disabled={busy}>
              {busy ? "Sending…" : "Send enquiry"} <Icon name="arrowRight" size={18} />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
