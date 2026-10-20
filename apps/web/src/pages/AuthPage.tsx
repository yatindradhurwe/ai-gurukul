import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { Icon, type IconName } from "../components/icons";
import { ErrorNote } from "../components/ui";

const FEATURES: { icon: IconName; text: string }[] = [
  { icon: "video", text: "Live classes taught by an AI avatar, with doubts answered aloud" },
  { icon: "calendar", text: "A study plan built from the syllabus, marks and exam dates" },
  { icon: "award", text: "Attendance, assignments, gradebook and report cards" },
  { icon: "heart", text: "Parents see progress, attendance and homework every week" },
];

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", accountType: "student" as "student" | "parent" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(form.email, form.password);
      else await register(form);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-slate-50 lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-600 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -left-24 top-1/3 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute -bottom-24 right-0 h-80 w-80 rounded-full bg-amber-300/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/20 backdrop-blur">
            <Icon name="graduation" size={24} />
          </div>
          <span className="font-display text-xl font-semibold">AI Gurukul</span>
        </div>
        <div className="relative mt-auto max-w-lg">
          <h1 className="font-display text-4xl font-semibold leading-tight">Every student deserves a patient teacher.</h1>
          <p className="mt-4 text-lg text-white/85">Live AI classrooms, a study planner that adapts, and everything your school runs on — in one place.</p>
          <ul className="mt-8 grid gap-3 text-sm">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-center gap-3 rounded-2xl bg-white/10 px-4 py-3 backdrop-blur">
                <Icon name={f.icon} size={18} />
                {f.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-10 text-xs text-white/60">Built for Indian schools, coaching institutes and families.</p>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md animate-fade-up">
          <div className="mb-8 lg:hidden">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-violet-500 text-white">
              <Icon name="graduation" size={26} />
            </div>
            <p className="font-display text-xl font-semibold text-slate-900">AI Gurukul</p>
          </div>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-900">{mode === "login" ? "Welcome back" : "Create your account"}</h2>
          <p className="mt-1 text-sm text-slate-500">{mode === "login" ? "Sign in to continue learning." : "Start learning with your AI teacher in a minute."}</p>
          <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-sm">
              {(["login", "register"] as const).map((m) => (
                <button type="button" key={m} onClick={() => setMode(m)} className={`rounded-lg py-2 font-medium transition ${mode === m ? "bg-surface text-slate-900 shadow-sm" : "text-slate-500"}`}>
                  {m === "login" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
            {mode === "register" && (
              <>
                <div>
                  <label className="label">I am a</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["student", "parent"] as const).map((t) => (
                      <button type="button" key={t} onClick={() => setForm({ ...form, accountType: t })} className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition ${form.accountType === t ? "bg-brand-soft text-brand ring-brand" : "text-slate-600 ring-slate-200 hover:bg-slate-50"}`}>
                        <Icon name={t === "student" ? "graduation" : "heart"} size={16} />
                        {t === "student" ? "Student" : "Parent"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="name">Full name</label>
                  <input id="name" className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
              </>
            )}
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : 1} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <ErrorNote message={error} />
            <button className="btn w-full py-2.5" disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              {!busy && <Icon name="arrowRight" size={16} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
