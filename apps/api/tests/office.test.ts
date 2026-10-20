/** Messaging and PTM, leave and the calendar, admissions and ID cards, staff HR and payroll. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { computePayslip } from "../src/modules/school/hr.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe("payslip maths", () => {
  it("pro-rates earnings by paid days and deducts PF on basic", () => {
    const s = { basic: 3000000, hra: 1200000, da: 300000, other: 0, pfPercent: 12, professionalTax: 20000, tds: 100000 };
    const full = computePayslip(s, 26, 0);
    expect(full.gross).toBe(4500000);
    expect(full.deductions["Provident fund"]).toBe(360000);
    expect(full.net).toBe(4500000 - 360000 - 20000 - 100000);
    const half = computePayslip(s, 26, 13);
    expect(half.earnings.Basic).toBe(1500000);
    expect(computePayslip(s, 26, 26)).toMatchObject({ gross: 0, net: 0 });
  });
});

describe.skipIf(!dbAvailable)("messaging, leave, admissions and HR", () => {
  let owner: Session;
  let teacher: Session;
  let other: Session;
  let hr: Session;
  let warden: Session;
  let s1: Session;
  let s2: Session;
  let parent: Session;
  let schoolId: string;
  let schoolSlug: string;
  let classId: string;
  const profile: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    owner = await register("parent", "Principal");
    const t = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant;
    schoolId = t.id;
    schoolSlug = t.slug;
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
    hr = await join("staff", "Kavita HR");
    warden = await join("warden", "Wanda Warden");
    s1 = await join("student", "Ravi Kumar");
    s2 = await join("student", "Anya Singh");
    parent = await join("parent", "Sunita Kumar");
    for (const s of [s1, s2]) profile[s.userId] = (await api.get(s, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    await sql(`INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'mother','granted')`, [schoolId, parent.userId, profile[s1.userId]]);
    classId = (await api.post(teacher, "/api/v1/classes", { name: "8-A Science" }).expect(201)).body.class.id;
    await api.post(teacher, `/api/v1/classes/${classId}/enrollments`, { studentIds: [profile[s1.userId], profile[s2.userId]] }).expect(201);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  describe("messaging", () => {
    it("parents reach their child's teacher and the office, never other families", async () => {
      const c = (await api.get(parent, "/api/v1/messages/contacts").expect(200)).body;
      const names = c.contacts.map((x: any) => x.name);
      expect(names).toEqual(expect.arrayContaining(["Meera Teacher", "Kavita HR"]));
      expect(names).not.toContain("Other Teacher");
      expect(names).not.toContain("Anya Singh");
      expect(c.children.map((k: any) => k.name)).toEqual(["Ravi Kumar"]);
      await api.post(parent, "/api/v1/messages/conversations", { recipientId: s2.userId, body: "hi" }).expect(403);
      await api.post(s1, "/api/v1/messages/conversations", { recipientId: s2.userId, body: "hi" }).expect(403);
      await api.post(parent, "/api/v1/messages/conversations", { recipientId: teacher.userId, body: "x", studentId: profile[s2.userId] }).expect(403);
    });

    it("threads messages, tracks unread and reuses the conversation", async () => {
      const id = (await api.post(parent, "/api/v1/messages/conversations", { recipientId: teacher.userId, subject: "Homework", body: "How is Ravi doing?", studentId: profile[s1.userId] }).expect(201)).body.conversationId;
      expect((await api.get(teacher, "/api/v1/messages/conversations").expect(200)).body.unread).toBe(1);
      const thread = (await api.get(teacher, `/api/v1/messages/conversations/${id}`).expect(200)).body;
      expect(thread.conversation.student).toBe("Ravi Kumar");
      expect((await api.get(teacher, "/api/v1/messages/conversations").expect(200)).body.unread).toBe(0);
      await api.post(teacher, `/api/v1/messages/conversations/${id}`, { body: "He's doing well!" }).expect(201);
      const again = (await api.post(parent, "/api/v1/messages/conversations", { recipientId: teacher.userId, body: "Thanks", studentId: profile[s1.userId] }).expect(201)).body.conversationId;
      expect(again).toBe(id);
      const msgs = (await api.get(parent, `/api/v1/messages/conversations/${id}`).expect(200)).body.messages;
      expect(msgs.map((m: any) => [m.sender, m.mine])).toEqual([["Sunita Kumar", true], ["Meera Teacher", false], ["Sunita Kumar", true]]);
      await api.get(other, `/api/v1/messages/conversations/${id}`).expect(404);
    });
  });

  describe("parent-teacher meetings", () => {
    it("teachers publish slots; a parent books one with their child's teacher", async () => {
      const r = (await api.post(teacher, "/api/v1/ptm/slots", { date: day(3), startTime: "10:00", endTime: "11:00", minutes: 15, location: "Room 8A" }).expect(201)).body;
      expect(r.created).toBe(4);
      await api.post(other, "/api/v1/ptm/slots", { date: day(3), startTime: "10:00", endTime: "10:30", minutes: 15 }).expect(201);
      const avail = (await api.get(parent, "/api/v1/ptm/available").expect(200)).body.available;
      expect(avail.every((s: any) => s.teacher === "Meera Teacher")).toBe(true);
      const otherSlot = (await sql(`SELECT id FROM ptm_slots WHERE teacher_id = $1 LIMIT 1`, [other.userId])).rows[0].id;
      await api.post(parent, `/api/v1/ptm/slots/${otherSlot}/book`, { studentId: profile[s1.userId] }).expect(403);
      await api.post(parent, `/api/v1/ptm/slots/${avail[0].id}/book`, { studentId: profile[s1.userId], note: "Maths worries" }).expect(200);
      await api.post(parent, `/api/v1/ptm/slots/${avail[1].id}/book`, { studentId: profile[s1.userId] }).expect(409);
      const mine = (await api.get(teacher, "/api/v1/ptm/slots/mine").expect(200)).body.slots;
      expect(mine.find((s: any) => s.id === avail[0].id)).toMatchObject({ booked_by_name: "Sunita Kumar", student: "Ravi Kumar", note: "Maths worries" });
      await api.post(other, `/api/v1/ptm/slots/${avail[0].id}/cancel`).expect(404);
      await api.post(parent, `/api/v1/ptm/slots/${avail[0].id}/cancel`).expect(200);
      expect((await api.get(parent, "/api/v1/ptm/available").expect(200)).body.bookings).toHaveLength(0);
    });
  });

  describe("leave and calendar", () => {
    it("approved student leave excuses absences; only the class teacher or an admin can approve", async () => {
      await api.post(teacher, `/api/v1/attendance/classes/${classId}`, { date: day(-1), records: [{ studentId: profile[s1.userId], status: "absent" }, { studentId: profile[s2.userId], status: "present" }] }).expect(200);
      const reqd = (await api.post(parent, "/api/v1/leave", { kind: "student", studentId: profile[s1.userId], startDate: day(-1), endDate: day(-1), reason: "Fever" }).expect(201)).body.request;
      await api.post(parent, "/api/v1/leave", { kind: "student", studentId: profile[s1.userId], startDate: day(-1), endDate: day(0), reason: "Again" }).expect(409);
      await api.post(parent, "/api/v1/leave", { kind: "student", studentId: profile[s2.userId], startDate: day(1), endDate: day(1), reason: "Not mine" }).expect(403);
      expect((await api.get(other, "/api/v1/leave/review?status=pending").expect(200)).body.requests).toHaveLength(0);
      await api.post(other, `/api/v1/leave/${reqd.id}/review`, { decision: "approved" }).expect(404);
      const queue = (await api.get(teacher, "/api/v1/leave/review?status=pending").expect(200)).body.requests;
      expect(queue[0]).toMatchObject({ student: "Ravi Kumar", requester: "Sunita Kumar", days: expect.any(Number) });
      await api.post(teacher, `/api/v1/leave/${reqd.id}/review`, { decision: "approved", note: "Get well soon" }).expect(200);
      await api.post(teacher, `/api/v1/leave/${reqd.id}/review`, { decision: "rejected" }).expect(409);
      const att = (await sql(`SELECT status FROM attendance_records WHERE student_id = $1 AND date = $2`, [profile[s1.userId], day(-1)])).rows[0];
      expect(att.status).toBe("excused");
      expect((await api.get(s1, "/api/v1/leave/mine").expect(200)).body.requests[0]).toMatchObject({ status: "approved", review_note: "Get well soon" });
    });

    it("staff leave goes to HR, is recorded and counted against the balance", async () => {
      // Pick a Monday–Wednesday so the three days are working days.
      const d = new Date();
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 7);
      const mon = d.toISOString().slice(0, 10);
      const wed = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
      const r = (await api.post(teacher, "/api/v1/leave", { kind: "staff", leaveType: "casual", startDate: mon, endDate: wed, reason: "Family function" }).expect(201)).body.request;
      await api.post(s1, "/api/v1/leave", { kind: "staff", startDate: mon, endDate: wed, reason: "x x x" }).expect(403);
      await api.post(teacher, `/api/v1/leave/${r.id}/review`, { decision: "approved" }).expect(404);
      await api.post(hr, `/api/v1/leave/${r.id}/review`, { decision: "approved" }).expect(200);
      const bal = (await api.get(teacher, "/api/v1/leave/balance").expect(200)).body.balances.find((x: any) => x.type === "casual");
      expect(bal).toEqual({ type: "casual", allowed: 12, used: 3, left: 9 });
      expect((await sql(`SELECT count(*)::int AS n FROM staff_attendance WHERE user_id = $1 AND status = 'leave'`, [teacher.userId])).rows[0].n).toBe(3);
    });

    it("out-passes are for hostel residents and go to the warden", async () => {
      await api.post(s1, "/api/v1/leave", { kind: "outpass", startDate: day(2), endDate: day(2), outTime: "10:00", returnTime: "18:00", reason: "Visit home" }).expect(400);
      const h = (await api.post(warden, "/api/v1/hostels", { name: "Ganga House" }).expect(201)).body.hostel;
      const room = (await api.post(warden, `/api/v1/hostels/${h.id}/rooms`, { roomNo: "101", capacity: 2 }).expect(201)).body.room;
      await api.post(warden, `/api/v1/hostels/rooms/${room.id}/allocations`, { studentId: profile[s1.userId] }).expect(201);
      const p = (await api.post(s1, "/api/v1/leave", { kind: "outpass", startDate: day(2), endDate: day(2), outTime: "10:00", returnTime: "18:00", reason: "Visit home" }).expect(201)).body.request;
      expect((await api.get(teacher, "/api/v1/leave/review?status=pending").expect(200)).body.requests.some((x: any) => x.id === p.id)).toBe(false);
      await api.post(warden, `/api/v1/leave/${p.id}/review`, { decision: "approved" }).expect(200);
    });

    it("the calendar shows events by audience plus published exam papers", async () => {
      await api.post(s1, "/api/v1/events", { title: "x", startDate: day(5) }).expect(403);
      await api.post(owner, "/api/v1/events", { title: "Diwali break", kind: "holiday", startDate: day(5), endDate: day(7) }).expect(201);
      await api.post(owner, "/api/v1/events", { title: "Staff meeting", kind: "meeting", startDate: day(6), audience: "staff" }).expect(201);
      const exam = (await api.post(owner, "/api/v1/exams", { name: "Unit test" }).expect(201)).body.exam;
      await api.post(owner, `/api/v1/exams/${exam.id}/papers`, { classId, subject: "Science", date: day(8), maxMarks: 20 }).expect(201);
      await api.patch(owner, `/api/v1/exams/${exam.id}`, { status: "published" }).expect(200);
      const forStudent = (await api.get(s1, `/api/v1/events?from=${day(0)}&to=${day(10)}`).expect(200)).body;
      expect(forStudent.events.map((e: any) => e.title)).toEqual(["Diwali break"]);
      expect(forStudent.exams.map((e: any) => e.subject)).toEqual(["Science"]);
      expect((await api.get(hr, `/api/v1/events?from=${day(0)}&to=${day(10)}`).expect(200)).body.events).toHaveLength(2);
    });
  });

  describe("admissions and ID cards", () => {
    it("a public enquiry becomes an admitted student with a parent account", async () => {
      expect((await request(app).get(`/api/v1/public/admissions/${schoolSlug}`).expect(200)).body.school.name).toBe("Sunrise School");
      await request(app).get("/api/v1/public/admissions/no-such-school").expect(404);
      const form = { studentName: "Kabir Das", dateOfBirth: "2013-05-04", gradeApplying: "Class 8", parentName: "Neha Das", parentEmail: uniqueEmail("neha"), parentPhone: "9811122233" };
      await request(app).post(`/api/v1/public/admissions/${schoolSlug}`).send({ ...form, parentEmail: "bad" }).expect(400);
      expect((await request(app).post(`/api/v1/public/admissions/${schoolSlug}`).send(form).expect(201)).body.reference).toHaveLength(8);
      await api.get(teacher, "/api/v1/admissions").expect(403);
      const list = (await api.get(hr, "/api/v1/admissions").expect(200)).body;
      expect(list.counts).toEqual({ enquiry: 1 });
      const appId = list.applications[0].id;
      await api.patch(hr, `/api/v1/admissions/${appId}`, { status: "interview", notes: "Interview on Monday" }).expect(200);

      const kabir = uniqueEmail("kabir");
      await api.post(hr, `/api/v1/admissions/${appId}/admit`, { studentEmail: kabir, password: "short" }).expect(400);
      await api.post(hr, `/api/v1/admissions/${appId}/admit`, { studentEmail: kabir, password: "kabir-pass-1", createParent: true }).expect(400);
      const admitted = (await api.post(hr, `/api/v1/admissions/${appId}/admit`, { studentEmail: kabir, password: "kabir-pass-1", classId, bloodGroup: "B+", createParent: true, parentPassword: "neha-pass-1" }).expect(201)).body;
      expect(admitted).toMatchObject({ admissionNo: `ADM-${new Date().getFullYear()}-0001`, parentLinked: true, parentCreated: true });
      await api.post(hr, `/api/v1/admissions/${appId}/admit`, { studentEmail: uniqueEmail("x"), password: "kabir-pass-1" }).expect(409);

      const k = await login(kabir, "kabir-pass-1", schoolId);
      expect((await api.get(k, "/api/v1/classes").expect(200)).body.classes[0].name).toBe("8-A Science");
      const neha = await login(form.parentEmail, "neha-pass-1", schoolId);
      expect((await api.get(neha, "/api/v1/parents/children").expect(200)).body.children.map((c: any) => c.name)).toEqual(["Kabir Das"]);

      const cards = (await api.get(hr, `/api/v1/id-cards?classId=${classId}`).expect(200)).body;
      expect(cards.cards.find((c: any) => c.name === "Kabir Das")).toMatchObject({ admission_no: admitted.admissionNo, blood_group: "B+", guardian_name: "Neha Das", classes: "8-A Science" });
      expect((await api.get(k, "/api/v1/id-cards/me").expect(200)).body.cards[0].admission_no).toBe(admitted.admissionNo);
      const cert = (await api.get(hr, `/api/v1/id-cards/certificates/${admitted.studentId}?type=bonafide&purpose=Passport`).expect(200)).body;
      expect(cert).toMatchObject({ type: "bonafide", purpose: "Passport", student: { name: "Kabir Das" }, org: { name: "Sunrise School" } });
      await api.get(k, `/api/v1/id-cards/certificates/${admitted.studentId}`).expect(403);
      await api.patch(hr, `/api/v1/admissions/students/${profile[s1.userId]}`, { admissionNo: admitted.admissionNo }).expect(409);
    });
  });

  describe("staff HR and payroll", () => {
    it("profiles, attendance and a payroll run that pro-rates absences", async () => {
      await api.put(teacher, `/api/v1/hr/staff/${teacher.userId}`, { employeeCode: "T001", basic: 30000 }).expect(403);
      await api.put(hr, `/api/v1/hr/staff/${s1.userId}`, { employeeCode: "X", basic: 1 }).expect(404);
      await api.put(hr, `/api/v1/hr/staff/${teacher.userId}`, { employeeCode: "T001", designation: "TGT Science", basic: 30000, hra: 12000, da: 3000, tds: 1000, bankAccountLast4: "4321" }).expect(200);
      await api.put(hr, `/api/v1/hr/staff/${other.userId}`, { employeeCode: "T001", basic: 20000 }).expect(409);
      const staff = (await api.get(hr, "/api/v1/hr/staff").expect(200)).body.staff;
      expect(staff.find((s: any) => s.name === "Meera Teacher")).toMatchObject({ employee_code: "T001", designation: "TGT Science" });
      expect(staff.some((s: any) => s.name === "Ravi Kumar")).toBe(false);

      // Last month: one absence and one half day, with a staff holiday on the calendar.
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
      /** The n-th (0-based) Monday–Saturday of last month, as YYYY-MM-DD. */
      const weekday = (n: number) => {
        const d = new Date(last);
        for (let seen = -1; ; d.setDate(d.getDate() + 1)) {
          if (d.getDay() !== 0 && ++seen === n) break;
        }
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      await api.post(hr, "/api/v1/hr/attendance", { date: weekday(2), records: [{ userId: teacher.userId, status: "absent" }] }).expect(200);
      await api.post(hr, "/api/v1/hr/attendance", { date: weekday(4), records: [{ userId: teacher.userId, status: "half_day" }] }).expect(200);
      await api.post(hr, "/api/v1/hr/attendance", { date: day(2), records: [{ userId: teacher.userId, status: "present" }] }).expect(400);
      await sql(`INSERT INTO school_events (tenant_id, title, kind, start_date, end_date, audience, created_by) VALUES ($1,'Founders day','holiday',$2,$2,'all',$3)`, [schoolId, weekday(6), hr.userId]);

      const run = (await api.post(hr, "/api/v1/hr/payroll/generate", { month }).expect(200)).body;
      expect(run.generated).toBe(1);
      const slip = (await api.get(hr, `/api/v1/hr/payroll?month=${month}`).expect(200)).body.payslips[0];
      expect(Number(slip.unpaid_days)).toBe(1.5);
      expect(slip.working_days).toBe(run.workingDays);
      const expected = computePayslip({ basic: 3000000, hra: 1200000, da: 300000, other: 0, pfPercent: 12, professionalTax: 20000, tds: 100000 }, run.workingDays, 1.5);
      expect(Number(slip.net_paise)).toBe(expected.net);

      // Staff see only paid payslips; once paid, a rerun doesn't change it.
      expect((await api.get(teacher, "/api/v1/hr/payslips/mine").expect(200)).body.payslips).toHaveLength(0);
      await api.get(teacher, `/api/v1/hr/payslips/${slip.id}`).expect(403);
      await api.post(hr, `/api/v1/hr/payslips/${slip.id}/pay`).expect(200);
      await api.post(hr, "/api/v1/hr/attendance", { date: weekday(8), records: [{ userId: teacher.userId, status: "absent" }] }).expect(200);
      expect((await api.post(hr, "/api/v1/hr/payroll/generate", { month }).expect(200)).body).toMatchObject({ generated: 0, skippedPaid: 1 });
      const mine = (await api.get(teacher, `/api/v1/hr/payslips/${slip.id}`).expect(200)).body;
      expect(mine.payslip).toMatchObject({ status: "paid", bank_account_last4: "4321", employee_code: "T001" });
      await api.get(other, `/api/v1/hr/payslips/${slip.id}`).expect(403);
      await api.post(hr, "/api/v1/hr/payroll/generate", { month: "2999-01" }).expect(400);
    });
  });

  it("keeps messages, leave, admissions and payroll inside the organization", async () => {
    const outsider = await register("student", "Other Org");
    const conv = (await sql(`SELECT id FROM conversations LIMIT 1`)).rows[0].id;
    await api.get(outsider, `/api/v1/messages/conversations/${conv}`).expect(404);
    expect((await api.get(outsider, "/api/v1/admissions").expect(200)).body.applications).toHaveLength(0);
    expect((await api.get(outsider, "/api/v1/hr/staff").expect(200)).body.staff.every((s: any) => s.name === "Other Org")).toBe(true);
    const slip = (await sql(`SELECT id FROM payslips LIMIT 1`)).rows[0].id;
    await api.get(outsider, `/api/v1/hr/payslips/${slip}`).expect(404);
  });
});
