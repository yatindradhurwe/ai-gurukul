import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { setupDemo } from "../src/database/seeds/demo-accounts.js";
import { app, dbAvailable, resetDb } from "./helpers.js";

describe.skipIf(!dbAvailable)("demo accounts setup", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("creates one working login per role, idempotently", async () => {
    const first = await setupDemo();
    expect(first.map((r) => r.user.key)).toEqual(["superadmin", "principal", "admin", "teacher", "staff", "accountant", "librarian", "transport", "warden", "student1", "student2", "parent"]);
    expect(first.every((r) => r.password)).toBe(true);

    const login = async (email: string, password: string) => (await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200)).body.accessToken as string;
    const byKey = Object.fromEntries(first.map((r) => [r.user.key, r]));

    // Only the super admin can use the platform admin API.
    const adminToken = await login(byKey.superadmin.user.email, byKey.superadmin.password!);
    await request(app).get("/api/v1/admin/tenants").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const schoolAdminToken = await login(byKey.admin.user.email, byKey.admin.password!);
    await request(app).get("/api/v1/admin/tenants").set("Authorization", `Bearer ${schoolAdminToken}`).expect(403);

    // Teacher sees the class with a scheduled live lesson; student is enrolled; parent sees the child.
    const tenant = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${adminToken}`)).body.memberships.find((m: any) => m.slug === "demo-school").tenant_id;
    const as = async (key: string) => ({ Authorization: `Bearer ${await login(byKey[key].user.email, byKey[key].password!)}`, "X-Tenant-Id": tenant });
    const classes = await request(app).get("/api/v1/classes").set(await as("teacher")).expect(200);
    expect(classes.body.classes[0]).toMatchObject({ name: "8-A Science", students: 2 });
    expect(classes.body.classes[0].sessions[0].status).toBe("scheduled");
    expect((await request(app).get("/api/v1/classes").set(await as("student1")).expect(200)).body.classes).toHaveLength(1);
    const children = await request(app).get("/api/v1/parents/children").set(await as("parent")).expect(200);
    expect(children.body.children.map((c: any) => c.name)).toEqual(["Ravi Kumar"]);

    // School admin and staff/HR manage people; HR cannot open a student's academic records.
    const members = await request(app).get("/api/v1/tenants/current/members").set(await as("staff")).expect(200);
    expect(members.body.members).toHaveLength(12);
    const roles = Object.fromEntries(members.body.members.map((m: any) => [m.email, m.roles]));
    expect(roles[byKey.staff.user.email]).toEqual(["staff"]);
    expect(roles[byKey.admin.user.email]).toEqual(["tenant_admin"]);
    await request(app).post(`/api/v1/tenants/${tenant}/invitations`).set(await as("staff")).send({ email: "new.teacher@example.test", role: "teacher" }).expect(201);
    const ravi = members.body.members.find((m: any) => m.name === "Ravi Kumar").student_profile_id;
    await request(app).get(`/api/v1/academic/syllabus-progress?studentId=${ravi}`).set(await as("staff")).expect(403);
    await request(app).get(`/api/v1/academic/syllabus-progress?studentId=${ravi}`).set(await as("admin")).expect(200);

    // Sample campus records: the accountant sees fees, the librarian the library, the student a published exam.
    const fees = (await request(app).get("/api/v1/fees/summary").set(await as("accountant")).expect(200)).body.totals;
    expect(Number(fees.collected)).toBe(1180000);
    await request(app).get("/api/v1/fees/summary").set(await as("librarian")).expect(403);
    expect((await request(app).get("/api/v1/library/loans?state=overdue").set(await as("librarian")).expect(200)).body.loans).toHaveLength(1);
    expect((await request(app).get("/api/v1/exams").set(await as("student1")).expect(200)).body.exams[0]).toMatchObject({ name: "Half-yearly examination", papers: 3 });

    // Transport, hostel and rewards: the student rides a bus, lives in a room and has XP.
    expect((await request(app).get("/api/v1/transport/my").set(await as("student1")).expect(200)).body.route.name).toBe("Route 1 — Jayanagar");
    expect((await request(app).get("/api/v1/hostels/my").set(await as("student1")).expect(200)).body.room.room_no).toBe("101");
    expect((await request(app).get("/api/v1/hostels").set(await as("warden")).expect(200)).body.hostels).toHaveLength(2);
    expect((await request(app).get("/api/v1/transport/routes").set(await as("transport")).expect(200)).body.summary.riders).toBe(2);
    expect((await request(app).get("/api/v1/engagement/me").set(await as("student1")).expect(200)).body.xp).toBeGreaterThan(0);

    // Office records: HR profiles, a parent-teacher thread, PTM slots, admission enquiries.
    expect((await request(app).get("/api/v1/hr/staff").set(await as("staff")).expect(200)).body.staff.filter((s: any) => s.employee_code)).toHaveLength(8);
    expect((await request(app).get("/api/v1/messages/conversations").set(await as("teacher")).expect(200)).body.conversations).toHaveLength(1);
    expect((await request(app).get("/api/v1/ptm/available").set(await as("parent")).expect(200)).body.available.length).toBeGreaterThan(0);
    expect((await request(app).get("/api/v1/admissions").set(await as("admin")).expect(200)).body.applications).toHaveLength(3);
    expect((await request(app).get("/api/v1/leave/review?status=pending").set(await as("teacher")).expect(200)).body.requests).toHaveLength(1);

    // Academics: a 2026-27 session, three subjects with generated plans, visible to the principal and the student.
    const overview = (await request(app).get("/api/v1/academics/overview").set(await as("principal")).expect(200)).body;
    expect(overview.subjects).toEqual(["English", "Mathematics", "Science"]);
    expect(overview.cells.every((c: any) => c.total > 0)).toBe(true);
    expect((await request(app).get("/api/v1/academics/student").set(await as("student1")).expect(200)).body.subjects).toHaveLength(3);

    // Re-running keeps passwords unless asked to reset, and does not duplicate data.
    const second = await setupDemo();
    expect(second.every((r) => r.password === null)).toBe(true);
    await login(byKey.teacher.user.email, byKey.teacher.password!);
    expect((await request(app).get("/api/v1/classes").set(await as("teacher"))).body.classes[0].sessions).toHaveLength(1);
    expect((await request(app).get("/api/v1/fees/structures").set(await as("accountant"))).body.structures).toHaveLength(2);

    const reset = await setupDemo({ reset: true, password: "Chosen#Pass2026" });
    expect(reset.every((r) => r.password === "Chosen#Pass2026")).toBe(true);
    await login(byKey.student2.user.email, "Chosen#Pass2026");
  });
});
