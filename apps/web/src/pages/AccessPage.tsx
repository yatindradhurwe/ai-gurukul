import { useEffect, useState } from "react";
import { Icon } from "../components/icons";
import { Badge, ErrorNote, InfoNote, PageTitle, Spinner, SuccessNote } from "../components/ui";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";

interface Perm {
  id: string;
  module: string;
  label: string;
  hint: string;
}
interface Role {
  id: string;
  name: string;
  members: number;
  locked: boolean;
  allowed: string[];
  defaults: string[];
  customised: boolean;
}

/** The principal decides which modules each role can use in this school. */
export function AccessPage() {
  const d = useApi<{ permissions: Perm[]; roles: Role[] }>("/access");
  const [roleId, setRoleId] = useState("teacher");
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const roles = d.data?.roles ?? [];
  const role = roles.find((r) => r.id === roleId) ?? roles[0];

  useEffect(() => {
    setDraft(null);
    setMsg(null);
    setErr(null);
  }, [roleId]);

  if (d.loading && !d.data) return <Spinner />;
  if (!d.data || !role) return <ErrorNote message={d.error} />;
  const current = draft ?? new Set(role.allowed);
  const dirty = !!draft && (draft.size !== role.allowed.length || role.allowed.some((p) => !draft.has(p)));
  const modules = [...new Set(d.data.permissions.map((p) => p.module))];

  const toggle = (id: string) => {
    if (role.locked) return;
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    setDraft(next);
    setMsg(null);
  };
  const run = async (fn: () => Promise<any>, done: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      d.setData(r);
      setDraft(null);
      setMsg(done);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle title="Access & roles" icon="shield" subtitle="Choose which modules each role can use in your school. Changes apply straight away to everyone with that role." />
      <div className="grid gap-5 lg:grid-cols-[17rem_1fr]">
        <aside className="card h-fit p-2">
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => setRoleId(r.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left transition ${r.id === role.id ? "bg-brand-soft" : "hover:bg-slate-50"}`}
            >
              <span className="min-w-0">
                <span className={`block truncate text-sm font-semibold ${r.id === role.id ? "text-brand" : "text-slate-900"}`}>{r.name}</span>
                <span className="block text-xs text-slate-500">
                  {r.members} member{r.members === 1 ? "" : "s"} · {r.allowed.length} modules
                </span>
              </span>
              {r.locked ? <Icon name="shield" size={14} className="shrink-0 text-slate-400" /> : r.customised && <Badge tone="amber">Custom</Badge>}
            </button>
          ))}
        </aside>
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{role.name}</h2>
              <p className="text-sm text-slate-500">
                {current.size} of {d.data.permissions.length} modules switched on{role.customised && !draft ? " · changed from the default" : ""}
              </p>
            </div>
            {!role.locked && (
              <div className="flex flex-wrap gap-2">
                {role.customised && (
                  <button className="btn-ghost" disabled={busy} onClick={() => confirm(`Put ${role.name} back to the default access?`) && run(() => api(`/access/${role.id}`, { method: "DELETE" }), "Back to the default access.")}>
                    Reset to default
                  </button>
                )}
                {dirty && (
                  <button className="btn-ghost" disabled={busy} onClick={() => setDraft(null)}>
                    Discard
                  </button>
                )}
                <button className="btn" disabled={busy || !dirty} onClick={() => run(() => api(`/access/${role.id}`, { method: "PUT", body: { permissions: [...current] } }), `Saved. Everyone with the ${role.name} role now has this access.`)}>
                  <Icon name="check" size={16} /> {busy ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
          {role.locked && <InfoNote>The principal always has full access, so nobody can be locked out of the school.</InfoNote>}
          {(role.id === "student" || role.id === "parent") && !role.locked && (
            <InfoNote>Students and parents always keep their own learning, results and children's records. The switches below add or remove school modules for them.</InfoNote>
          )}
          <ErrorNote message={err} />
          <SuccessNote message={msg} />
          <div className="grid gap-4 xl:grid-cols-2">
            {modules.map((m) => (
              <section key={m} className="card">
                <h3 className="section-title mb-3">{m}</h3>
                <ul className="space-y-1">
                  {d.data!.permissions
                    .filter((p) => p.module === m)
                    .map((p) => {
                      const on = current.has(p.id);
                      const byDefault = role.defaults.includes(p.id);
                      return (
                        <li key={p.id}>
                          <label className={`flex items-center gap-3 rounded-xl px-2 py-2 ${role.locked ? "" : "cursor-pointer hover:bg-slate-50"}`}>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                {p.label}
                                {on !== byDefault && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">{on ? "added" : "removed"}</span>}
                              </span>
                              <span className="block text-xs text-slate-500">
                                {p.hint}
                                {byDefault && " · on by default"}
                              </span>
                            </span>
                            <input type="checkbox" className="peer sr-only" checked={on} disabled={role.locked} onChange={() => toggle(p.id)} />
                            <span
                              aria-hidden
                              className={`relative h-6 w-11 shrink-0 rounded-full transition peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${on ? "bg-brand" : "bg-slate-300"} ${role.locked ? "opacity-60" : ""}`}
                            >
                              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
                            </span>
                          </label>
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
