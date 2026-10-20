import request from "supertest";
import { createApp } from "../src/app.js";
import { pool, withSystem } from "../src/database/pool.js";
import { seed } from "../src/database/seeds/seed.js";

export const app = createApp();

/** Direct SQL for test setup/assertions, run as trusted system code (bypasses tenant RLS). */
export const sql = (text: string, params: unknown[] = []) => withSystem((db) => db.query(text, params));

export const dbAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

/** Fresh schema + reference/demo seed. Destroys the test database contents. */
export async function resetDb() {
  if (!process.env.DATABASE_URL?.includes("test")) throw new Error("Refusing to reset a non-test database");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await seed(() => {});
}

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}.${Date.now()}.${++counter}@example.test`;

export interface Session {
  token: string;
  userId: string;
  tenantId: string;
  headers: Record<string, string>;
}

export async function register(accountType: "student" | "parent", name = "Test User"): Promise<Session> {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ name, email: uniqueEmail(accountType), password: "correct-horse-battery", accountType })
    .expect(201);
  return session(res.body.accessToken, res.body.user.id, res.body.tenant.id);
}

export async function login(email: string, password: string, tenantId?: string): Promise<Session> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
  let tid = tenantId;
  if (!tid) {
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`).expect(200);
    tid = me.body.memberships[0].tenant_id;
  }
  return session(res.body.accessToken, res.body.user.id, tid!);
}

export function session(token: string, userId: string, tenantId: string): Session {
  return { token, userId, tenantId, headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId } };
}

export const api = {
  get: (s: Session, url: string) => request(app).get(url).set(s.headers),
  post: (s: Session, url: string, body: object = {}) => request(app).post(url).set(s.headers).send(body),
  patch: (s: Session, url: string, body: object = {}) => request(app).patch(url).set(s.headers).send(body),
  put: (s: Session, url: string, body: object = {}) => request(app).put(url).set(s.headers).send(body),
  delete: (s: Session, url: string) => request(app).delete(url).set(s.headers),
};
