/** Cross-tenant and cross-student access tests (MVP acceptance criteria). */
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/database/pool.js";
import { api, app, dbAvailable, login, register, resetDb, uniqueEmail, type Session, sql } from "./helpers.js";
import request from "supertest";

describe.skipIf(!dbAvailable)("tenant and student isolation", () => {
  let a: Session;
  let b: Session;
  let planA: string;
  let scienceId: string;

  beforeAll(async () => {
    await resetDb();
    a = await register("student", "Student A");
    b = await register("student", "Student B");
    scienceId = (await sql(`SELECT id FROM subjects WHERE code = 'SCI'`)).rows[0].id;
    await api.post(a, "/api/v1/academic/exams", { subjectId: scienceId, title: "Exam", examDate: "2026-12-20", maxMarks: 80 }).expect(201);
    planA = (await api.post(a, "/api/v1/academic/study-plans/generate", { startDate: "2026-12-01" }).expect(201)).body.plan.id;
  });

  it("rejects requests without authentication", async () => {
    await request(app).get("/api/v1/academic/dashboard").set("X-Tenant-Id", a.tenantId).expect(401);
  });

  it("a student cannot select another tenant by sending its id", async () => {
    await request(app).get("/api/v1/academic/study-plans").set({ Authorization: `Bearer ${b.token}`, "X-Tenant-Id": a.tenantId }).expect(403);
  });

  it("a student cannot read another student's plan by id, even inside their own tenant context", async () => {
    await api.get(b, `/api/v1/academic/study-plans/${planA}`).expect(404);
    await api.post(b, `/api/v1/academic/study-plans/${planA}/recalculate`, {}).expect(404);
  });

  it("RLS hides other tenants' rows even if a query forgets its tenant filter", async () => {
    const seenByB = await withTenant(b.tenantId, (db) => db.query(`SELECT count(*)::int AS n FROM study_plans`));
    expect(seenByB.rows[0].n).toBe(0);
    const seenByA = await withTenant(a.tenantId, (db) => db.query(`SELECT count(*)::int AS n FROM study_plans`));
    expect(seenByA.rows[0].n).toBe(1);
    // and writes into another tenant are rejected by the WITH CHECK policy
    await expect(
      withTenant(b.tenantId, (db) =>
        db.query(`INSERT INTO usage_events (tenant_id, event_type, quantity) VALUES ($1, 'ai_question', 1)`, [a.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  describe("schools", () => {
    let ownerA: Session;
    let schoolA: string;
    let schoolB: string;
    let teacherA: Session;
    let s1: Session;
    let s2: Session;

    beforeAll(async () => {
      ownerA = await register("parent", "Principal A");
      schoolA = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${ownerA.token}`).send({ name: "School A", type: "school" }).expect(201)).body.tenant.id;
      const ownerB = await register("parent", "Principal B");
      schoolB = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${ownerB.token}`).send({ name: "School B", type: "school" }).expect(201)).body.tenant.id;
      ownerA = { ...ownerA, tenantId: schoolA, headers: { ...ownerA.headers, "X-Tenant-Id": schoolA } };

      const join = async (role: string, name: string) => {
        const email = uniqueEmail(role);
        await request(app).post("/api/v1/auth/register").send({ name, email, password: "password-1234", accountType: "student" }).expect(201);
        const inv = await api.post(ownerA, `/api/v1/tenants/${schoolA}/invitations`, { email, role }).expect(201);
        const s = await login(email, "password-1234", schoolA);
        await api.post(s, "/api/v1/tenants/invitations/accept", { token: inv.body.token }).expect(200);
        return s;
      };
      teacherA = await join("teacher", "Teacher A");
      s1 = await join("student", "School Student 1");
      s2 = await join("student", "School Student 2");
      const cv = (await sql(`SELECT id FROM curriculum_versions LIMIT 1`)).rows[0].id;
      await sql(`UPDATE student_profiles SET curriculum_version_id = $1 WHERE tenant_id = $2`, [cv, schoolA]);
    });

    it("an invitation can only be accepted by the invited email", async () => {
      const inv = await api.post(ownerA, `/api/v1/tenants/${schoolA}/invitations`, { email: uniqueEmail("someone"), role: "teacher" }).expect(201);
      await request(app).post("/api/v1/tenants/invitations/accept").set("Authorization", `Bearer ${b.token}`).send({ token: inv.body.token }).expect(403);
    });

    it("a teacher can see students in their school", async () => {
      const members = await api.get(teacherA, "/api/v1/tenants/current/members").expect(200);
      const s1Profile = members.body.members.find((m: any) => m.name === "School Student 1").student_profile_id;
      await api.get(teacherA, `/api/v1/academic/syllabus-progress?studentId=${s1Profile}`).expect(200);
    });

    it("a school cannot access another school's records", async () => {
      await request(app).get("/api/v1/tenants/current/members").set({ Authorization: `Bearer ${teacherA.token}`, "X-Tenant-Id": schoolB }).expect(403);
    });

    it("a student cannot access a classmate's records", async () => {
      const members = await api.get(teacherA, "/api/v1/tenants/current/members").expect(200);
      const s2Profile = members.body.members.find((m: any) => m.name === "School Student 2").student_profile_id;
      await api.get(s1, `/api/v1/academic/syllabus-progress?studentId=${s2Profile}`).expect(403);
      await api.get(s1, `/api/v1/academic/recommendations?studentId=${s2Profile}`).expect(403);
      // and own records work
      await api.get(s2, "/api/v1/academic/syllabus-progress").expect(200);
    });

    it("students cannot perform staff actions", async () => {
      await api.post(s1, `/api/v1/tenants/${schoolA}/invitations`, { email: uniqueEmail("x"), role: "student" }).expect(403);
      await api.post(s1, "/api/v1/content/lessons", {}).expect(403);
    });
  });

  it("a parent only sees children they are linked to", async () => {
    const p1 = await register("parent", "Parent One");
    const cv = (await sql(`SELECT id FROM curriculum_versions LIMIT 1`)).rows[0].id;
    const c1 = await api.post(p1, "/api/v1/parents/children", { name: "Kid", email: uniqueEmail("kid"), password: "kid-password-1", curriculumVersionId: cv }).expect(201);
    const p2 = await register("parent", "Parent Two");
    // Different family workspace: not even a member.
    await request(app).get(`/api/v1/parents/children/${c1.body.child.studentId}/report`).set({ Authorization: `Bearer ${p2.token}`, "X-Tenant-Id": p1.tenantId }).expect(403);
    // Own workspace, someone else's child id: RLS makes it invisible.
    await api.get(p2, `/api/v1/parents/children/${c1.body.child.studentId}/report`).expect(404);
  });

  it("refresh tokens rotate and a reused token revokes the session family", async () => {
    const email = uniqueEmail("rot");
    const reg = await request(app).post("/api/v1/auth/register").send({ name: "Rot", email, password: "password-1234" }).expect(201);
    const r1 = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: reg.body.refreshToken }).expect(200);
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: reg.body.refreshToken }).expect(401); // reuse
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
  });
});
