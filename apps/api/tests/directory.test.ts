/** School directory: staff, classes 1–12, student profiles, documents with settings, and co-curricular activities. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { catalogue, defaultSubjects } from "../src/modules/school/book-catalogue.js";
import { gradeNumber } from "../src/modules/school/directory.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

describe("grade numbers", () => {
  it("reads the grade from the class grade or name", () => {
    expect(gradeNumber("Class 8", "8-A")).toBe(8);
    expect(gradeNumber(null, "12-B Physics")).toBe(12);
    expect(gradeNumber(null, "Class 3 Rose")).toBe(3);
    expect(gradeNumber(null, "Chess club")).toBeNull();
    expect(gradeNumber("Nursery", "Nursery A")).toBeNull();
  });
});

describe("built-in book lists", () => {
  it("has books for every default subject of each board", () => {
    for (let g = 1; g <= 12; g++) {
      for (const board of ["CBSE", "State Board"]) {
        const subjects = new Set(catalogue(board, g).map((b) => b.subject));
        for (const s of defaultSubjects(g, board)) expect(subjects, `${board} class ${g} ${s}`).toContain(s);
      }
      // ICSE: CISCE prescribes no books below Class 6, and Hindi in Class 6–8 varies by school.
      if (g >= 9) for (const s of defaultSubjects(g, "ICSE")) expect(new Set(catalogue("ICSE", g).map((b) => b.subject)), `ICSE class ${g} ${s}`).toContain(s);
    }
    expect(catalogue("CBSE", 8).find((b) => b.subject === "Science")?.title).toBe("Curiosity — Class VIII");
    expect(catalogue("State Board", 4, "Maharashtra State Bureau")[0].publisher).toBe("Maharashtra State Bureau");
  });
});

describe.skipIf(!dbAvailable)("school directory", () => {
  let owner: Session;
  let teacher: Session;
  let other: Session;
  let s1: Session;
  let s2: Session;
  let schoolId: string;
  let class8: string;
  let class3: string;
  const profile: Record<string, string> = {};
  const pdf = Buffer.from("%PDF-1.4 test document").toString("base64");

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
    other = await join("teacher", "Other Teacher");
    s1 = await join("student", "Ravi Kumar");
    s2 = await join("student", "Anya Singh");
    for (const s of [s1, s2]) profile[s.userId] = (await api.get(s, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    class8 = (await api.post(other, "/api/v1/classes", { name: "8-A" }).expect(201)).body.class.id;
    class3 = (await api.post(other, "/api/v1/classes", { name: "3-B" }).expect(201)).body.class.id;
    await sql(`UPDATE classes SET grade = 'Class 8', section = 'A' WHERE id = $1`, [class8]);
    await api.post(other, `/api/v1/classes/${class8}/enrollments`, { studentIds: [profile[s1.userId]] }).expect(201);
    await api.post(other, `/api/v1/classes/${class3}/enrollments`, { studentIds: [profile[s2.userId]] }).expect(201);
    // Meera teaches Science in 8-A only.
    await sql(`INSERT INTO class_subjects (tenant_id, class_id, subject, teacher_id) VALUES ($1,$2,'Science',$3)`, [schoolId, class8, teacher.userId]);
  });

  afterAll(async () => {
    await liveHub.close();
  });

  it("gives the principal every staff member with their subjects", async () => {
    const res = await api.get(owner, "/api/v1/directory/staff").expect(200);
    const meera = res.body.staff.find((s: any) => s.user_id === teacher.userId);
    expect(meera.subjects).toEqual([expect.objectContaining({ classId: class8, subject: "Science" })]);
    expect(res.body.staff.find((s: any) => s.user_id === other.userId).class_teacher_of).toHaveLength(2);
    await api.get(teacher, "/api/v1/directory/staff").expect(403);
    await api.get(s1, "/api/v1/directory/classes").expect(403);
  });

  it("lists classes by grade for the principal and only taught classes for a teacher", async () => {
    const all = (await api.get(owner, "/api/v1/directory/classes").expect(200)).body.classes;
    expect(all.map((c: any) => [c.name, c.grade_number])).toEqual([["3-B", 3], ["8-A", 8]]);
    const mine = (await api.get(teacher, "/api/v1/directory/classes").expect(200)).body.classes;
    expect(mine.map((c: any) => c.id)).toEqual([class8]);
    await api.get(teacher, `/api/v1/directory/classes/${class3}`).expect(403);
    const detail = (await api.get(teacher, `/api/v1/directory/classes/${class8}`).expect(200)).body;
    expect(detail.students.map((s: any) => s.name)).toEqual(["Ravi Kumar"]);
    const teaching = (await api.get(teacher, "/api/v1/directory/my-teaching").expect(200)).body;
    expect(teaching.subjects.map((s: any) => `${s.class_name} ${s.subject}`)).toEqual(["8-A Science"]);
  });

  it("shows student profiles to the principal and to that student's teachers", async () => {
    await api.patch(owner, `/api/v1/directory/students/${profile[s1.userId]}`, { admissionNo: "A-101", bloodGroup: "B+" }).expect(200);
    const p = (await api.get(teacher, `/api/v1/directory/students/${profile[s1.userId]}`).expect(200)).body;
    expect(p.student.admission_no).toBe("A-101");
    expect(p.classes.map((c: any) => c.name)).toEqual(["8-A"]);
    await api.get(teacher, `/api/v1/directory/students/${profile[s2.userId]}`).expect(403);
    await api.patch(teacher, `/api/v1/directory/students/${profile[s1.userId]}`, { admissionNo: "X" }).expect(403);
    const list = (await api.get(owner, "/api/v1/directory/students?q=ravi").expect(200)).body.students;
    expect(list.map((s: any) => s.name)).toEqual(["Ravi Kumar"]);
  });

  it("uploads, views and controls documents with the school's settings", async () => {
    const sid = profile[s1.userId];
    const doc = (
      await api.post(owner, "/api/v1/directory/documents", { ownerType: "student", ownerId: sid, title: "Birth certificate", fileName: "birth.pdf", mimeType: "application/pdf", data: pdf }).expect(201)
    ).body.document;
    const secret = (
      await api.post(owner, "/api/v1/directory/documents", { ownerType: "student", ownerId: sid, title: "Medical note", visibility: "admin", fileName: "m.pdf", mimeType: "application/pdf", data: pdf }).expect(201)
    ).body.document;
    await api.post(owner, "/api/v1/directory/documents", { ownerType: "student", ownerId: sid, title: "x", fileName: "x.exe", mimeType: "application/x-msdownload", data: pdf }).expect(400);

    const file = await api.get(teacher, `/api/v1/directory/documents/${doc.id}/file`).expect(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    await api.get(teacher, `/api/v1/directory/documents/${secret.id}/file`).expect(404);
    await api.get(s2, `/api/v1/directory/documents/${doc.id}/file`).expect(403);
    const seen = (await api.get(teacher, `/api/v1/directory/documents?studentId=${sid}`).expect(200)).body.documents;
    expect(seen.map((d: any) => d.title)).toEqual(["Birth certificate"]);

    // Teachers can't upload until the principal allows it; then they can't read documents once that's turned off.
    const upload = { ownerType: "student", ownerId: sid, title: "Project", fileName: "p.pdf", mimeType: "application/pdf", data: pdf };
    await api.post(teacher, "/api/v1/directory/documents", upload).expect(403);
    const settings = (await api.get(owner, "/api/v1/directory/settings").expect(200)).body.settings;
    await api.put(owner, "/api/v1/directory/settings", { ...settings, teachersCanUploadDocuments: true }).expect(200);
    const mine = (await api.post(teacher, "/api/v1/directory/documents", { ...upload, visibility: "admin" }).expect(201)).body.document;
    expect(mine.visibility).toBe("staff");
    await api.delete(teacher, `/api/v1/directory/documents/${doc.id}`).expect(403);
    await api.delete(teacher, `/api/v1/directory/documents/${mine.id}`).expect(204);
    await api.put(owner, "/api/v1/directory/settings", { ...settings, teachersCanViewDocuments: false }).expect(200);
    await api.get(teacher, `/api/v1/directory/documents/${doc.id}/file`).expect(403);
    await api.put(teacher, "/api/v1/directory/settings", settings).expect(403);
    await api.patch(owner, `/api/v1/directory/documents/${doc.id}`, { visibility: "admin" }).expect(200);
  });

  it("runs sports, PT and clubs with a teacher in charge", async () => {
    const pt = (await api.post(owner, "/api/v1/directory/activities", { name: "PT – Class 8", category: "pt", teacherId: teacher.userId, schedule: "Mon, Wed 7:30" }).expect(201)).body.activity;
    await api.post(owner, "/api/v1/directory/activities", { name: "pt – class 8" }).expect(400);
    await api.post(teacher, "/api/v1/directory/activities", { name: "Chess" }).expect(403);
    await api.post(teacher, `/api/v1/directory/activities/${pt.id}/members`, { classId: class8 }).expect(201);
    await api.post(teacher, `/api/v1/directory/activities/${pt.id}/members`, { classId: class3 }).expect(403);
    const detail = (await api.get(teacher, `/api/v1/directory/activities/${pt.id}`).expect(200)).body;
    expect(detail.members.map((m: any) => m.name)).toEqual(["Ravi Kumar"]);
    await api.get(other, `/api/v1/directory/activities/${pt.id}`).expect(403);
    const teaching = (await api.get(teacher, "/api/v1/directory/my-teaching").expect(200)).body;
    expect(teaching.activities.map((a: any) => a.name)).toEqual(["PT – Class 8"]);
    const p = (await api.get(owner, `/api/v1/directory/students/${profile[s1.userId]}`).expect(200)).body;
    expect(p.activities.map((a: any) => a.category)).toEqual(["pt"]);
    await api.delete(teacher, `/api/v1/directory/activities/${pt.id}/members/${profile[s1.userId]}`).expect(204);
  });

  it("sets up Class 1–12 sections with subjects, books and syllabus chapters", async () => {
    const r = (await api.post(owner, "/api/v1/directory/classes/setup", { grades: [6, 8], sections: ["a", "B"], board: "CBSE", subjects: { "8": ["Science", "Mathematics"] }, importBooks: false }).expect(201)).body;
    // 8-A already exists (grade "Class 8", section A), so it is skipped.
    expect(r.created).toBe(3);
    expect(r.skipped).toEqual(["8-A"]);
    await api.post(teacher, "/api/v1/directory/classes/setup", { grades: [1], sections: ["A"] }).expect(403);
    const all = (await api.get(owner, "/api/v1/directory/classes").expect(200)).body.classes;
    const c8b = all.find((c: any) => c.name === "8-B");
    expect(c8b.subjects.map((s: any) => s.subject)).toEqual(["Mathematics", "Science"]);
    expect(all.find((c: any) => c.name === "6-A").subjects).toHaveLength(6);

    // A syllabus for Class 8 Science and a textbook shared by every Class 8 section.
    await sql(`UPDATE class_subjects SET teacher_id = $2 WHERE class_id = $1 AND subject = 'Science'`, [c8b.id, teacher.userId]);
    const syl = (await sql(`INSERT INTO syllabi (tenant_id, board, grade, subject) VALUES ($1,'CBSE','Class 8','Science') RETURNING id`, [schoolId])).rows[0].id;
    await sql(`INSERT INTO syllabus_units (tenant_id, syllabus_id, title, sequence) VALUES ($1,$2,'Crop production',1), ($1,$2,'Microorganisms',2)`, [schoolId, syl]);
    await sql(`UPDATE class_subjects SET syllabus_id = $2 WHERE class_id = $1 AND subject = 'Science'`, [c8b.id, syl]);
    await api.post(owner, "/api/v1/directory/books", { grade: "Class 8", subject: "Science", title: "Science Textbook for Class VIII", publisher: "NCERT" }).expect(201);
    await api.post(teacher, "/api/v1/directory/books", { grade: "Class 8", subject: "Science", title: "x" }).expect(403);

    const detail = (await api.get(teacher, `/api/v1/directory/classes/${c8b.id}`).expect(200)).body;
    const sci = detail.subjects.find((s: any) => s.subject === "Science");
    expect(sci.books.map((b: any) => b.title)).toEqual(["Science Textbook for Class VIII"]);
    expect(sci.chapters.map((u: any) => [u.title, u.status])).toEqual([["Crop production", "planned"], ["Microorganisms", "planned"]]);
    expect(detail.subjects.find((s: any) => s.subject === "Mathematics").books).toEqual([]);

    await api.patch(owner, `/api/v1/directory/classes/${c8b.id}`, { classTeacherId: teacher.userId }).expect(200);
    await api.delete(owner, `/api/v1/directory/classes/${class8}`).expect(400); // has students

    // The board's built-in book lists: importing twice adds nothing new.
    const imported = (await api.post(owner, "/api/v1/directory/books/import", { board: "CBSE", grades: [8] }).expect(201)).body.added;
    expect(imported).toBe(6);
    expect((await api.post(owner, "/api/v1/directory/books/import", { board: "CBSE", grades: [8] }).expect(201)).body.added).toBe(0);
    await api.post(owner, "/api/v1/directory/books/import", { board: "ICSE", grades: [8] }).expect(201);
    const after = (await api.get(teacher, `/api/v1/directory/classes/${c8b.id}`).expect(200)).body;
    // 8-B follows CBSE, so ICSE books don't show; the hand-added book still does.
    expect(after.subjects.find((s: any) => s.subject === "Science").books.map((b: any) => b.title)).toEqual(["Science Textbook for Class VIII", "Curiosity — Class VIII"]);
    await api.delete(owner, `/api/v1/directory/classes/${all.find((c: any) => c.name === "6-B").id}`).expect(204);
  });

  it("keeps the directory inside the organization", async () => {
    const outsider = await register("parent", "Elsewhere");
    expect([403, 404]).toContain((await api.get(outsider, `/api/v1/directory/students/${profile[s1.userId]}`)).status);
    const docs = await sql(`SELECT id FROM profile_documents LIMIT 1`);
    await api.get(outsider, `/api/v1/directory/documents/${docs.rows[0].id}/file`).expect(404);
  });
});
