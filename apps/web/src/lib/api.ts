// Thin API client: bearer access token + rotating refresh token, tenant header.
// Tokens live in localStorage for the MVP; move the refresh token to an
// httpOnly cookie when the web app is served from the API's domain.
//
// Every tab shares the stored tokens. Refresh tokens are single-use and the
// server revokes the whole session if one is replayed, so tabs always read the
// latest tokens from storage and refresh one at a time (Web Locks).

const BASE = "/api/v1";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
    } catch {
      /* private mode: keep the in-memory copy */
    }
  },
};
let memAccess: string | null = store.get("ag.access");
let memRefresh: string | null = store.get("ag.refresh");
// The selected organization is per tab, so two tabs can work in different schools.
let tenantId: string | null = store.get("ag.tenant");
// Storage is the source of truth (a sign-out in another tab signs this one out too);
// memory is only a fallback where storage is blocked.
const storageWorks = (() => {
  try {
    localStorage.setItem("ag.probe", "1");
    localStorage.removeItem("ag.probe");
    return true;
  } catch {
    return false;
  }
})();
const access = () => (storageWorks ? store.get("ag.access") : memAccess);
const refresh = () => (storageWorks ? store.get("ag.refresh") : memRefresh);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function setTokens(a: string | null, r: string | null) {
  memAccess = a;
  memRefresh = r;
  store.set("ag.access", a);
  store.set("ag.refresh", r);
}

export function setTenant(id: string | null) {
  tenantId = id;
  store.set("ag.tenant", id);
}

export const getTenant = () => tenantId;
export const getAccessToken = () => access();
export const isLoggedIn = () => !!access();

/** Headers for raw fetch calls (e.g. streaming) that bypass api(). */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const a = access();
  if (a) h.Authorization = `Bearer ${a}`;
  if (tenantId) h["X-Tenant-Id"] = tenantId;
  return h;
}

async function refreshOnce(staleAccess: string | null): Promise<boolean> {
  // Another tab may have refreshed while we waited: use its tokens.
  const current = access();
  if (current && current !== staleAccess) return true;
  const token = refresh();
  if (!token) return false;
  const r = await fetch(`${BASE}/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
  if (!r.ok) {
    // Lost a race with a tab that has no lock support; its tokens are fine to use.
    const now = access();
    return !!now && now !== staleAccess;
  }
  const body = await r.json();
  setTokens(body.accessToken, body.refreshToken);
  return true;
}

let refreshing: Promise<boolean> | null = null;
/** Get a fresh access token after a 401. Safe to call from many places and many tabs at once. */
export async function tryRefresh(): Promise<boolean> {
  const stale = access();
  const run: Promise<boolean> =
    typeof navigator !== "undefined" && navigator.locks ? (navigator.locks.request("ag.refresh", () => refreshOnce(stale)) as unknown as Promise<boolean>) : refreshOnce(stale);
  const p = (refreshing ??= run.catch(() => false).finally(() => (refreshing = null)));
  return p;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && opts.retry !== false && (await tryRefresh())) return api<T>(path, { ...opts, retry: false });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? "error", body.error?.message ?? res.statusText, body.error?.details);
  return body as T;
}

/** Fetch a private file (e.g. an uploaded document) as a Blob with the caller's credentials. */
export async function apiBlob(path: string, retry = true): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401 && retry && (await tryRefresh())) return apiBlob(path, false);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error?.code ?? "error", body.error?.message ?? res.statusText);
  }
  return res.blob();
}

export const formatPaise =(paise: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);

export const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
