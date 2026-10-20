import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ErrorNote, PageTitle } from "../components/ui";

/** Accept an organisation invitation (link sent by an admin or HR). */
export function JoinPage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [error, setError] = useState<string | null>(null);
  const { switchTenant, user } = useAuth();
  const navigate = useNavigate();

  async function accept() {
    setError(null);
    try {
      const r = await api("/tenants/invitations/accept", { body: { token: code.trim() } });
      await switchTenant(r.tenantId);
      navigate("/");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageTitle title="Join an organisation" icon="users" subtitle={`Signed in as ${user?.email}. The invitation must be for this email.`} />
      <div className="card space-y-3">
        <input className="input font-mono text-xs" placeholder="Invitation code" value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorNote message={error} />
        <button className="btn" onClick={accept} disabled={!code.trim()}>
          Accept invitation
        </button>
      </div>
    </div>
  );
}
