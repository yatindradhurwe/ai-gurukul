/** Transport, hostels and student engagement (XP, levels, streaks, badges). */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { levelFor, streaks, xpForLevel } from "../src/modules/school/engagement.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

describe("levels and streaks", () => {
  it("levels need 50·(n−1)² XP", () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 50, 200, 450, 800]);
    expect(levelFor(0)).toMatchObject({ number: 1, name: "Seedling", progress: 0 });
    expect(levelFor(125)).toMatchObject({ number: 2, name: "Sprout", floorXp: 50, nextXp: 200, progress: 50 });
    expect(levelFor(1e6).name).toBe("Legend");
  });

  it("counts consecutive days, allowing yesterday to keep the streak alive", () => {
    const days = new Set(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-19"]);
    expect(streaks(days, "2026-10-20")).toEqual({ current: 1, best: 3 });
    expect(streaks(days, "2026-10-19")).toEqual({ current: 1, best: 3 });
    expect(streaks(new Set(["2026-10-18", "2026-10-19", "2026-10-20"]), "2026-10-20")).toEqual({ current: 3, best: 3 });
    expect(streaks(new Set(["2026-10-10"]), "2026-10-20")).toEqual({ current: 0, best: 1 });
  });
});

describe.skipIf(!dbAvailable)("transport, hostels and engagement", () => {
  let owner: Session;
  let teacher: Session;
  let tm: Session;
  let warden: Session;
  let s1: Session;
  let s2: Session;
  let s3: Session;
  let parent: Session;
  let schoolId: string;
  let classId: string;
  const profile: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    owner = await register("parent", "Principal");
    schoolId = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant.id;
    owner = { ...owner, tenantId: schoolId, headers: { ...owner.headers, "X-Tenant-Id": schoolId } };
    const join = async (role: string, name: string) => {
      const email = uniqueEmail(role);
      await request(app).post("/api/v1/auth/register").send({ name, email, password: "password-1234", accountType: "student" }).expect(201);
      const inv = await api.post(owner, `/api/v1/tenants/${schoolId}/invitations`, { email, role }).expect(201);
      const s = await login(email, "password-1234", schoolId);
      await api.post(s, "/api/v1/tenants/invitations/accept", { token: inv.body.token }).expect(200);
      return s;
    };
    teacher = await join("teacher", "Meera Teacher");
    tm = await join("transport_manager", "Tarun Transport");
    warden = await join("warden", "Wanda Warden");
    s1 = await join("student", "Ravi Kumar");
    s2 = await join("student", "Anya Singh");
    s3 = await join("student", "Kabir Das");
    parent = await join("parent", "Sunita Kumar");
    for (const s of [s1, s2, s3]) profile[s.userId] = (await api.get(s, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    await sql(`INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'mother','granted')`, [schoolId, parent.userId, profile[s1.userId]]);
    classId = (await api.post(teacher, "/api/v1/classes", { name: "8-A Science" }).expect(201)).body.class.id;
    await api.post(teacher, `/api/v1/classes/${classId}/enrollments`, { studentIds: [profile[s1.userId], profile[s2.userId], profile[s3.userId]] }).expect(201);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  describe("transport", () => {
    let routeId: string;
    let stops: any[];

    it("manages vehicles, routes and ordered stops", async () => {
      await api.post(teacher, "/api/v1/transport/vehicles", { registrationNo: "KA01AB1234", capacity: 2 }).expect(403);
      const v = (await api.post(tm, "/api/v1/transport/vehicles", { registrationNo: "ka01ab1234", label: "Bus 1", capacity: 2, driverName: "Ramesh", driverPhone: "9876543210" }).expect(201)).body.vehicle;
      expect(v.registration_no).toBe("KA01AB1234");
      await api.post(tm, "/api/v1/transport/vehicles", { registrationNo: "KA01AB1234", capacity: 40 }).expect(409);
      routeId = (await api.post(tm, "/api/v1/transport/routes", { name: "Route A — Jayanagar", vehicleId: v.id }).expect(201)).body.route.id;
      await api.post(tm, `/api/v1/transport/routes/${routeId}/stops`, { name: "Jayanagar 4th Block", pickupTime: "07:10", dropTime: "15:40" }).expect(201);
      await api.post(tm, `/api/v1/transport/routes/${routeId}/stops`, { name: "School gate", pickupTime: "07:45", dropTime: "15:05" }).expect(201);
      // Insert a stop in the middle.
      const r = (await api.post(tm, `/api/v1/transport/routes/${routeId}/stops`, { name: "South End Circle", pickupTime: "07:25", dropTime: "15:25", sequence: 2 }).expect(201)).body.route;
      stops = r.stops;
      expect(stops.map((s: any) => [s.sequence, s.name])).toEqual([
        [1, "Jayanagar 4th Block"],
        [2, "South End Circle"],
        [3, "School gate"],
      ]);
    });

    it("assigns riders up to the bus's capacity and shows students their bus", async () => {
      await api.put(tm, `/api/v1/transport/riders/${profile[s1.userId]}`, { stopId: stops[1].id }).expect(200);
      await api.put(tm, `/api/v1/transport/riders/${profile[s2.userId]}`, { stopId: stops[0].id }).expect(200);
      const full = await api.put(tm, `/api/v1/transport/riders/${profile[s3.userId]}`, { stopId: stops[0].id }).expect(409);
      expect(full.body.error.message).toMatch(/full/);
      // Changing stop on the same route is not a new seat.
      await api.put(tm, `/api/v1/transport/riders/${profile[s1.userId]}`, { stopId: stops[0].id, direction: "pickup" }).expect(200);
      await api.patch(tm, `/api/v1/transport/vehicles/${(await sql(`SELECT id FROM transport_vehicles`)).rows[0].id}`, { capacity: 1 }).expect(400);
      await api.delete(tm, `/api/v1/transport/stops/${stops[0].id}`).expect(409);

      const mine = (await api.get(s1, "/api/v1/transport/my").expect(200)).body;
      expect(mine).toMatchObject({ assigned: true, stopId: stops[0].id, direction: "pickup", route: { name: "Route A — Jayanagar", registration_no: "KA01AB1234", driver_phone: "9876543210" } });
      expect((await api.get(parent, `/api/v1/transport/my?studentId=${profile[s1.userId]}`).expect(200)).body.assigned).toBe(true);
      expect((await api.get(s3, "/api/v1/transport/my").expect(200)).body.assigned).toBe(false);
      await api.get(s2, `/api/v1/transport/my?studentId=${profile[s1.userId]}`).expect(403);
      await api.get(s1, "/api/v1/transport/riders").expect(403);

      const riders = (await api.get(tm, `/api/v1/transport/riders?routeId=${routeId}`).expect(200)).body.students;
      expect(riders.map((r: any) => r.name).sort()).toEqual(["Anya Singh", "Ravi Kumar"]);
      await api.delete(tm, `/api/v1/transport/routes/${routeId}`).expect(409);
    });
  });

  describe("hostels", () => {
    let roomA: string;
    let roomB: string;

    it("allocates beds within capacity, moves and vacates students", async () => {
      await api.post(tm, "/api/v1/hostels", { name: "Ganga House" }).expect(403);
      const h = (await api.post(warden, "/api/v1/hostels", { name: "Ganga House", kind: "boys", wardenId: warden.userId, phone: "080-1234" }).expect(201)).body.hostel;
      roomA = (await api.post(warden, `/api/v1/hostels/${h.id}/rooms`, { roomNo: "101", floor: 1, capacity: 2 }).expect(201)).body.room.id;
      roomB = (await api.post(warden, `/api/v1/hostels/${h.id}/rooms`, { roomNo: "102", floor: 1, capacity: 1 }).expect(201)).body.room.id;
      await api.post(warden, `/api/v1/hostels/${h.id}/rooms`, { roomNo: "101", capacity: 2 }).expect(409);

      await api.post(warden, `/api/v1/hostels/rooms/${roomA}/allocations`, { studentId: profile[s1.userId] }).expect(201);
      await api.post(warden, `/api/v1/hostels/rooms/${roomA}/allocations`, { studentId: profile[s3.userId] }).expect(201);
      await api.post(warden, `/api/v1/hostels/rooms/${roomA}/allocations`, { studentId: profile[s2.userId] }).expect(409);
      await api.post(warden, `/api/v1/hostels/rooms/${roomA}/allocations`, { studentId: profile[s1.userId] }).expect(409);
      await api.patch(warden, `/api/v1/hostels/rooms/${roomA}`, { capacity: 1 }).expect(400);

      const mine = (await api.get(s1, "/api/v1/hostels/my").expect(200)).body;
      expect(mine).toMatchObject({ resident: true, room: { hostel: "Ganga House", room_no: "101", warden: "Wanda Warden", roommates: ["Kabir Das"] } });
      expect((await api.get(parent, `/api/v1/hostels/my?studentId=${profile[s1.userId]}`).expect(200)).body.room.room_no).toBe("101");

      // Moving to room 102 frees the bed in 101; history is kept.
      await api.post(warden, `/api/v1/hostels/rooms/${roomB}/allocations`, { studentId: profile[s1.userId] }).expect(201);
      expect((await sql(`SELECT count(*)::int AS n FROM hostel_allocations WHERE student_id = $1`, [profile[s1.userId]])).rows[0].n).toBe(2);
      const list = (await api.get(warden, "/api/v1/hostels").expect(200)).body.hostels[0];
      expect(list).toMatchObject({ beds: 3, occupied: 2, warden: "Wanda Warden" });
      expect(list.roomList.find((r: any) => r.room_no === "101").residents.map((x: any) => x.name)).toEqual(["Kabir Das"]);

      const alloc = (await sql(`SELECT id FROM hostel_allocations WHERE student_id = $1 AND end_date IS NULL`, [profile[s3.userId]])).rows[0].id;
      await api.post(warden, `/api/v1/hostels/allocations/${alloc}/vacate`).expect(200);
      await api.post(warden, `/api/v1/hostels/allocations/${alloc}/vacate`).expect(404);
      expect((await api.get(s3, "/api/v1/hostels/my").expect(200)).body.resident).toBe(false);
      await api.get(s1, "/api/v1/hostels").expect(403);
    });
  });

  describe("engagement", () => {
    it("turns real activity into XP, levels, badges, goals and a class leaderboard", async () => {
      const fresh = (await api.get(s2, "/api/v1/engagement/me").expect(200)).body;
      expect(fresh).toMatchObject({ xp: 0, level: { number: 1, name: "Seedling" }, streak: { current: 0, best: 0 } });

      // Ravi: attends today and yesterday, submits homework, asks 12 questions today (capped at 10).
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      await api.post(teacher, `/api/v1/attendance/classes/${classId}`, { date: yesterday, records: [{ studentId: profile[s1.userId], status: "present" }] }).expect(200);
      await api.post(teacher, `/api/v1/attendance/classes/${classId}`, { date: today, records: [{ studentId: profile[s1.userId], status: "late" }, { studentId: profile[s2.userId], status: "absent" }] }).expect(200);
      const a = (await api.post(teacher, "/api/v1/assignments", { classId, title: "Worksheet", maxPoints: 10 }).expect(201)).body.assignment;
      await api.post(s1, `/api/v1/assignments/${a.id}/submit`, { content: "done" }).expect(201);
      const session = (await sql(`INSERT INTO tutor_sessions (tenant_id, student_id) VALUES ($1,$2) RETURNING id`, [schoolId, profile[s1.userId]])).rows[0].id;
      for (let i = 0; i < 12; i++) await sql(`INSERT INTO tutor_messages (tenant_id, session_id, role, content) VALUES ($1,$2,'student',$3)`, [schoolId, session, `q${i}`]);

      const me = (await api.get(s1, "/api/v1/engagement/me").expect(200)).body;
      // 2 × attendance (10) + assignment (25) + 10 capped questions (5) = 95
      expect(me.xp).toBe(95);
      expect(me.level).toMatchObject({ number: 2, name: "Sprout" });
      expect(me.streak.current).toBeGreaterThanOrEqual(1);
      expect(me.goals.find((g: any) => g.id === "ask").value).toBe(1);
      expect(me.badges.find((b: any) => b.id === "first-steps").earned).toBe(true);
      expect(me.badges.find((b: any) => b.id === "curious")).toMatchObject({ value: 10, earned: true });
      expect(me.badges.find((b: any) => b.id === "homework-hero")).toMatchObject({ value: 1, earned: false });
      expect(me.leaderboard[0]).toMatchObject({ name: "You", me: true, rank: 1 });
      expect(me.leaderboard.map((r: any) => r.name)).toEqual(expect.arrayContaining(["Anya S.", "Kabir D."]));

      expect((await api.get(parent, `/api/v1/engagement/me?studentId=${profile[s1.userId]}`).expect(200)).body.xp).toBe(95);
      await api.get(s2, `/api/v1/engagement/me?studentId=${profile[s1.userId]}`).expect(403);
    });

    it("adds bus, room and role summaries to dashboards", async () => {
      const student = (await api.get(s2, "/api/v1/dashboard").expect(200)).body.student;
      expect(student.bus).toMatchObject({ route: "Route A — Jayanagar", stop: "Jayanagar 4th Block", pickup_time: "07:10" });
      expect(student.room).toBeNull();
      expect(Object.keys((await api.get(tm, "/api/v1/dashboard").expect(200)).body)).toEqual(["transport"]);
      expect((await api.get(warden, "/api/v1/dashboard").expect(200)).body.hostel).toEqual({ beds: 3, occupied: 1, hostels: 1 });
    });
  });

  it("keeps transport and hostel records inside their organization", async () => {
    const other = await register("student", "Other Org");
    const stop = (await sql(`SELECT id FROM transport_stops LIMIT 1`)).rows[0].id;
    // A family owner manages their own workspace but cannot see this school's stops or rooms.
    await api.put(other, `/api/v1/transport/riders/${profile[s3.userId]}`, { stopId: stop }).expect(404);
    expect((await api.get(other, "/api/v1/transport/my").expect(200)).body.assigned).toBe(false);
    expect((await api.get(other, "/api/v1/hostels/my").expect(200)).body.resident).toBe(false);
  });
});
