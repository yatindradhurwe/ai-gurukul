import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getTenant, isLoggedIn, setTenant, setTokens } from "./api";

export interface Membership {
  tenant_id: string;
  name: string;
  slug: string;
  type: string;
  roles: string[];
  settings: { primaryColor?: string; logoUrl?: string };
}

interface TenantInfo {
  roles: string[];
  permissions: string[];
  studentProfileId: string | null;
}

interface AuthState {
  user: { id: string; name: string; email: string } | null;
  memberships: Membership[];
  tenant: Membership | null;
  info: TenantInfo | null;
  loading: boolean;
  can: (p: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { name: string; email: string; password: string; accountType: "student" | "parent" }) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (id: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

function applyBranding(m: Membership | null) {
  const hex = m?.settings?.primaryColor;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex.slice(1), 16);
    document.documentElement.style.setProperty("--brand", `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`);
  } else document.documentElement.style.removeProperty("--brand");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState["user"]>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenant, setTenantState] = useState<Membership | null>(null);
  const [info, setInfo] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isLoggedIn()) {
      setLoading(false);
      return;
    }
    try {
      const me = await api<{ user: AuthState["user"]; memberships: Membership[] }>("/auth/me");
      setUser(me.user);
      setMemberships(me.memberships);
      const preferred = me.memberships.find((m) => m.tenant_id === getTenant()) ?? me.memberships[0] ?? null;
      setTenant(preferred?.tenant_id ?? null);
      setTenantState(preferred);
      applyBranding(preferred);
      if (preferred) setInfo(await api<TenantInfo>("/tenants/current"));
    } catch {
      setTokens(null, null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const value: AuthState = {
    user,
    memberships,
    tenant,
    info,
    loading,
    can: (p) => !!info?.permissions.includes(p),
    async login(email, password) {
      const r = await api("/auth/login", { body: { email, password } });
      setTokens(r.accessToken, r.refreshToken);
      setTenant(null);
      setLoading(true);
      await load();
    },
    async register(data) {
      const r = await api("/auth/register", { body: data });
      setTokens(r.accessToken, r.refreshToken);
      setTenant(r.tenant.id);
      setLoading(true);
      await load();
    },
    async logout() {
      const refresh = localStorage.getItem("ag.refresh");
      if (refresh) await api("/auth/logout", { body: { refreshToken: refresh } }).catch(() => {});
      setTokens(null, null);
      setTenant(null);
      setUser(null);
      setInfo(null);
      applyBranding(null);
    },
    async switchTenant(id) {
      setTenant(id);
      setLoading(true);
      await load();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
