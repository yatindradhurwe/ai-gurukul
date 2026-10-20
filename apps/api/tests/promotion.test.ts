/** Promotion from final exam results: pass → next class, a few fails → supplementary re-exam, more → stays. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { decide } from "../src/modules/school/promotion.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

const rules = { autoPromote: false, maxSupplementarySubjects: 2, minAttendance: null, minPercent: null };
const paper = (subject: string, marks: number | null, pass = 33) => ({ paperId: subject, subject, max: 100, pass, marks, passed: marks == null ? null : marks >= pass });

describe("promotion rules", () => {
  it("promotes, sends to supplementary, keeps back, or waits for marks", () => {
    expect(decide({ papers: [paper("Maths", 80), paper("Science", 70)], percent: 75 }, 90, rules).outcome).toBe("promote");
    expect(decide({ papers: [paper("Maths", 20), paper("Science", 70)], percent: 45 }, 90, rules)).toMatchObject({ outcome: "supplementary", failed: ["Maths"] });
    expect(decide({ papers: [paper("Maths", 20), paper("Science", 10), paper("English", 5)], percent: 12 }, 90, rules).outcome).toBe("detain");
    expect(decide({ papers: [paper("Maths", 80), paper("Science", null)], percent: 80 }, 90, rules).outcome).toBe("incomplete");
    expect(decide({ papers: [paper("Maths", 80)], percent: 80 }, 60, { ...rules, minAttendance: 75 }).outcome).toBe("detain");
    expect(decide({ papers: [paper("Maths", 40)], percent: 40 }, 90, { ...rules, minPercent: 50 }).outcome).toBe("detain");
    expect(decide({ papers: [paper("Maths", 20)], percent: 20 }, 90, { ...rules, maxSupplementarySubjects: 0 }).outcome).toBe("detain");
  });
});

describe.skipIf(!dbAvailable)("promotion after final results", () => {
  let owner: Session;
  let teacher: Session;
  let schoolId: string;
  let c7: string;
  let c8: string;
  const kids: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    owner = await register("parent", "Principal");
    const t = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant;
    schoolId = t.id;
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
    for (const n of ["Asha Pass", "Bala Supply", "Chitra Fail"]) kids[n] = (await api.get(await join("student", n), "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    await api.post(owner, "/api/v1/directory/classes/setup", { grades: [7, 8], sections: ["A"], importBooks: false }).expect(201);
    const classes = (await api.get(owner, "/api/v1/directory/classes").expect(200)).body.classes;
    c7 = classes.find((c: any) => c.name === "7-A").id;
    c8 = classes.find((c: any) => c.name === "8-A").id;
    await sql(`INSERT INTO class_enrollments (tenant_id, class_id, student_id) SELECT $1, $2, unnest($3::uuid[])`, [schoolId, c7, Object.values(kids)]);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  /** A final exam for 7-A with Maths, Science and English papers and the given marks. */
  async function finalExam(name: string, marks: Record<string, [number, number, number]>, month = "2027-03") {
    const exam = (await api.post(owner, "/api/v1/exams", { name, term: "Annual", isFinal: true }).expect(201)).body.exam;
    for (const [i, subject] of ["Maths", "Science", "English"].entries()) {
      const p = (await api.post(owner, `/api/v1/exams/${exam.id}/papers`, { classId: c7, subject, date: `${month}-0${i + 1}`, maxMarks: 100, passMarks: 33 }).expect(201)).body.paper;
      await api.put(owner, `/api/v1/gradebook/items/${p.grade_item_id}/scores`, { scores: Object.entries(marks).map(([n, m]) => ({ studentId: kids[n], marks: m[i] })) }).expect(200);
    }
    await api.patch(owner, `/api/v1/exams/${exam.id}`, { status: "published" }).expect(200);
    return exam;
  }

  it("previews, then promotes on declaring results when auto-promotion is on", async () => {
    const exam = await finalExam("Annual Exam 2026-27", { "Asha Pass": [80, 75, 70], "Bala Supply": [20, 60, 55], "Chitra Fail": [10, 12, 15] });
    const preview = (await api.get(owner, `/api/v1/promotion/preview?examId=${exam.id}`).expect(200)).body;
    const seven = preview.classes.find((c: any) => c.class.id === c7);
    expect(seven.next).toMatchObject({ id: c8, name: "8-A" });
    expect(Object.fromEntries(seven.students.map((s: any) => [s.name, s.outcome]))).toEqual({ "Asha Pass": "promote", "Bala Supply": "supplementary", "Chitra Fail": "detain" });
    await api.post(owner, "/api/v1/promotion/run", { examId: exam.id }).expect(400); // results not declared yet
    await api.get(teacher, `/api/v1/promotion/preview?examId=${exam.id}`).expect(403);

    await api.put(owner, "/api/v1/promotion/rules", { ...rules, autoPromote: true }).expect(200);
    const declared = (await api.patch(owner, `/api/v1/exams/${exam.id}`, { status: "completed" }).expect(200)).body;
    expect(declared.promotion).toMatchObject({ promoted: 1, supplementary: 1, detained: 1 });

    const roster = async (id: string) => (await api.get(owner, `/api/v1/directory/classes/${id}`).expect(200)).body.students.map((s: any) => s.name).sort();
    expect(await roster(c8)).toEqual(["Asha Pass"]);
    expect(await roster(c7)).toEqual(["Bala Supply", "Chitra Fail"]);
    const chitra = (await api.get(owner, `/api/v1/directory/students/${kids["Chitra Fail"]}`).expect(200)).body;
    expect(chitra.history[0]).toMatchObject({ result: "detained", class_name: "7-A" });

    // Running again changes nothing.
    expect((await api.post(owner, "/api/v1/promotion/run", { examId: exam.id }).expect(201)).body.summary).toMatchObject({ promoted: 0, supplementary: 0, detained: 0 });
  });

  it("promotes after clearing the supplementary re-exam", async () => {
    const open = (await api.get(owner, "/api/v1/promotion/supplementary").expect(200)).body.supplementary;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ student: "Bala Supply", subject: "Maths", original_marks: 20, target_class: "8-A" });
    await api.put(owner, `/api/v1/promotion/supplementary/${open[0].id}`, { marks: 101 }).expect(400);
    const r = (await api.put(owner, `/api/v1/promotion/supplementary/${open[0].id}`, { marks: 41 }).expect(200)).body;
    expect(r).toEqual({ status: "passed", result: "promoted" });
    const bala = (await api.get(owner, `/api/v1/directory/students/${kids["Bala Supply"]}`).expect(200)).body;
    expect(bala.classes.map((c: any) => c.name)).toEqual(["8-A"]);
    expect(bala.history[0].remarks).toContain("Cleared supplementary exam: Maths 41/100");
    expect((await api.get(owner, "/api/v1/promotion/supplementary").expect(200)).body.supplementary).toHaveLength(0);
  });

  it("lets the principal override an outcome before running", async () => {
    await api.put(owner, "/api/v1/promotion/rules", rules).expect(200);
    // Next session: Chitra (kept in 7-A) sits the final exam again; she passes, but the principal keeps her back.
    const y = (await sql(`INSERT INTO academic_years (tenant_id, name, start_date, end_date, is_current) VALUES ($1,'2027-28','2027-04-01','2028-03-31',true) RETURNING id`, [schoolId])).rows[0].id;
    await sql(`UPDATE classes SET academic_year_id = $2 WHERE id = $1`, [c7, y]);
    const exam = await finalExam("Annual Exam 2027-28", { "Chitra Fail": [60, 60, 60] }, "2028-03");
    await api.patch(owner, `/api/v1/exams/${exam.id}`, { status: "completed" }).expect(200);
    expect((await api.get(owner, `/api/v1/directory/classes/${c7}`).expect(200)).body.students).toHaveLength(1); // auto is off now
    const s = (await api.post(owner, "/api/v1/promotion/run", { examId: exam.id, overrides: [{ studentId: kids["Chitra Fail"], classId: c7, outcome: "detain" }] }).expect(201)).body.summary;
    expect(s).toMatchObject({ promoted: 0, detained: 1, skipped: [] });
    const chitra = (await api.get(owner, `/api/v1/directory/students/${kids["Chitra Fail"]}`).expect(200)).body;
    expect(chitra.history.map((h: any) => `${h.year_name} ${h.result}`).sort()).toEqual(["2026-27 detained", "2027-28 detained"]);
  });
});
