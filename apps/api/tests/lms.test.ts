/** Core LMS: announcements, assignments, attendance, timetable, gradebook and report cards. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { gradeFor } from "../src/modules/lms/access.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

describe("grade bands", () => {
  it("follows the CBSE nine-point scale boundaries", () => {
    expect([95, 91, 85, 75, 65, 55, 45, 35, 20].map(gradeFor)).toEqual(["A1", "A1", "A2", "B1", "B2", "C1", "C2", "D", "E"]);
    expect(gradeFor(null)).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("LMS features", () => {
  let owner: Session;
  let teacher: Session;
  let otherTeacher: Session;
  let staffHr: Session;
  let s1: Session;
  let s2: Session;
  let parent: Session;
  let outsider: Session;
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
    otherTeacher = await join("teacher", "Other Teacher");
    staffHr = await join("staff", "Kavita HR");
    s1 = await join("student", "Ravi Kumar");
    s2 = await join("student", "Anya Singh");
    outsider = await join("student", "Not Enrolled");
    parent = await join("parent", "Sunita Kumar");
    for (const s of [s1, s2, outsider]) profile[s.userId] = (await api.get(s, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    await sql(`INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'mother','granted')`, [
      schoolId,
      parent.userId,
      profile[s1.userId],
    ]);

    classId = (await api.post(teacher, "/api/v1/classes", { name: "8-A Science" }).expect(201)).body.class.id;
    await api.post(teacher, `/api/v1/classes/${classId}/enrollments`, { studentIds: [profile[s1.userId], profile[s2.userId]] }).expect(201);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  it("announcements reach the right audience and track reads", async () => {
    // A teacher can only post to their own class, not the whole school.
    await api.post(teacher, "/api/v1/announcements", { title: "School trip", body: "Bring lunch" }).expect(403);
    await api.post(teacher, "/api/v1/announcements", { title: "Test on Friday", body: "Chapter 11", classId }).expect(201);
    await api.post(staffHr, "/api/v1/announcements", { title: "Parents meeting", body: "Saturday 10am", audience: "parents", pinned: true }).expect(201);
    await api.post(s1, "/api/v1/announcements", { title: "x", body: "y" }).expect(403);

    const forS1 = (await api.get(s1, "/api/v1/announcements").expect(200)).body;
    expect(forS1.announcements.map((a: any) => a.title)).toEqual(["Test on Friday"]);
    expect(forS1.unread).toBe(1);
    await api.post(s1, `/api/v1/announcements/${forS1.announcements[0].id}/read`).expect(200);
    expect((await api.get(s1, "/api/v1/announcements").expect(200)).body.unread).toBe(0);

    const forOutsider = (await api.get(outsider, "/api/v1/announcements").expect(200)).body.announcements;
    expect(forOutsider).toHaveLength(0);
    const forParent = (await api.get(parent, "/api/v1/announcements").expect(200)).body.announcements;
    expect(forParent.map((a: any) => a.title).sort()).toEqual(["Parents meeting", "Test on Friday"]);
    expect(forParent[0].pinned).toBe(true);
  });

  it("assignments: create, submit, grade, and visibility per role", async () => {
    const a = (await api.post(teacher, "/api/v1/assignments", { classId, title: "Pressure worksheet", maxPoints: 10 }).expect(201)).body.assignment;
    await api.post(otherTeacher, "/api/v1/assignments", { classId, title: "Not mine", maxPoints: 10 }).expect(403);

    await api.post(outsider, `/api/v1/assignments/${a.id}/submit`, { content: "hi" }).expect(403);
    const sub = (await api.post(s1, `/api/v1/assignments/${a.id}/submit`, { content: "Pressure = force / area" }).expect(201)).body.submission;

    const mine = (await api.get(s1, "/api/v1/assignments").expect(200)).body.assignments;
    expect(mine[0].state).toBe("submitted");
    const s2View = (await api.get(s2, "/api/v1/assignments").expect(200)).body.assignments;
    expect(s2View[0].state).toBe("pending");

    const staffView = (await api.get(teacher, `/api/v1/assignments/${a.id}`).expect(200)).body;
    expect(staffView.submissions).toHaveLength(2);
    expect(staffView.submissions.filter((r: any) => r.submission)).toHaveLength(1);

    await api.post(teacher, `/api/v1/assignments/${a.id}/submissions/${sub.id}/grade`, { points: 11 }).expect(400);
    await api.post(teacher, `/api/v1/assignments/${a.id}/submissions/${sub.id}/grade`, { points: 9, feedback: "Good" }).expect(200);
    await api.post(s1, `/api/v1/assignments/${a.id}/submit`, { content: "changed" }).expect(409);

    // The parent sees their child's graded work, but not another student's.
    const child = (await api.get(parent, `/api/v1/assignments?studentId=${profile[s1.userId]}`).expect(200)).body.assignments;
    expect(child[0]).toMatchObject({ state: "graded", feedback: "Good" });
    await api.get(parent, `/api/v1/assignments?studentId=${profile[s2.userId]}`).expect(403);

    await api.patch(teacher, `/api/v1/assignments/${a.id}`, { status: "closed" }).expect(200);
    await api.post(s2, `/api/v1/assignments/${a.id}/submit`, { content: "late" }).expect(409);
  });

  it("attendance: teacher marks a day, students and parents see their rate", async () => {
    const day = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    await api.post(s1, `/api/v1/attendance/classes/${classId}`, { date: day(0), records: [{ studentId: profile[s1.userId], status: "present" }] }).expect(403);
    await api.post(teacher, `/api/v1/attendance/classes/${classId}`, { date: day(0), records: [{ studentId: profile[outsider.userId], status: "present" }] }).expect(400);
    await api.post(teacher, `/api/v1/attendance/classes/${classId}`, { date: day(-2), records: [{ studentId: profile[s1.userId], status: "present" }] }).expect(400);

    for (const [d, s1Status] of [[2, "present"], [1, "late"], [0, "absent"]] as const) {
      await api
        .post(teacher, `/api/v1/attendance/classes/${classId}`, {
          date: day(d),
          records: [
            { studentId: profile[s1.userId], status: s1Status },
            { studentId: profile[s2.userId], status: "present" },
          ],
        })
        .expect(200);
    }
    const sheet = (await api.get(teacher, `/api/v1/attendance/classes/${classId}?date=${day(1)}`).expect(200)).body;
    expect(sheet.marked).toBe(true);
    expect(sheet.students.find((s: any) => s.student_id === profile[s1.userId]).status).toBe("late");

    const own = (await api.get(s1, "/api/v1/attendance/students").expect(200)).body.summary;
    expect(own).toMatchObject({ attended: 2, absent: 1, late: 1, rate: 66.7 });
    const viaParent = (await api.get(parent, `/api/v1/attendance/students?studentId=${profile[s1.userId]}`).expect(200)).body.summary;
    expect(viaParent.rate).toBe(66.7);
    await api.get(s2, `/api/v1/attendance/students?studentId=${profile[s1.userId]}`).expect(403);

    const report = (await api.get(teacher, `/api/v1/attendance/classes/${classId}/report`).expect(200)).body;
    expect(report.days).toBe(3);
    expect(report.students.find((s: any) => s.student_id === profile[s2.userId]).rate).toBe(100);
  });

  it("timetable: periods are visible to the class and clashes are refused", async () => {
    await api.post(teacher, "/api/v1/timetable", { classId, dayOfWeek: 1, startTime: "09:00", endTime: "09:45", subject: "Science", room: "Lab 1" }).expect(201);
    const clash = await api.post(teacher, "/api/v1/timetable", { classId, dayOfWeek: 1, startTime: "09:30", endTime: "10:15", subject: "Maths" }).expect(409);
    expect(clash.body.error.message).toMatch(/overlaps/);
    await api.post(teacher, "/api/v1/timetable", { classId, dayOfWeek: 1, startTime: "10:00", endTime: "09:00", subject: "Maths" }).expect(400);
    await api.post(s1, "/api/v1/timetable", { classId, dayOfWeek: 2, startTime: "09:00", endTime: "09:45", subject: "Maths" }).expect(403);

    const slots = (await api.get(s1, "/api/v1/timetable").expect(200)).body.slots;
    expect(slots).toEqual([expect.objectContaining({ subject: "Science", start_time: "09:00", end_time: "09:45", room: "Lab 1", teacher: "Meera Teacher" })]);
    expect((await api.get(outsider, "/api/v1/timetable").expect(200)).body.slots).toHaveLength(0);
  });

  it("gradebook feeds the report card", async () => {
    const t1 = (await api.post(teacher, `/api/v1/gradebook/classes/${classId}/items`, { title: "Unit test 1", maxMarks: 20 }).expect(201)).body.item;
    const t2 = (await api.post(teacher, `/api/v1/gradebook/classes/${classId}/items`, { title: "Project", maxMarks: 30, category: "project" }).expect(201)).body.item;
    await api.put(teacher, `/api/v1/gradebook/items/${t1.id}/scores`, { scores: [{ studentId: profile[s1.userId], marks: 25 }] }).expect(400);
    await api.put(teacher, `/api/v1/gradebook/items/${t1.id}/scores`, { scores: [{ studentId: profile[s1.userId], marks: 18 }, { studentId: profile[s2.userId], marks: 10 }] }).expect(200);
    await api.put(teacher, `/api/v1/gradebook/items/${t2.id}/scores`, { scores: [{ studentId: profile[s1.userId], marks: 27, remarks: "Excellent model" }] }).expect(200);
    await api.put(otherTeacher, `/api/v1/gradebook/items/${t2.id}/scores`, { scores: [{ studentId: profile[s2.userId], marks: 30 }] }).expect(403);

    const book = (await api.get(teacher, `/api/v1/gradebook/classes/${classId}`).expect(200)).body;
    const ravi = book.students.find((s: any) => s.student_id === profile[s1.userId]);
    expect(ravi).toMatchObject({ percent: 90, grade: "A2" });
    expect(book.terms).toEqual(["Term 1"]);
    await api.get(s1, `/api/v1/gradebook/classes/${classId}`).expect(403);

    const card = (await api.get(s1, "/api/v1/gradebook/report-card").expect(200)).body;
    expect(card.subjects[0]).toMatchObject({ name: "8-A Science", obtained: 45, max: 50, percent: 90, grade: "A2" });
    expect(card.overall).toEqual({ percent: 90, grade: "A2" });
    expect(card.attendance.rate).toBe(66.7);
    expect(card.assignments).toMatchObject({ total: 1, submitted: 1, averagePercent: 90 });

    const viaParent = (await api.get(parent, `/api/v1/gradebook/report-card?studentId=${profile[s1.userId]}`).expect(200)).body;
    expect(viaParent.overall.grade).toBe("A2");
    await api.get(parent, `/api/v1/gradebook/report-card?studentId=${profile[s2.userId]}`).expect(403);
    const viaTeacher = (await api.get(teacher, `/api/v1/gradebook/report-card?studentId=${profile[s2.userId]}`).expect(200)).body;
    expect(viaTeacher.subjects[0]).toMatchObject({ percent: 50, grade: "C2" });
  });

  it("the dashboard shows each role only its own sections", async () => {
    const forOwner = (await api.get(owner, "/api/v1/dashboard").expect(200)).body;
    expect(forOwner.organization).toMatchObject({ students: 3, teachers: 2, classes: 1 });
    expect(forOwner.student).toBeUndefined();

    const forTeacher = (await api.get(teacher, "/api/v1/dashboard").expect(200)).body;
    expect(forTeacher.organization).toBeUndefined();
    expect(forTeacher.teaching.classes).toHaveLength(1);

    const forStudent = (await api.get(s1, "/api/v1/dashboard").expect(200)).body;
    expect(Object.keys(forStudent)).toEqual(["student"]);
    expect(forStudent.student.attendanceRate).toBe(66.7);

    const forParent = (await api.get(parent, "/api/v1/dashboard").expect(200)).body;
    expect(forParent.children).toEqual([expect.objectContaining({ name: "Ravi Kumar", attendanceRate: 66.7, pending: 0 })]);

    const forHr = (await api.get(staffHr, "/api/v1/dashboard").expect(200)).body;
    expect(forHr.organization.students).toBe(3);
    expect(forHr.teaching).toBeUndefined();
  });

  it("keeps every LMS record inside its own organization", async () => {
    const family = await register("student", "Other Org Student");
    await api.get(family, `/api/v1/assignments/${(await sql(`SELECT id FROM assignments LIMIT 1`)).rows[0].id}`).expect(404);
    // The family owner may manage classes in their own workspace, but row-level security hides this school's class.
    await api.get(family, `/api/v1/attendance/classes/${classId}`).expect(404);
    expect((await api.get(family, "/api/v1/announcements").expect(200)).body.announcements).toHaveLength(0);
    expect((await api.get(family, "/api/v1/timetable").expect(200)).body.slots).toHaveLength(0);
  });
});
