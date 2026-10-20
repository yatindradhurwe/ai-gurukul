import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, getTenant, isLoggedIn, setTenant, setTokens } from "./api";
import { realtime } from "./realtime";

const LAST_USER = "ag.uid";
const lastUser = () => {
  try {
    return localStorage.getItem(LAST_USER);
  } catch {
    return null;
  }
};
const rememberUser = (id: string | null) => {
  try {
    id ? localStorage.setItem(LAST_USER, id) : localStorage.removeItem(LAST_USER);
  } catch {
    /* ignore */
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  user: { id: string; name: string; email: string; is_platform_admin?: boolean } | null;
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
  const navigate = useNavigate();

  const clear = useCallback(() => {
    realtime.stop();
    setUser(null);
    setMemberships([]);
    setTenantState(null);
    setInfo(null);
    applyBranding(null);
  }, []);

  /** Load the signed-in user and the selected organization; returns the user's id. */
  const load = useCallback(async (): Promise<string | null> => {
    if (!isLoggedIn()) {
      clear();
      setLoading(false);
      return null;
    }
    // A dropped connection shouldn't sign anyone out: retry, and only clear the session on 401.
    for (let attempt = 0; ; attempt++) {
      try {
        const me = await api<{ user: AuthState["user"]; memberships: Membership[] }>("/auth/me");
        const preferred = me.memberships.find((m) => m.tenant_id === getTenant()) ?? me.memberships[0] ?? null;
        setTenant(preferred?.tenant_id ?? null);
        const tenantInfo = preferred ? await api<TenantInfo>("/tenants/current") : null;
        setUser(me.user);
        setMemberships(me.memberships);
        setTenantState(preferred);
        setInfo(tenantInfo);
        applyBranding(preferred);
        rememberUser(me.user?.id ?? null);
        preferred ? realtime.start(preferred.tenant_id) : realtime.stop();
        setLoading(false);
        return me.user?.id ?? null;
      } catch (err) {
        if ((err instanceof ApiError && err.status === 401) || attempt >= 3) {
          if (err instanceof ApiError && err.status === 401) setTokens(null, null);
          clear();
          setLoading(false);
          return null;
        }
        await sleep(800 * (attempt + 1));
      }
    }
  }, [clear]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow sign-ins and sign-outs made in other tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ag.refresh" && !e.newValue) {
        clear();
        navigate("/", { replace: true });
      } else if (e.key === LAST_USER && e.newValue && e.newValue !== user?.id) {
        // Someone else signed in on this browser: start fresh as them.
        window.location.assign("/");
      } else if (e.key === "ag.refresh" && e.newValue && !user) {
        setLoading(true);
        load();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [clear, load, navigate, user]);

  const value: AuthState = {
    user,
    memberships,
    tenant,
    info,
    loading,
    can: (p) => !!info?.permissions.includes(p),
    async login(email, password) {
      const previous = lastUser();
      const r = await api("/auth/login", { body: { email, password } });
      setTokens(r.accessToken, r.refreshToken);
      if (previous !== r.user?.id) setTenant(null);
      setLoading(true);
      const id = await load();
      // A different person (or role) starts on their dashboard, not on the last user's page.
      if (id && id !== previous) navigate("/", { replace: true });
    },
    async register(data) {
      const r = await api("/auth/register", { body: data });
      setTokens(r.accessToken, r.refreshToken);
      setTenant(r.tenant.id);
      setLoading(true);
      await load();
      navigate("/", { replace: true });
    },
    async logout() {
      let refresh: string | null = null;
      try {
        refresh = localStorage.getItem("ag.refresh");
      } catch {
        /* ignore */
      }
      if (refresh) await api("/auth/logout", { body: { refreshToken: refresh } }).catch(() => {});
      setTokens(null, null);
      setTenant(null);
      clear();
      navigate("/", { replace: true });
    },
    async switchTenant(id) {
      setTenant(id);
      setLoading(true);
      await load();
      navigate("/", { replace: true });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
