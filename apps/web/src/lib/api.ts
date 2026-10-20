// Thin API client: bearer access token + rotating refresh token, tenant header.
// Tokens live in memory + localStorage for the MVP; move the refresh token to
// an httpOnly cookie when the web app is served from the API's domain.

const BASE = "/api/v1";
let accessToken: string | null = localStorage.getItem("ag.access");
let refreshToken: string | null = localStorage.getItem("ag.refresh");
let tenantId: string | null = localStorage.getItem("ag.tenant");

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function setTokens(a: string | null, r: string | null) {
  accessToken = a;
  refreshToken = r;
  a ? localStorage.setItem("ag.access", a) : localStorage.removeItem("ag.access");
  r ? localStorage.setItem("ag.refresh", r) : localStorage.removeItem("ag.refresh");
}

export function setTenant(id: string | null) {
  tenantId = id;
  id ? localStorage.setItem("ag.tenant", id) : localStorage.removeItem("ag.tenant");
}

export const getTenant = () => tenantId;
export const isLoggedIn = () => !!accessToken;

/** Headers for raw fetch calls (e.g. streaming) that bypass api(). */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  if (tenantId) h["X-Tenant-Id"] = tenantId;
  return h;
}

let refreshing: Promise<boolean> | null = null;
export async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const body = await r.json();
      setTokens(body.accessToken, body.refreshToken);
      return true;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
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
