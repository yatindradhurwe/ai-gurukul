import type { Permission } from "./lib/permissions.js";

export interface AuthContext {
  userId: string;
  isPlatformAdmin: boolean;
}

export interface TenantContext {
  id: string;
  type: string;
  slug: string;
  roles: string[];
  permissions: Set<Permission>;
  /** The caller's own student profile in this tenant, if they are a student. */
  studentProfileId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      tenant?: TenantContext;
      rawBody?: Buffer;
    }
  }
}
