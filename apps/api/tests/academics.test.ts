/** Academic years, syllabi, class subjects and the auto-generated syllabus plan. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holidaysBetween } from "../src/modules/academics/holidays.js";
import { isoDow, planUnits, teachingDays, type Term } from "../src/modules/academics/planner.js";
import { liveHub } from "../src/modules/live/events.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

const terms: Term[] = [
  { seq: 1, name: "Term 1", start: "2030-04-01", end: "2030-04-30", examStart: "2030-04-25", examEnd: "2030-04-30" },
  { seq: 2, name: "Term 2", start: "2030-05-01", end: "2030-05-31", examStart: null, examEnd: null },
];

describe("planner", () => {
  it("counts Monday–Saturday teaching days, skipping holidays, exams and gaps between terms", () => {
    const days = teachingDays({ from: "2030-04-01", to: "2030-05-31", holidays: new Set(["2030-04-02"]), terms, capacityFor: () => 1 });
    expect(days.some((d) => isoDow(d.date) === 7)).toBe(false);
    expect(days.some((d) => d.date === "2030-04-02")).toBe(false);
    expect(days.some((d) => d.date >= "2030-04-25" && d.date <= "2030-04-30")).toBe(false);
    expect(days.filter((d) => d.termSeq === 1).at(-1)!.date).toBe("2030-04-24");
    // Only Mondays when the timetable has the subject on Mondays.
    const mondays = teachingDays({ from: "2030-04-01", to: "2030-04-30", holidays: new Set(), terms: [], capacityFor: (dow) => (dow === 1 ? 2 : 0) });
    expect(mondays.map((d) => d.date)).toEqual(["2030-04-01", "2030-04-08", "2030-04-15", "2030-04-22", "2030-04-29"]);
  });

  it("lays chapters out in order and compresses with a warning when time is short", () => {
    const days = teachingDays({ from: "2030-04-01", to: "2030-04-30", holidays: new Set(), terms: [], capacityFor: () => 1 });
    const r = planUnits([{ id: "a", est: 2, termSeq: null }, { id: "b", est: 3, termSeq: null }], [], days);
    expect(r.warnings).toEqual([]);
    expect(r.allocations.map((a) => [a.unitId, a.start, a.end, a.periods])).toEqual([
      ["a", "2030-04-01", "2030-04-02", 2],
      ["b", "2030-04-03", "2030-04-05", 3],
    ]);
    const tight = planUnits([{ id: "a", est: 30, termSeq: null }, { id: "b", est: 30, termSeq: null }], [], days);
    expect(tight.warnings[0]).toMatch(/needs 60 periods but only 26/);
    expect(tight.allocations[1].end).toBe("2030-04-30");
  });

  it("splits chapters across terms by teaching time and keeps fixed terms", () => {
    const days = teachingDays({ from: "2030-04-01", to: "2030-05-31", holidays: new Set(), terms, capacityFor: () => 1 });
    const units = [10, 10, 10, 10].map((est, i) => ({ id: String(i), est, termSeq: null as number | null }));
    const r = planUnits(units, terms, days);
    expect(r.allocations.map((a) => a.termSeq)).toEqual([1, 1, 2, 2]);
    expect(r.allocations[1].end! < "2030-04-25").toBe(true);
    units[3].termSeq = 1;
    expect(planUnits(units, terms, days).allocations.map((a) => a.termSeq)).toEqual([1, 1, 2, 1]);
  });

  it("suggests national holidays for any year and marks lunar festivals approximate", () => {
    const h = holidaysBetween("2026-04-01", "2027-03-31");
    expect(h.find((x) => x.name === "Independence Day")).toEqual({ date: "2026-08-15", name: "Independence Day", approximate: false });
    expect(h.find((x) => x.name === "Diwali")?.approximate).toBe(true);
    expect(holidaysBetween("2030-04-01", "2031-03-31").every((x) => !x.approximate)).toBe(true);
  });
});

describe.skipIf(!dbAvailable)("academic planning", () => {
  let owner: Session;
  let teacher: Session;
  let other: Session;
  let s1: Session;
  let parent: Session;
  let schoolId: string;
  let classId: string;
  let yearId: string;
  let science: string;
  let maths: string;
  let profile1: string;

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
    other = await join("teacher", "Other Teacher");
    s1 = await join("student", "Ravi Kumar");
    parent = await join("parent", "Sunita Kumar");
    profile1 = (await api.get(s1, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    await sql(`INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'mother','granted')`, [schoolId, parent.userId, profile1]);
    classId = (await api.post(owner, "/api/v1/classes", { name: "Class 8-A", teacherId: other.userId }).expect(201)).body.class.id;
    await api.post(owner, `/api/v1/classes/${classId}/enrollments`, { studentIds: [profile1] }).expect(201);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  it("sets up a future academic year with terms and holidays", async () => {
    await api.post(teacher, "/api/v1/academics/years", { name: "2030-31", startDate: "2030-04-01", endDate: "2031-03-31" }).expect(403);
    yearId = (await api.post(owner, "/api/v1/academics/years", { name: "2030-31", startDate: "2030-04-01", endDate: "2031-03-31" }).expect(201)).body.year.id;
    await api.post(owner, `/api/v1/academics/years/${yearId}/terms`, { name: "Term 1", startDate: "2030-04-01", endDate: "2030-09-30", examStart: "2030-09-16", examEnd: "2030-09-30" }).expect(201);
    await api.post(owner, `/api/v1/academics/years/${yearId}/terms`, { name: "Term 2", startDate: "2030-10-01", endDate: "2031-03-31", examStart: "2031-03-10", examEnd: "2031-03-31" }).expect(201);
    await api.post(owner, `/api/v1/academics/years/${yearId}/terms`, { name: "Overlap", startDate: "2030-09-01", endDate: "2030-10-15" }).expect(409);
    const sugg = (await api.get(owner, `/api/v1/academics/years/${yearId}/holiday-suggestions`).expect(200)).body.holidays;
    expect(sugg.map((h: any) => h.name)).toEqual(expect.arrayContaining(["Independence Day", "Gandhi Jayanti", "Christmas", "Republic Day"]));
    const added = (await api.post(owner, `/api/v1/academics/years/${yearId}/holidays`, { holidays: [...sugg, { date: "2030-10-28", endDate: "2030-11-01", name: "Diwali break" }] }).expect(201)).body.added;
    expect(added).toBe(sugg.length + 1);
    expect((await api.post(owner, `/api/v1/academics/years/${yearId}/holidays`, { holidays: sugg }).expect(201)).body.added).toBe(0);
    const year = (await api.get(owner, "/api/v1/academics/years").expect(200)).body.years[0];
    expect(year).toMatchObject({ name: "2030-31", is_current: true });
    expect(year.terms).toHaveLength(2);
    expect(year.teachingDays).toBeGreaterThan(200);
  });

  it("imports a syllabus, gives the class its subjects and links them automatically", async () => {
    const lib = (await api.get(owner, "/api/v1/academics/library").expect(200)).body.library;
    const sci = lib.find((l: any) => l.subject === "Science");
    expect(sci).toMatchObject({ board: "CBSE", grade: "Class 8" });
    const imported = (await api.post(owner, "/api/v1/academics/syllabi/import", { curriculumVersionId: sci.curriculum_version_id, subjectId: sci.subject_id, academicYearId: yearId }).expect(201)).body.syllabus;
    await api.post(owner, "/api/v1/academics/syllabi/import", { curriculumVersionId: sci.curriculum_version_id, subjectId: sci.subject_id, academicYearId: yearId }).expect(409);
    const m = (
      await api.post(owner, "/api/v1/academics/syllabi", {
        board: "CBSE",
        grade: "Class 8",
        subject: "Mathematics",
        academicYearId: yearId,
        units: [{ title: "Rational numbers", estPeriods: 12 }, { title: "Linear equations", estPeriods: 14 }, { title: "Mensuration", estPeriods: 16, term: 2 }],
      }).expect(201)
    ).body.syllabus;

    await api.patch(owner, `/api/v1/academics/classes/${classId}`, { board: "CBSE", grade: "Class 8", section: "A", academicYearId: yearId }).expect(200);
    science = (await api.post(owner, `/api/v1/academics/classes/${classId}/subjects`, { subject: "Science", teacherId: teacher.userId, periodsPerWeek: 6 }).expect(201)).body.subject.id;
    maths = (await api.post(owner, `/api/v1/academics/classes/${classId}/subjects`, { subject: "Mathematics", teacherId: other.userId, periodsPerWeek: 6 }).expect(201)).body.subject.id;
    await api.post(owner, `/api/v1/academics/classes/${classId}/subjects`, { subject: "science", periodsPerWeek: 4 }).expect(409);
    await api.post(owner, `/api/v1/academics/classes/${classId}/subjects`, { subject: "Art", teacherId: s1.userId }).expect(400);
    const classes = (await api.get(owner, "/api/v1/academics/classes").expect(200)).body.classes;
    const subjects = classes[0].subjects;
    expect(subjects.find((s: any) => s.subject === "Science").syllabus_id).toBe(imported.id);
    expect(subjects.find((s: any) => s.subject === "Mathematics").syllabus_id).toBe(m.id);
  });

  it("generates a dated plan over teaching days, term by term", async () => {
    await api.post(s1, "/api/v1/academics/plans/generate").expect(403);
    expect((await api.post(owner, "/api/v1/academics/plans/generate").expect(200)).body).toMatchObject({ subjects: 2, planned: 2 });
    const plan = (await api.get(teacher, `/api/v1/academics/class-subjects/${maths}/plan`).expect(200)).body;
    expect(plan.canEdit).toBe(false);
    expect(plan.items.map((i: any) => [i.title, i.term_sequence])).toEqual([
      ["Rational numbers", 1],
      ["Linear equations", 1],
      ["Mensuration", 2],
    ]);
    const holidays = (await sql(`SELECT start_date::text AS s, end_date::text AS e FROM school_events WHERE kind = 'holiday'`)).rows;
    for (const i of plan.items) {
      expect(isoDow(i.planned_start)).not.toBe(7);
      expect(holidays.some((h: any) => i.planned_start >= h.s && i.planned_start <= h.e)).toBe(false);
    }
    expect(plan.items[1].planned_end < "2030-09-16").toBe(true);
    expect(plan.items[2].planned_start >= "2030-10-01").toBe(true);

    const sci = (await api.get(teacher, `/api/v1/academics/class-subjects/${science}/plan`).expect(200)).body;
    expect(sci.canEdit).toBe(true);
    expect(sci.items.length).toBeGreaterThan(0);
    expect(sci.subject.state).toBe("on_track");
  });

  it("subject teachers update their plan; completed chapters survive re-planning", async () => {
    const items = (await api.get(other, `/api/v1/academics/class-subjects/${maths}/plan`).expect(200)).body.items;
    await api.patch(teacher, `/api/v1/academics/plan-items/${items[0].id}`, { status: "completed" }).expect(403);
    const done = (await api.patch(other, `/api/v1/academics/plan-items/${items[0].id}`, { status: "completed", note: "Revised with worksheet" }).expect(200)).body.item;
    expect(done.completed_on).toBeTruthy();
    await api.post(other, `/api/v1/academics/class-subjects/${maths}/plan`).expect(200);
    const again = (await api.get(other, `/api/v1/academics/class-subjects/${maths}/plan`).expect(200)).body.items;
    expect(again[0]).toMatchObject({ status: "completed", note: "Revised with worksheet", planned_start: items[0].planned_start });
  });

  it("shows the principal every class and subject, flagging what is behind", async () => {
    // Pretend a science chapter was due last week and isn't done.
    await sql(`UPDATE syllabus_plan_items SET planned_end = current_date - 7 WHERE class_subject_id = $1 AND unit_id = (SELECT unit_id FROM syllabus_plan_items WHERE class_subject_id = $1 ORDER BY planned_start LIMIT 1)`, [science]);
    await api.get(teacher, "/api/v1/academics/overview").expect(403);
    const o = (await api.get(owner, "/api/v1/academics/overview").expect(200)).body;
    expect(o.subjects).toEqual(["Mathematics", "Science"]);
    expect(o.classes).toEqual([expect.objectContaining({ name: "Class 8-A", board: "CBSE", grade: "Class 8", section: "A" })]);
    const sci = o.cells.find((c: any) => c.subject === "Science");
    expect(sci).toMatchObject({ teacher: "Meera Teacher", state: "behind", behind: 1 });
    expect(o.cells.find((c: any) => c.subject === "Mathematics")).toMatchObject({ completed: 1, state: "ahead" });
    expect(o.totals.behind).toBe(1);

    const mine = (await api.get(teacher, "/api/v1/academics/my-subjects").expect(200)).body.subjects;
    expect(mine.map((s: any) => [s.class_name, s.subject, s.state])).toEqual([["Class 8-A", "Science", "behind"]]);
  });

  it("students and parents see what is being taught now and next", async () => {
    const st = (await api.get(s1, "/api/v1/academics/student").expect(200)).body.subjects;
    const m = st.find((s: any) => s.subject === "Mathematics");
    expect(m).toMatchObject({ teacher: "Other Teacher", completed: 1, total: 3 });
    expect(m.now.title).toBe("Linear equations");
    expect(m.next.title).toBe("Mensuration");
    expect((await api.get(parent, `/api/v1/academics/student?studentId=${profile1}`).expect(200)).body.subjects).toHaveLength(2);
    await api.get(s1, `/api/v1/academics/class-subjects/${maths}/plan`).expect(200);
    const outsider = await register("student", "Other Org");
    await api.get(outsider, `/api/v1/academics/class-subjects/${maths}/plan`).expect(404);
    expect((await api.get(outsider, "/api/v1/academics/years").expect(200)).body.years).toHaveLength(0);
  });
});
