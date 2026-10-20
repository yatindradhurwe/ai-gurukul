import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Spinner } from "../components/ui";

const ROLE_LABELS: Record<string, string> = {
  tenant_owner: "Owner",
  tenant_admin: "Admin",
  teacher: "Teacher",
  staff: "Staff / HR",
  accountant: "Accountant",
  librarian: "Librarian",
  transport_manager: "Transport manager",
  warden: "Hostel warden",
  content_reviewer: "Content reviewer",
  parent: "Parent",
  student: "Student",
};

/** People directory and invitations for school admins and staff/HR. */
export function PeoplePage() {
  const { tenant } = useAuth();
  const members = useApi("/tenants/current/members");
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ email: "", role: "teacher" });
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api(`/tenants/${tenant!.tenant_id}/invitations`, { body: form });
      setInvite({ email: form.email, link: `${window.location.origin}/join?code=${encodeURIComponent(r.token)}` });
      setForm({ ...form, email: "" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (members.loading && !members.data) return <Spinner />;
  const list = (members.data?.members ?? []).filter((m: any) => filter === "all" || m.roles.includes(filter));
  const counts: Record<string, number> = {};
  for (const m of members.data?.members ?? []) for (const r of m.roles) counts[r] = (counts[r] ?? 0) + 1;

  return (
    <div className="space-y-6">
      <PageTitle title="People" icon="users" subtitle={`Everyone in ${tenant?.name ?? "your organisation"}.`} />
      <form onSubmit={send} className="card grid gap-2 md:grid-cols-[1fr_200px_auto]">
        <input className="input" type="email" required placeholder="Email to invite" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {["tenant_admin", "teacher", "staff", "accountant", "librarian", "transport_manager", "warden", "content_reviewer", "parent", "student"].map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn">Invite</button>
      </form>
      <ErrorNote message={error} />
      {invite && (
        <div className="card bg-emerald-50 text-sm ring-emerald-200">
          Invitation created for <b>{invite.email}</b>. Send them this link. They sign up (or sign in) with that email, then open it. The link expires in 7 days.
          <div className="mt-2 flex gap-2">
            <input className="input font-mono text-xs" readOnly value={invite.link} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(invite.link)}>
              Copy
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-sm">
        {["all", ...Object.keys(ROLE_LABELS)].filter((r) => r === "all" || counts[r]).map((r) => (
          <button key={r} onClick={() => setFilter(r)} className={`chip px-3 py-1 ${filter === r ? "bg-brand text-white" : "bg-slate-100"}`}>
            {r === "all" ? `All (${members.data?.members.length ?? 0})` : `${ROLE_LABELS[r]} (${counts[r]})`}
          </button>
        ))}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.map((m: any) => (
              <tr key={m.id}>
                <td className="px-4 py-3 font-medium">{m.name}</td>
                <td className="px-4 py-3 text-slate-600">{m.email}</td>
                <td className="px-4 py-3">{m.roles.map((r: string) => ROLE_LABELS[r] ?? r).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
