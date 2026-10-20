/** Fees, examinations and the library. */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveHub } from "../src/modules/live/events.js";
import { api, app, dbAvailable, login, register, resetDb, sql, uniqueEmail, type Session } from "./helpers.js";

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe.skipIf(!dbAvailable)("fees, exams and library", () => {
  let owner: Session;
  let teacher: Session;
  let accountant: Session;
  let librarian: Session;
  let s1: Session;
  let s2: Session;
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
    accountant = await join("accountant", "Anil Accounts");
    librarian = await join("librarian", "Lata Library");
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

  describe("fees", () => {
    let invoiceId: string;

    it("bills a structure to every student in the class and only the fees office may", async () => {
      await api.post(teacher, "/api/v1/fees/structures", { name: "Term 1 tuition", amount: 12000, dueDate: day(10) }).expect(403);
      const r = await api.post(accountant, "/api/v1/fees/structures", { name: "Term 1 tuition", amount: 12000, dueDate: day(10), classId }).expect(201);
      expect(r.body.billed).toBe(2);
      expect((await api.post(accountant, `/api/v1/fees/structures/${r.body.structure.id}/apply`).expect(200)).body.billed).toBe(0);
      await api.post(accountant, "/api/v1/fees/structures", { name: "Annual day", amount: 500, dueDate: day(-3) }).expect(201);

      const list = (await api.get(accountant, `/api/v1/fees/invoices?studentId=${profile[s1.userId]}`).expect(200)).body.invoices;
      expect(list.map((i: any) => [i.title, i.state, Number(i.balance_paise)])).toEqual([
        ["Annual day", "overdue", 50000],
        ["Term 1 tuition", "due", 1200000],
      ]);
      invoiceId = list[1].id;
    });

    it("records payments with sequential receipts and refuses overpayment", async () => {
      await api.post(accountant, `/api/v1/fees/invoices/${invoiceId}/payments`, { amount: 12001, method: "cash" }).expect(400);
      const p1 = (await api.post(accountant, `/api/v1/fees/invoices/${invoiceId}/payments`, { amount: 5000, method: "upi", reference: "UPI123" }).expect(201)).body.payment;
      const p2 = (await api.post(accountant, `/api/v1/fees/invoices/${invoiceId}/payments`, { amount: 6000, method: "cash" }).expect(201)).body.payment;
      const year = new Date().getFullYear();
      expect([p1.receipt_no, p2.receipt_no]).toEqual([`RCPT-${year}-00001`, `RCPT-${year}-00002`]);

      // A concession covers the last ₹1,000.
      await api.patch(accountant, `/api/v1/fees/invoices/${invoiceId}`, { discount: 1001 }).expect(400);
      await api.patch(accountant, `/api/v1/fees/invoices/${invoiceId}`, { discount: 1000, discountNote: "Sibling concession" }).expect(200);
      await api.patch(accountant, `/api/v1/fees/invoices/${invoiceId}`, { status: "cancelled" }).expect(409);
      const inv = (await api.get(accountant, `/api/v1/fees/invoices?studentId=${profile[s1.userId]}&state=paid`).expect(200)).body.invoices;
      expect(inv).toHaveLength(1);

      const receipt = (await api.get(parent, `/api/v1/fees/receipts/${p1.id}`).expect(200)).body;
      expect(receipt).toMatchObject({ receipt: { receipt_no: p1.receipt_no, method: "upi" }, student: { name: "Ravi Kumar" }, organization: { name: "Sunrise School" } });
      await api.get(s2, `/api/v1/fees/receipts/${p1.id}`).expect(403);
      await api.get(teacher, `/api/v1/fees/receipts/${p1.id}`).expect(403);
    });

    it("students and parents see their own dues; the summary adds up", async () => {
      const mine = (await api.get(s1, "/api/v1/fees/student").expect(200)).body;
      expect(mine.totals).toEqual({ due_paise: 50000, overdue_paise: 50000, paid_paise: 1100000 });
      expect((await api.get(parent, `/api/v1/fees/student?studentId=${profile[s1.userId]}`).expect(200)).body.payments).toHaveLength(2);
      await api.get(parent, `/api/v1/fees/student?studentId=${profile[s2.userId]}`).expect(403);
      await api.get(s1, "/api/v1/fees/invoices").expect(403);

      const sum = (await api.get(owner, "/api/v1/fees/summary").expect(200)).body.totals;
      // Billed: 2 × 12,000 + 2 × 500 − 1,000 concession = 24,000; collected 11,000.
      expect(Number(sum.billed)).toBe(2400000);
      expect(Number(sum.collected)).toBe(1100000);
      expect(Number(sum.outstanding)).toBe(1300000);
      expect(sum.overdue_students).toBe(2);
    });
  });

  describe("exams", () => {
    let examId: string;
    let paperId: string;
    let itemId: string;

    it("an admin builds a date sheet; each paper becomes a gradebook column", async () => {
      await api.post(teacher, "/api/v1/exams", { name: "Half-yearly" }).expect(403);
      examId = (await api.post(owner, "/api/v1/exams", { name: "Half-yearly", term: "Term 1", startDate: day(5), endDate: day(12) }).expect(201)).body.exam.id;
      await api.post(owner, `/api/v1/exams/${examId}/papers`, { classId, subject: "Science", date: day(20), maxMarks: 80 }).expect(400);
      const paper = (await api.post(owner, `/api/v1/exams/${examId}/papers`, { classId, subject: "Science", date: day(5), startTime: "09:00", durationMinutes: 180, maxMarks: 80, passMarks: 27 }).expect(201)).body.paper;
      paperId = paper.id;
      itemId = paper.grade_item_id;
      await api.post(owner, `/api/v1/exams/${examId}/papers`, { classId, subject: "Maths", date: day(5), startTime: "11:00", maxMarks: 80 }).expect(409);
      await api.post(owner, `/api/v1/exams/${examId}/papers`, { classId, subject: "Maths", date: day(6), maxMarks: 80, passMarks: 27 }).expect(201);

      const book = (await api.get(teacher, `/api/v1/gradebook/classes/${classId}`).expect(200)).body;
      expect(book.items.map((i: any) => [i.title, i.category, i.term])).toEqual([
        ["Half-yearly — Science", "exam", "Term 1"],
        ["Half-yearly — Maths", "exam", "Term 1"],
      ]);
    });

    it("students only see published exams for their classes", async () => {
      expect((await api.get(s1, "/api/v1/exams").expect(200)).body.exams).toHaveLength(0);
      await api.get(s1, `/api/v1/exams/${examId}`).expect(404);
      await api.patch(owner, `/api/v1/exams/${examId}`, { status: "published" }).expect(200);
      const list = (await api.get(s1, "/api/v1/exams").expect(200)).body.exams;
      expect(list[0]).toMatchObject({ name: "Half-yearly", papers: 2 });
      const sheet = (await api.get(s1, `/api/v1/exams/${examId}`).expect(200)).body;
      expect(sheet.papers.map((p: any) => p.subject)).toEqual(["Science", "Maths"]);
      expect(sheet.papers[0].marked).toBeUndefined();
      expect((await api.get(parent, `/api/v1/exams/${examId}`).expect(200)).body.papers).toHaveLength(2);
    });

    it("marks entered in the gradebook produce ranked results, hidden from students until declared", async () => {
      const maths = (await api.get(owner, `/api/v1/exams/${examId}`).expect(200)).body.papers.find((p: any) => p.subject === "Maths");
      await api.put(teacher, `/api/v1/gradebook/items/${itemId}/scores`, { scores: [{ studentId: profile[s1.userId], marks: 72 }, { studentId: profile[s2.userId], marks: 20 }] }).expect(200);
      await api.put(teacher, `/api/v1/gradebook/items/${maths.grade_item_id}/scores`, { scores: [{ studentId: profile[s1.userId], marks: 64 }, { studentId: profile[s2.userId], marks: 60 }] }).expect(200);

      const results = (await api.get(teacher, `/api/v1/exams/${examId}/results?classId=${classId}`).expect(200)).body;
      expect(results.students.map((s: any) => [s.name, s.total, s.percent, s.grade, s.result, s.rank])).toEqual([
        ["Ravi Kumar", 136, 85, "A2", "pass", 1],
        ["Anya Singh", 80, 50, "C2", "fail", 2],
      ]);
      expect(results.summary).toMatchObject({ students: 2, passed: 1, failed: 1, average: 67.5, highest: 85 });
      await api.get(s1, `/api/v1/exams/${examId}/results?classId=${classId}`).expect(403);

      expect((await api.get(s1, `/api/v1/exams/${examId}/student`).expect(200)).body.declared).toBe(false);
      const hidden = (await api.get(s1, "/api/v1/gradebook/report-card").expect(200)).body;
      expect(hidden.subjects[0].items).toHaveLength(0);
      expect((await api.get(teacher, `/api/v1/gradebook/report-card?studentId=${profile[s1.userId]}`).expect(200)).body.subjects[0].items).toHaveLength(2);

      await api.patch(owner, `/api/v1/exams/${examId}`, { status: "completed" }).expect(200);
      const mine = (await api.get(s1, `/api/v1/exams/${examId}/student`).expect(200)).body;
      expect(mine).toMatchObject({ declared: true, total: 136, max: 160, percent: 85, grade: "A2", result: "pass" });
      expect((await api.get(parent, `/api/v1/exams/${examId}/student?studentId=${profile[s1.userId]}`).expect(200)).body.result).toBe("pass");
      expect((await api.get(s1, "/api/v1/gradebook/report-card").expect(200)).body.subjects[0].items).toHaveLength(2);
    });

    it("deleting a paper removes its gradebook column", async () => {
      await api.delete(owner, `/api/v1/exams/papers/${paperId}`).expect(200);
      const book = (await api.get(teacher, `/api/v1/gradebook/classes/${classId}`).expect(200)).body;
      expect(book.items.map((i: any) => i.title)).toEqual(["Half-yearly — Maths"]);
    });
  });

  describe("library", () => {
    let bookId: string;
    let loanId: string;

    it("the librarian catalogues books; everyone can browse", async () => {
      await api.post(s1, "/api/v1/library/books", { title: "Wings of Fire" }).expect(403);
      bookId = (await api.post(librarian, "/api/v1/library/books", { title: "Wings of Fire", author: "A. P. J. Abdul Kalam", isbn: "9788173711466", category: "Biography", copies: 1 }).expect(201)).body.book.id;
      await api.post(librarian, "/api/v1/library/books", { title: "Duplicate", isbn: "9788173711466" }).expect(409);
      const browse = (await api.get(s1, "/api/v1/library/books?search=kalam").expect(200)).body;
      expect(browse.books).toEqual([expect.objectContaining({ title: "Wings of Fire", available: 1, with_me: false })]);
      expect(browse.categories).toEqual([{ category: "Biography", n: 1 }]);
    });

    it("issues within the copy limit, then charges a late fine on return", async () => {
      await api.post(librarian, "/api/v1/library/loans", { bookId, userId: parent.userId }).expect(400);
      await api.post(librarian, "/api/v1/library/loans", { bookId, userId: s1.userId, dueDate: day(-1) }).expect(400);
      loanId = (await api.post(librarian, "/api/v1/library/loans", { bookId, userId: s1.userId }).expect(201)).body.loan.id;
      await api.post(librarian, "/api/v1/library/loans", { bookId, userId: s2.userId }).expect(409);
      await api.patch(librarian, `/api/v1/library/books/${bookId}`, { copies: 0 }).expect(400);

      expect((await api.get(s1, "/api/v1/library/books").expect(200)).body.books[0]).toMatchObject({ available: 0, with_me: true });
      const mine = (await api.get(s1, "/api/v1/library/my").expect(200)).body.loans;
      expect(mine[0]).toMatchObject({ title: "Wings of Fire", state: "active" });
      expect((await api.get(parent, `/api/v1/library/my?studentId=${profile[s1.userId]}`).expect(200)).body.loans).toHaveLength(1);

      // Make the loan four days late, then return it.
      await sql(`UPDATE library_loans SET due_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 4 WHERE id = $1`, [loanId]);
      expect((await api.get(librarian, "/api/v1/library/loans?state=overdue").expect(200)).body.loans[0]).toMatchObject({ days_overdue: 4, fine_due_paise: 800 });
      const ret = (await api.post(librarian, `/api/v1/library/loans/${loanId}/return`, {}).expect(200)).body.loan;
      expect(ret).toMatchObject({ fine_paise: 800, fine_paid: false });
      await api.post(librarian, `/api/v1/library/loans/${loanId}/return`, {}).expect(409);
      expect(Number((await api.get(librarian, "/api/v1/library/summary").expect(200)).body.summary.fines_unpaid_paise)).toBe(800);
      await api.post(librarian, `/api/v1/library/loans/${loanId}/fine-paid`).expect(200);
    });

    it("renewals extend the due date and waived returns charge nothing", async () => {
      const loan = (await api.post(librarian, "/api/v1/library/loans", { bookId, userId: s2.userId }).expect(201)).body.loan;
      const renewed = (await api.post(librarian, `/api/v1/library/loans/${loan.id}/renew`).expect(200)).body.loan;
      expect(renewed.due_date > loan.due_date).toBe(true);
      await sql(`UPDATE library_loans SET due_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 2 WHERE id = $1`, [loan.id]);
      expect((await api.post(librarian, `/api/v1/library/loans/${loan.id}/return`, { waiveFine: true }).expect(200)).body.loan.fine_paise).toBe(0);
    });
  });

  it("the new roles see only their own areas", async () => {
    await api.get(accountant, "/api/v1/library/loans").expect(403);
    await api.get(librarian, "/api/v1/fees/summary").expect(403);
    await api.get(accountant, "/api/v1/classes").expect(403);
    const dash = (await api.get(accountant, "/api/v1/dashboard").expect(200)).body;
    expect(Object.keys(dash)).toEqual(["fees"]);
    expect(Object.keys((await api.get(librarian, "/api/v1/dashboard").expect(200)).body)).toEqual(["library"]);
    const student = (await api.get(s1, "/api/v1/dashboard").expect(200)).body.student;
    expect(student).toMatchObject({ feesDuePaise: 50000, feesOverdue: 1, books: { n: 0, overdue: 0 } });
  });

  it("keeps fee, exam and library records inside their organization", async () => {
    const family = await register("student", "Other Org");
    expect((await api.get(family, "/api/v1/library/books").expect(200)).body.books).toHaveLength(0);
    expect((await api.get(family, "/api/v1/exams").expect(200)).body.exams).toHaveLength(0);
    const anyPayment = (await sql(`SELECT id FROM fee_payments LIMIT 1`)).rows[0].id;
    await api.get(family, `/api/v1/fees/receipts/${anyPayment}`).expect(404);
  });
});
