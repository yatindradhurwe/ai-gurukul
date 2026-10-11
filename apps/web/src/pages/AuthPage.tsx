import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { ErrorNote } from "../components/ui";

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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-amber-50 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white">G</div>
          <h1 className="text-2xl font-semibold">AI Gurukul</h1>
          <p className="mt-1 text-sm text-slate-500">Your AI teacher, study planner and exam coach.</p>
        </div>
        <form onSubmit={submit} className="card space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-sm">
            {(["login", "register"] as const).map((m) => (
              <button type="button" key={m} onClick={() => setMode(m)} className={`rounded-lg py-1.5 ${mode === m ? "bg-white font-medium shadow-sm" : "text-slate-500"}`}>
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
                    <button type="button" key={t} onClick={() => setForm({ ...form, accountType: t })} className={`rounded-xl px-3 py-2 text-sm ring-1 ${form.accountType === t ? "bg-brand-soft text-brand ring-brand" : "ring-slate-200"}`}>
                      {t === "student" ? "🎒 Student" : "👪 Parent"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">Full name</label>
                <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
            </>
          )}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required minLength={mode === "register" ? 8 : 1} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <ErrorNote message={error} />
          <button className="btn w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
