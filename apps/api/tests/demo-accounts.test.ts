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
    expect(first.map((r) => r.user.key)).toEqual(["admin", "principal", "teacher", "student1", "student2", "parent"]);
    expect(first.every((r) => r.password)).toBe(true);

    const login = async (email: string, password: string) => (await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200)).body.accessToken as string;
    const byKey = Object.fromEntries(first.map((r) => [r.user.key, r]));

    // Admin can use the platform admin API and the school.
    const adminToken = await login(byKey.admin.user.email, byKey.admin.password!);
    await request(app).get("/api/v1/admin/tenants").set("Authorization", `Bearer ${adminToken}`).expect(200);

    // Teacher sees the class with a scheduled live lesson; student is enrolled; parent sees the child.
    const tenant = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${adminToken}`)).body.memberships.find((m: any) => m.slug === "demo-school").tenant_id;
    const as = async (key: string) => ({ Authorization: `Bearer ${await login(byKey[key].user.email, byKey[key].password!)}`, "X-Tenant-Id": tenant });
    const classes = await request(app).get("/api/v1/classes").set(await as("teacher")).expect(200);
    expect(classes.body.classes[0]).toMatchObject({ name: "8-A Science", students: 2 });
    expect(classes.body.classes[0].sessions[0].status).toBe("scheduled");
    expect((await request(app).get("/api/v1/classes").set(await as("student1")).expect(200)).body.classes).toHaveLength(1);
    const children = await request(app).get("/api/v1/parents/children").set(await as("parent")).expect(200);
    expect(children.body.children.map((c: any) => c.name)).toEqual(["Ravi Kumar"]);

    // Re-running keeps passwords unless asked to reset, and does not duplicate data.
    const second = await setupDemo();
    expect(second.every((r) => r.password === null)).toBe(true);
    await login(byKey.teacher.user.email, byKey.teacher.password!);
    expect((await request(app).get("/api/v1/classes").set(await as("teacher"))).body.classes[0].sessions).toHaveLength(1);

    const reset = await setupDemo({ reset: true, password: "Chosen#Pass2026" });
    expect(reset.every((r) => r.password === "Chosen#Pass2026")).toBe(true);
    await login(byKey.student2.user.email, "Chosen#Pass2026");
  });
});
