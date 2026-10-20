import { useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Spinner } from "../components/ui";

/** Platform super-admin console. Every request here is itself audit-logged by the API. */
export function PlatformAdminPage() {
  const [tab, setTab] = useState<"tenants" | "audit" | "usage">("tenants");
  const tenants = useApi(tab === "tenants" ? "/admin/tenants" : null);
  const audit = useApi(tab === "audit" ? "/admin/audit-logs" : null);
  const usage = useApi(tab === "usage" ? "/admin/usage-costs" : null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(t: any, status: string) {
    const reason = prompt(`Reason for setting "${t.name}" to ${status}:`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/admin/tenants/${t.id}`, { method: "PATCH", body: { status, reason } });
      tenants.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Platform admin" icon="shield" subtitle="All organisations on AI Gurukul. Access to this console is audit-logged." />
      <div className="flex gap-2 text-sm">
        {(["tenants", "audit", "usage"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`chip px-3 py-1 ${tab === t ? "bg-brand text-white" : "bg-slate-100"}`}>
            {t === "tenants" ? "Organisations" : t === "audit" ? "Audit log" : "Usage & costs"}
          </button>
        ))}
      </div>
      <ErrorNote message={error ?? tenants.error ?? audit.error ?? usage.error} />

      {tab === "tenants" &&
        (tenants.loading ? (
          <Spinner />
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Organisation</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Members</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tenants.data?.tenants.map((t: any) => (
                  <tr key={t.id}>
                    <td className="px-4 py-3 font-medium">{t.name}</td>
                    <td className="px-4 py-3">{t.type}</td>
                    <td className="px-4 py-3">{t.members}</td>
                    <td className="px-4 py-3">
                      <span className={`chip ${t.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{t.status}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {t.status === "active" ? (
                        <button className="btn-ghost text-red-600" onClick={() => setStatus(t, "suspended")}>
                          Suspend
                        </button>
                      ) : (
                        <button className="btn-ghost" onClick={() => setStatus(t, "active")}>
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "audit" &&
        (audit.loading ? (
          <Spinner />
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Resource</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {audit.data?.logs.map((l: any) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">{new Date(l.created_at).toLocaleString("en-IN")}</td>
                    <td className="px-4 py-2 font-medium">{l.action}</td>
                    <td className="px-4 py-2 text-slate-500">{l.resource_type ? `${l.resource_type} ${String(l.resource_id ?? "").slice(0, 8)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "usage" &&
        (usage.loading ? (
          <Spinner />
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Organisation</th>
                  <th className="px-4 py-3">Usage type</th>
                  <th className="px-4 py-3">Quantity (this month)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {usage.data?.usage.map((u: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-3">{u.tenant}</td>
                    <td className="px-4 py-3">{u.event_type.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3">{Math.round(Number(u.quantity) * 100) / 100}</td>
                  </tr>
                ))}
                {!usage.data?.usage.length && (
                  <tr>
                    <td className="px-4 py-3 text-slate-500" colSpan={3}>
                      No usage recorded this month.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
