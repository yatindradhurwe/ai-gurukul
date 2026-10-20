/**
 * Creates a ready-to-use demo school with one login per role and prints them.
 *
 *   npm run setup:demo                         # random passwords, printed once
 *   DEMO_PASSWORD='MyPass#2026' npm run setup:demo
 *   SUPERADMIN_PASSWORD='...' DEMO_PASSWORD='...' npm run setup:demo   # separate super-admin password
 *   npm run setup:demo -- --reset-passwords    # re-issue passwords for existing demo users
 *
 * Safe to run more than once: existing accounts are kept, and their passwords are
 * only changed with --reset-passwords.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../../lib/crypto.js";
import { enterSystemContext, pool, type Db } from "../pool.js";
import { seed } from "./seed.js";
import { holidaysBetween } from "../../modules/academics/holidays.js";
import { generatePlan } from "../../modules/academics/routes.js";

const DOMAIN = process.env.DEMO_EMAIL_DOMAIN ?? "demo.aigurukul.test";

interface DemoUser {
  key: string;
  name: string;
  email: string;
  role: string; // role in Demo School
  label: string;
  what: string;
}

const USERS: DemoUser[] = [
  {
    key: "superadmin",
    name: "Platform Super Admin",
    email: (process.env.SUPERADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? `superadmin@${DOMAIN}`).toLowerCase(),
    role: "tenant_owner",
    label: "Super admin",
    what: "Platform super-admin: all organisations, audit logs, usage (also owner of Demo School)",
  },
  { key: "principal", name: "Principal Sharma", email: `principal@${DOMAIN}`, role: "tenant_owner", label: "School owner", what: "School owner: everything in the school, incl. billing" },
  { key: "admin", name: "Rahul Verma", email: `admin@${DOMAIN}`, role: "tenant_admin", label: "School admin", what: "School admin: people, classes, content, reports" },
  { key: "teacher", name: "Meera Iyer", email: `teacher@${DOMAIN}`, role: "teacher", label: "Teacher", what: "Teacher: classes, live AI lessons, doubts, tests" },
  { key: "staff", name: "Kavita Nair", email: `staff@${DOMAIN}`, role: "staff", label: "Staff / HR", what: "Staff / HR: people directory, invitations, organisation reports" },
  { key: "accountant", name: "Anil Mehta", email: `accountant@${DOMAIN}`, role: "accountant", label: "Accountant", what: "Accountant: fee structures, collections and receipts" },
  { key: "librarian", name: "Lata Joshi", email: `librarian@${DOMAIN}`, role: "librarian", label: "Librarian", what: "Librarian: catalogue, issue and return books, fines" },
  { key: "transport", name: "Suresh Patil", email: `transport@${DOMAIN}`, role: "transport_manager", label: "Transport manager", what: "Transport: buses, routes, stops and riders" },
  { key: "warden", name: "Geeta Rao", email: `warden@${DOMAIN}`, role: "warden", label: "Hostel warden", what: "Hostel: rooms, beds and residents" },
  { key: "student1", name: "Ravi Kumar", email: `student1@${DOMAIN}`, role: "student", label: "Student", what: "Student (enrolled in 8-A Science)" },
  { key: "student2", name: "Anya Singh", email: `student2@${DOMAIN}`, role: "student", label: "Student", what: "Student (enrolled in 8-A Science)" },
  { key: "parent", name: "Sunita Kumar", email: `parent@${DOMAIN}`, role: "parent", label: "Parent", what: "Parent of Ravi Kumar" },
];

const generatePassword = () => `${randomBytes(9).toString("base64url")}#7`;

async function ensureUser(db: Db, u: DemoUser, password: string, reset: boolean): Promise<{ id: string; password: string | null }> {
  const existing = (await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [u.email])).rows[0];
  if (existing) {
    if (!reset) return { id: existing.id, password: null };
    await db.query(`UPDATE users SET password_hash = $2, status = 'active', updated_at = now() WHERE id = $1`, [existing.id, await hashPassword(password)]);
    return { id: existing.id, password };
  }
  const row = (await db.query(`INSERT INTO users (name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id`, [u.name, u.email, await hashPassword(password)])).rows[0];
  return { id: row.id, password };
}

/**
 * Sample timetable, announcements, homework, attendance and marks so every screen has
 * something to show. Added once: skipped when Demo School already has announcements.
 */
async function seedSchoolRecords(db: Db, c: { tenantId: string; classId: string; ids: Record<string, string>; s1: string; s2: string }) {
  const done = await db.query(`SELECT 1 FROM announcements WHERE tenant_id = $1 LIMIT 1`, [c.tenantId]);
  if (done.rowCount) return;
  const { tenantId: t, classId: cls, ids, s1, s2 } = c;

  const periods: [number, string, string, string, string][] = [
    [1, "09:00", "09:45", "Science", "Lab 1"],
    [2, "10:00", "10:45", "Science", "Room 8A"],
    [3, "09:00", "09:45", "Science — practical", "Lab 1"],
    [4, "11:00", "11:45", "Science", "Room 8A"],
    [5, "09:00", "09:45", "Science — revision", "Room 8A"],
  ];
  for (const [day, start, end, subject, room] of periods) {
    await db.query(`INSERT INTO timetable_slots (tenant_id, class_id, day_of_week, start_time, end_time, subject, room) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t, cls, day, start, end, subject, room]);
  }

  await db.query(
    `INSERT INTO announcements (tenant_id, class_id, title, body, audience, pinned, created_by) VALUES
       ($1, NULL, 'Welcome to the new term', 'Classes begin at 8:45 am. Please make sure your child carries the school ID card every day.', 'all', true, $2),
       ($1, $3, 'Unit test on Friday', 'Chapter 11 — Force and Pressure. Revise the worked examples and bring a geometry box.', 'students', false, $4)`,
    [t, ids.principal, cls, ids.teacher],
  );

  const hw = (
    await db.query(
      `INSERT INTO assignments (tenant_id, class_id, title, description, due_at, max_points, created_by) VALUES
         ($1,$2,'Pressure in daily life','List five everyday examples where pressure is increased or reduced, and explain each in one line.', now() + interval '3 days', 10, $3),
         ($1,$2,'Worksheet: force and area','Solve questions 1–8 from the worksheet shared in class.', now() - interval '2 days', 20, $3)
       RETURNING id`,
      [t, cls, ids.teacher],
    )
  ).rows;
  await db.query(
    `INSERT INTO assignment_submissions (tenant_id, assignment_id, student_id, content, points, feedback, graded_by, graded_at)
     VALUES ($1,$2,$3,'Answers to questions 1–8 attached in class.', 17, 'Good work — recheck the units in question 6.', $4, now())`,
    [t, hw[1].id, s1, ids.teacher],
  );

  // The five school days (Monday–Saturday) before today; today is left for the teacher to mark.
  const pattern = [
    ["present", "present"],
    ["present", "late"],
    ["late", "present"],
    ["present", "absent"],
    ["present", "present"],
  ];
  for (let i = 0; i < pattern.length; i++) {
    for (const [sid, status] of [[s1, pattern[i][0]], [s2, pattern[i][1]]]) {
      await db.query(
        `INSERT INTO attendance_records (tenant_id, class_id, student_id, date, status, marked_by)
         VALUES ($1,$2,$3,(SELECT d::date FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 1, (now() AT TIME ZONE 'Asia/Kolkata')::date - 14, interval '-1 day') d
                           WHERE extract(isodow FROM d) < 7 OFFSET $4 LIMIT 1),$5,$6) ON CONFLICT DO NOTHING`,
        [t, cls, sid, i, status, ids.teacher],
      );
    }
  }

  const items = (
    await db.query(
      `INSERT INTO grade_items (tenant_id, class_id, title, term, category, max_marks, date, created_by) VALUES
         ($1,$2,'Unit test 1 — Crop production','Term 1','test',20,(now() - interval '20 days')::date,$3),
         ($1,$2,'Project — Model of a water cycle','Term 1','project',30,(now() - interval '10 days')::date,$3)
       RETURNING id`,
      [t, cls, ids.teacher],
    )
  ).rows;
  const marks: [string, string, number, string | null][] = [
    [items[0].id, s1, 18, "Excellent"],
    [items[0].id, s2, 14, null],
    [items[1].id, s1, 26, "Creative model"],
    [items[1].id, s2, 21, "Label the diagram"],
  ];
  for (const [item, sid, m, remarks] of marks) {
    await db.query(`INSERT INTO grade_scores (tenant_id, item_id, student_id, marks, remarks, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`, [t, item, sid, m, remarks, ids.teacher]);
  }
}

/**
 * Sample fees (one part-paid), a published exam date sheet and a small library with
 * one book on loan. Added once: skipped when Demo School already has fee structures.
 */
async function seedCampusRecords(db: Db, c: { tenantId: string; classId: string; ids: Record<string, string>; s1: string; s2: string }) {
  const done = await db.query(`SELECT 1 FROM fee_structures WHERE tenant_id = $1 LIMIT 1`, [c.tenantId]);
  if (done.rowCount) return;
  const { tenantId: t, classId: cls, ids, s1, s2 } = c;
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

  const tuition = (
    await db.query(
      `INSERT INTO fee_structures (tenant_id, name, category, amount_paise, due_date, class_id, created_by)
       VALUES ($1,'Term 1 tuition fee','tuition',1500000,${today} + 15,$2,$3) RETURNING id, name, amount_paise, due_date`,
      [t, cls, ids.accountant],
    )
  ).rows[0];
  const transport = (
    await db.query(
      `INSERT INTO fee_structures (tenant_id, name, category, amount_paise, due_date, created_by)
       VALUES ($1,'Transport — October','transport',180000,${today} - 5,$2) RETURNING id, name, amount_paise, due_date`,
      [t, ids.accountant],
    )
  ).rows[0];
  const inv: Record<string, string> = {};
  for (const s of [tuition, transport]) {
    for (const sid of [s1, s2]) {
      const r = await db.query(
        `INSERT INTO fee_invoices (tenant_id, student_id, structure_id, title, amount_paise, due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [t, sid, s.id, s.name, s.amount_paise, s.due_date],
      );
      inv[`${s.name}:${sid}`] = r.rows[0].id;
    }
  }
  const year = new Date().getFullYear();
  const payments: [string, number, string, string | null][] = [
    [inv[`Term 1 tuition fee:${s1}`], 1000000, "upi", "UPI-4417820931"],
    [inv[`Transport — October:${s1}`], 180000, "cash", null],
  ];
  for (let i = 0; i < payments.length; i++) {
    const [invoice, amount, method, ref] = payments[i];
    await db.query(
      `INSERT INTO fee_payments (tenant_id, invoice_id, amount_paise, method, reference, receipt_no, received_by, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() - make_interval(days => $8))`,
      [t, invoice, amount, method, ref, `RCPT-${year}-${String(i + 1).padStart(5, "0")}`, ids.accountant, 3 - i],
    );
  }

  const exam = (
    await db.query(
      `INSERT INTO exams (tenant_id, name, term, start_date, end_date, status, instructions, created_by)
       VALUES ($1,'Half-yearly examination','Term 1',${today} + 7,${today} + 12,'published','Report to the exam hall 15 minutes early. Carry your school ID card.',$2) RETURNING id, name, term`,
      [t, ids.admin],
    )
  ).rows[0];
  const papers: [string, number, string, string][] = [
    ["Science", 7, "09:00", "Hall A"],
    ["Mathematics", 9, "09:00", "Hall A"],
    ["English", 11, "09:00", "Hall B"],
  ];
  for (const [subject, offset, start, room] of papers) {
    const item = (
      await db.query(
        `INSERT INTO grade_items (tenant_id, class_id, title, term, category, max_marks, date, created_by) VALUES ($1,$2,$3,$4,'exam',80,${today} + $5::int,$6) RETURNING id`,
        [t, cls, `${exam.name} — ${subject}`, exam.term, offset, ids.admin],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO exam_papers (tenant_id, exam_id, class_id, subject, date, start_time, duration_minutes, max_marks, pass_marks, room, grade_item_id)
       VALUES ($1,$2,$3,$4,${today} + $5::int,$6,180,80,27,$7,$8)`,
      [t, exam.id, cls, subject, offset, start, room, item.id],
    );
  }

  const books: [string, string, string, string, number][] = [
    ["Wings of Fire", "A. P. J. Abdul Kalam", "Biography", "A-1", 3],
    ["The Story of My Experiments with Truth", "M. K. Gandhi", "Biography", "A-1", 2],
    ["Malgudi Days", "R. K. Narayan", "Fiction", "B-2", 4],
    ["Panchatantra Tales", "Vishnu Sharma", "Fiction", "B-3", 5],
    ["NCERT Science — Class 8", "NCERT", "Science", "C-1", 10],
    ["A Brief History of Time", "Stephen Hawking", "Science", "C-2", 1],
    ["Discovery of India", "Jawaharlal Nehru", "History", "D-1", 2],
    ["Oxford Student Atlas for India", "Oxford University Press", "Reference", "R-1", 6],
  ];
  const ids2: string[] = [];
  for (const [title, author, category, shelf, copies] of books) {
    ids2.push((await db.query(`INSERT INTO library_books (tenant_id, title, author, category, shelf, total_copies) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [t, title, author, category, shelf, copies])).rows[0].id);
  }
  const ravi = (await db.query(`SELECT user_id FROM student_profiles WHERE id = $1`, [s1])).rows[0].user_id;
  const anya = (await db.query(`SELECT user_id FROM student_profiles WHERE id = $1`, [s2])).rows[0].user_id;
  await db.query(`INSERT INTO library_loans (tenant_id, book_id, user_id, issued_at, due_date, issued_by) VALUES ($1,$2,$3, now() - interval '5 days', ${today} + 9, $4)`, [t, ids2[0], ravi, ids.librarian]);
  await db.query(`INSERT INTO library_loans (tenant_id, book_id, user_id, issued_at, due_date, issued_by) VALUES ($1,$2,$3, now() - interval '17 days', ${today} - 3, $4)`, [t, ids2[2], anya, ids.librarian]);
}

/** Two bus routes and two hostels, with both demo students placed. Added once. */
async function seedTransportAndHostel(db: Db, c: { tenantId: string; ids: Record<string, string>; s1: string; s2: string }) {
  const done = await db.query(`SELECT 1 FROM transport_routes WHERE tenant_id = $1 LIMIT 1`, [c.tenantId]);
  if (done.rowCount) return;
  const { tenantId: t, ids, s1, s2 } = c;

  const bus = async (reg: string, label: string, capacity: number, driver: string, phone: string) =>
    (
      await db.query(
        `INSERT INTO transport_vehicles (tenant_id, registration_no, label, capacity, driver_name, driver_phone, attendant_name, attendant_phone)
         VALUES ($1,$2,$3,$4,$5,$6,'Lakshmi','9845012345') RETURNING id`,
        [t, reg, label, capacity, driver, phone],
      )
    ).rows[0].id as string;
  const v1 = await bus("KA05MN4821", "Bus 1", 40, "Ramesh Gowda", "9845098450");
  const v2 = await bus("KA05MP1907", "Bus 2", 32, "Imran Khan", "9900199001");
  const routes: [string, string, [string, string, string, string][]][] = [
    ["Route 1 — Jayanagar", v1, [["Jayanagar 4th Block", "Near the shopping complex", "07:05", "15:45"], ["South End Circle", "Metro station gate", "07:15", "15:35"], ["Lalbagh West Gate", "", "07:25", "15:25"], ["School", "Main gate", "07:45", "15:05"]]],
    ["Route 2 — Indiranagar", v2, [["Indiranagar 100 Feet Road", "Opposite the bank", "07:00", "15:50"], ["Domlur Flyover", "", "07:12", "15:38"], ["Richmond Circle", "Bus stop", "07:28", "15:22"], ["School", "Main gate", "07:45", "15:05"]]],
  ];
  const firstStop: string[] = [];
  for (const [name, vehicle, stops] of routes) {
    const r = (await db.query(`INSERT INTO transport_routes (tenant_id, name, vehicle_id) VALUES ($1,$2,$3) RETURNING id`, [t, name, vehicle])).rows[0].id;
    for (let i = 0; i < stops.length; i++) {
      const [stop, landmark, pickup, drop] = stops[i];
      const id = (
        await db.query(`INSERT INTO transport_stops (tenant_id, route_id, name, landmark, sequence, pickup_time, drop_time) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
          t,
          r,
          stop,
          landmark || null,
          i + 1,
          pickup,
          drop,
        ])
      ).rows[0].id;
      if (i === 1) firstStop.push(`${r}:${id}`);
    }
  }
  for (const [sid, slot] of [[s1, firstStop[0]], [s2, firstStop[1]]] as const) {
    const [route, stop] = slot.split(":");
    await db.query(`INSERT INTO transport_assignments (tenant_id, student_id, route_id, stop_id) VALUES ($1,$2,$3,$4)`, [t, sid, route, stop]);
  }

  const hostel = async (name: string, kind: string, phone: string) =>
    (await db.query(`INSERT INTO hostels (tenant_id, name, kind, warden_id, phone, address) VALUES ($1,$2,$3,$4,$5,'Campus north block') RETURNING id`, [t, name, kind, ids.warden, phone])).rows[0]
      .id as string;
  const boys = await hostel("Ganga House", "boys", "080-41234567");
  const girls = await hostel("Kaveri House", "girls", "080-41234568");
  let ravisRoom = "";
  for (const [h, prefix] of [[boys, "1"], [girls, "2"]] as const) {
    for (let n = 1; n <= 4; n++) {
      const room = (
        await db.query(`INSERT INTO hostel_rooms (tenant_id, hostel_id, room_no, floor, capacity, room_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
          t,
          h,
          `${prefix}0${n}`,
          1,
          n === 4 ? 2 : 3,
          n === 4 ? "ac" : "standard",
        ])
      ).rows[0].id;
      if (h === boys && n === 1) ravisRoom = room;
    }
  }
  await db.query(`INSERT INTO hostel_allocations (tenant_id, room_id, student_id, start_date, created_by) VALUES ($1,$2,$3,(now() AT TIME ZONE 'Asia/Kolkata')::date - 30,$4)`, [
    t,
    ravisRoom,
    s1,
    ids.warden,
  ]);

  // A few AI-teacher questions so the student starts with some XP and a streak.
  const session = (await db.query(`INSERT INTO tutor_sessions (tenant_id, student_id) VALUES ($1,$2) RETURNING id`, [t, s1])).rows[0].id;
  for (const [q, daysAgo] of [["Why do knives have sharp edges?", 2], ["What is atmospheric pressure?", 1], ["Why do camels have wide feet?", 0]] as const) {
    await db.query(`INSERT INTO tutor_messages (tenant_id, session_id, role, content, created_at) VALUES ($1,$2,'student',$3, now() - make_interval(days => $4))`, [t, session, q, daysAgo]);
  }
}

/** HR profiles, calendar events, a conversation, PTM slots, a leave request and admission enquiries. Added once. */
async function seedOfficeRecords(db: Db, c: { tenantId: string; ids: Record<string, string>; s1: string }) {
  const done = await db.query(`SELECT 1 FROM school_events WHERE tenant_id = $1 LIMIT 1`, [c.tenantId]);
  if (done.rowCount) return;
  const { tenantId: t, ids, s1 } = c;
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

  const staff: [string, string, string, string, number, number][] = [
    ["principal", "EMP-001", "Principal", "Administration", 90000, 36000],
    ["admin", "EMP-002", "Administrative officer", "Administration", 45000, 18000],
    ["teacher", "EMP-003", "TGT Science", "Science", 38000, 15200],
    ["staff", "EMP-004", "HR executive", "Office", 30000, 12000],
    ["accountant", "EMP-005", "Accountant", "Accounts", 32000, 12800],
    ["librarian", "EMP-006", "Librarian", "Library", 26000, 10400],
    ["transport", "EMP-007", "Transport in-charge", "Transport", 24000, 9600],
    ["warden", "EMP-008", "Hostel warden", "Hostel", 25000, 10000],
  ];
  for (const [key, code, designation, dept, basic, hra] of staff) {
    await db.query(
      `INSERT INTO staff_profiles (tenant_id, user_id, employee_code, designation, department, date_joined, phone, basic_paise, hra_paise, da_paise, other_paise, tds_paise, bank_account_last4)
       VALUES ($1,$2,$3,$4,$5,'2022-06-01','98450' || substr($3, 5, 3) || '000',$6,$7,$8,150000,$9,lpad(substr($3, 5, 3), 4, '1'))
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [t, ids[key], code, designation, dept, basic * 100, hra * 100, Math.round(basic * 0.1) * 100, basic >= 45000 ? 250000 : 0],
    );
  }

  const events: [string, string, number, number, string][] = [
    ["Gandhi Jayanti", "holiday", -18, -18, "all"],
    ["Annual sports day", "sports", 12, 12, "all"],
    ["Parent-teacher meeting", "meeting", 4, 4, "parents"],
    ["Inter-house quiz", "cultural", 20, 20, "students"],
    ["Diwali break", "holiday", 15, 17, "all"],
    ["Staff development workshop", "meeting", 9, 9, "staff"],
  ];
  for (const [title, kind, a, b, audience] of events) {
    await db.query(`INSERT INTO school_events (tenant_id, title, kind, start_date, end_date, audience, created_by) VALUES ($1,$2,$3,${today} + $4::int,${today} + $5::int,$6,$7)`, [t, title, kind, a, b, audience, ids.principal]);
  }

  const conv = (await db.query(`INSERT INTO conversations (tenant_id, subject, student_id, created_by, last_message_at) VALUES ($1,'Science project',$2,$3, now() - interval '2 hours') RETURNING id`, [t, s1, ids.parent])).rows[0].id;
  await db.query(`INSERT INTO conversation_members (tenant_id, conversation_id, user_id, last_read_at) VALUES ($1,$2,$3, now()), ($1,$2,$4, now() - interval '1 day')`, [t, conv, ids.parent, ids.teacher]);
  for (const [who, body, ago] of [
    ["parent", "Namaste Ma'am, Ravi says the water-cycle model is due next week. Can he use clay?", "5 hours"],
    ["teacher", "Namaste! Yes, clay or thermocol are both fine. Please make sure he labels each stage.", "4 hours"],
    ["parent", "Thank you, we'll get started this weekend.", "2 hours"],
  ] as const) {
    await db.query(`INSERT INTO messages (tenant_id, conversation_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4, now() - $5::interval)`, [t, conv, ids[who], body, ago]);
  }

  await db.query(
    `INSERT INTO ptm_slots (tenant_id, teacher_id, starts_at, duration_minutes, location)
     SELECT $1, $2, g, 15, 'Room 8A' FROM generate_series(((${today} + 4) + time '15:30') AT TIME ZONE 'Asia/Kolkata',
                                                          ((${today} + 4) + time '16:45') AT TIME ZONE 'Asia/Kolkata', interval '15 minutes') g`,
    [t, ids.teacher],
  );

  await db.query(
    `INSERT INTO leave_requests (tenant_id, kind, requester_id, student_id, start_date, end_date, reason) VALUES ($1,'student',$2,$3,${today} + 6,${today} + 7,'Cousin''s wedding in Mysuru')`,
    [t, ids.parent, s1],
  );

  const apps: [string, string, string, string, string, string][] = [
    ["Ishaan Mehta", "Class 6", "Priya Mehta", "priya.mehta@example.com", "9876501234", "enquiry"],
    ["Diya Reddy", "Class 8", "Srinivas Reddy", "srinivas.reddy@example.com", "9876502345", "interview"],
    ["Aarav Nair", "Class 3", "Lakshmi Nair", "lakshmi.nair@example.com", "9876503456", "applied"],
  ];
  for (const [student, grade, parentName, email, phone, status] of apps) {
    await db.query(
      `INSERT INTO admission_applications (tenant_id, student_name, grade_applying, parent_name, parent_email, parent_phone, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t, student, grade, parentName, email, phone, status, status === "enquiry" ? "website" : "office"],
    );
  }
  await db.query(`UPDATE student_profiles SET admission_no = 'ADM-2025-0' || CASE WHEN id = $2 THEN '101' ELSE '102' END, blood_group = CASE WHEN id = $2 THEN 'B+' ELSE 'O+' END,
                    guardian_name = CASE WHEN id = $2 THEN 'Sunita Kumar' ELSE NULL END, guardian_phone = '9845011111', admitted_on = '2025-04-01'
                   WHERE tenant_id = $1 AND admission_no IS NULL`, [t, s1]);
}

/**
 * The 2026-27 session with two terms and holidays, CBSE Class 8 profile for the demo class,
 * Science (from the built-in library), Mathematics and English syllabi, and generated plans
 * with a few chapters already taught. Added once.
 */
async function seedAcademics(db: Db, c: { tenantId: string; classId: string; ids: Record<string, string> }) {
  const done = await db.query(`SELECT 1 FROM academic_years WHERE tenant_id = $1 LIMIT 1`, [c.tenantId]);
  if (done.rowCount) return;
  const { tenantId: t, classId, ids } = c;
  const year = (
    await db.query(`INSERT INTO academic_years (tenant_id, name, start_date, end_date, is_current) VALUES ($1,'2026-27','2026-04-01','2027-03-31',true) RETURNING id`, [t])
  ).rows[0].id;
  await db.query(
    `INSERT INTO academic_terms (tenant_id, year_id, name, sequence, start_date, end_date, exam_start, exam_end) VALUES
       ($1,$2,'Term 1',1,'2026-04-01','2026-09-30','2026-09-15','2026-09-30'),
       ($1,$2,'Term 2',2,'2026-10-01','2027-03-31','2027-03-01','2027-03-20')`,
    [t, year],
  );
  const holidays = [...holidaysBetween("2026-04-01", "2027-03-31"), { date: "2026-05-15", name: "Summer vacation", end: "2026-06-14" }];
  for (const h of holidays) {
    const dup = await db.query(`SELECT 1 FROM school_events WHERE tenant_id = $1 AND kind = 'holiday' AND start_date = $2`, [t, h.date]);
    if (dup.rowCount) continue;
    await db.query(`INSERT INTO school_events (tenant_id, title, kind, start_date, end_date, audience, created_by) VALUES ($1,$2,'holiday',$3,$4,'all',$5)`, [
      t,
      h.name,
      h.date,
      "end" in h ? h.end : h.date,
      ids.principal,
    ]);
  }
  await db.query(`UPDATE classes SET board = 'CBSE', grade = 'Class 8', section = 'A', academic_year_id = $2 WHERE id = $1`, [classId, year]);

  const syllabus = async (subject: string, chapters: [string, number][], source: string) => {
    const s = (await db.query(`INSERT INTO syllabi (tenant_id, board, grade, subject, academic_year_id, source) VALUES ($1,'CBSE','Class 8',$2,$3,$4) RETURNING id`, [t, subject, year, source])).rows[0].id;
    for (let i = 0; i < chapters.length; i++) {
      await db.query(`INSERT INTO syllabus_units (tenant_id, syllabus_id, title, sequence, est_periods) VALUES ($1,$2,$3,$4,$5)`, [t, s, chapters[i][0], i + 1, chapters[i][1]]);
    }
    return s as string;
  };
  const sciChapters = (
    await db.query(
      `SELECT ch.title, (SELECT count(*)::int FROM topics tp WHERE tp.chapter_id = ch.id) AS topics FROM chapters ch JOIN subjects s ON s.id = ch.subject_id
         JOIN curriculum_versions cv ON cv.id = ch.curriculum_version_id WHERE s.name = 'Science' AND cv.approval_status = 'approved' ORDER BY ch.sequence`,
    )
  ).rows.map((r) => [r.title, Math.min(20, Math.max(4, r.topics * 3))] as [string, number]);
  const sample = "Sample chapter list — replace with your board's current syllabus";
  const science = await syllabus("Science", sciChapters, "Built-in library");
  const maths = await syllabus(
    "Mathematics",
    [
      ["Rational Numbers", 12], ["Linear Equations in One Variable", 14], ["Understanding Quadrilaterals", 10], ["Data Handling", 10],
      ["Squares and Square Roots", 10], ["Cubes and Cube Roots", 8], ["Comparing Quantities", 12], ["Algebraic Expressions and Identities", 12],
      ["Mensuration", 14], ["Exponents and Powers", 8], ["Direct and Inverse Proportions", 10], ["Factorisation", 10], ["Introduction to Graphs", 8],
    ],
    sample,
  );
  const english = await syllabus(
    "English",
    [
      ["The Best Christmas Present in the World", 8], ["The Tsunami", 8], ["Glimpses of the Past", 8], ["Bepin Choudhury's Lapse of Memory", 8],
      ["The Summit Within", 6], ["This is Jody's Fawn", 8], ["A Visit to Cambridge", 6], ["A Short Monsoon Diary", 6], ["The Great Stone Face", 10],
    ],
    sample,
  );
  const subjects: [string, string, number, string][] = [
    ["Science", ids.teacher, 6, science],
    ["Mathematics", ids.principal, 6, maths],
    ["English", ids.admin, 5, english],
  ];
  // Taught so far: maths has fallen a chapter behind; English is ahead.
  const taught: Record<string, number> = { Science: 3, Mathematics: 4, English: 5 };
  for (const [subject, teacher, periods, syl] of subjects) {
    const cs = (
      await db.query(`INSERT INTO class_subjects (tenant_id, class_id, subject, teacher_id, periods_per_week, syllabus_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [t, classId, subject, teacher, periods, syl])
    ).rows[0].id;
    await generatePlan(db, t, cs, { from: "2026-04-01" });
    await db.query(
      `UPDATE syllabus_plan_items p SET status = 'completed', completed_on = LEAST(p.planned_end, (now() AT TIME ZONE 'Asia/Kolkata')::date)
        FROM syllabus_units u WHERE u.id = p.unit_id AND p.class_subject_id = $1 AND u.sequence <= $2`,
      [cs, taught[subject]],
    );
  }
}

export async function setupDemo(opts: { reset?: boolean; password?: string; superadminPassword?: string } = {}) {
  await seed(() => {});
  const db = await pool.connect();
  const results: { user: DemoUser; password: string | null }[] = [];
  try {
    await db.query("BEGIN");
    await enterSystemContext(db);

    const tenant =
      (await db.query(`SELECT id FROM tenants WHERE slug = 'demo-school'`)).rows[0] ??
      (await db.query(`INSERT INTO tenants (name, type, slug) VALUES ('Demo School', 'school', 'demo-school') RETURNING id`)).rows[0];
    const cv = (await db.query(`SELECT id FROM curriculum_versions WHERE approval_status = 'approved' ORDER BY created_at LIMIT 1`)).rows[0];

    const ids: Record<string, string> = {};
    for (const u of USERS) {
      const chosen = u.key === "superadmin" ? (opts.superadminPassword ?? opts.password) : opts.password;
      const r = await ensureUser(db, u, chosen ?? generatePassword(), !!opts.reset);
      ids[u.key] = r.id;
      results.push({ user: u, password: r.password });
      // Each demo user has exactly one role in Demo School, and only the super admin is a platform admin.
      await db.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND role_id <> $3`, [tenant.id, r.id, u.role]);
      await db.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET status = 'active'`,
        [tenant.id, r.id, u.role],
      );
      await db.query(`UPDATE users SET is_platform_admin = $2 WHERE id = $1`, [r.id, u.key === "superadmin"]);
      if (u.role === "student") {
        await db.query(
          `INSERT INTO student_profiles (tenant_id, user_id, curriculum_version_id) VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET curriculum_version_id = COALESCE(student_profiles.curriculum_version_id, EXCLUDED.curriculum_version_id)`,
          [tenant.id, r.id, cv?.id ?? null],
        );
      }
    }

    const profile = async (key: string) =>
      (await db.query(`SELECT id FROM student_profiles WHERE tenant_id = $1 AND user_id = $2`, [tenant.id, ids[key]])).rows[0].id as string;
    const s1 = await profile("student1");
    const s2 = await profile("student2");
    await db.query(
      `INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'mother','granted')
       ON CONFLICT (parent_id, student_id) DO NOTHING`,
      [tenant.id, ids.parent, s1],
    );

    // A class with both students and a live AI lesson ready to start.
    let cls = (await db.query(`SELECT id FROM classes WHERE tenant_id = $1 AND name = '8-A Science'`, [tenant.id])).rows[0];
    if (!cls) {
      cls = (await db.query(`INSERT INTO classes (tenant_id, name, teacher_id, curriculum_version_id) VALUES ($1,'8-A Science',$2,$3) RETURNING id`, [tenant.id, ids.teacher, cv?.id ?? null])).rows[0];
    }
    await db.query(`INSERT INTO class_enrollments (tenant_id, class_id, student_id) VALUES ($1,$2,$3), ($1,$2,$4) ON CONFLICT DO NOTHING`, [tenant.id, cls.id, s1, s2]);
    const lesson = (
      await db.query(`SELECT l.id, l.title FROM lessons l JOIN topics t ON t.id = l.topic_id WHERE l.status = 'published' AND t.title LIKE 'Pressure%' LIMIT 1`)
    ).rows[0];
    const pending = await db.query(`SELECT 1 FROM live_sessions WHERE class_id = $1 AND status IN ('scheduled','live')`, [cls.id]);
    if (lesson && !pending.rowCount) {
      await db.query(`INSERT INTO live_sessions (tenant_id, class_id, lesson_id, title, created_by) VALUES ($1,$2,$3,$4,$5)`, [tenant.id, cls.id, lesson.id, lesson.title, ids.teacher]);
    }
    await seedSchoolRecords(db, { tenantId: tenant.id, classId: cls.id, ids, s1, s2 });
    await seedCampusRecords(db, { tenantId: tenant.id, classId: cls.id, ids, s1, s2 });
    await seedTransportAndHostel(db, { tenantId: tenant.id, ids, s1, s2 });
    await seedOfficeRecords(db, { tenantId: tenant.id, ids, s1 });
    await seedAcademics(db, { tenantId: tenant.id, classId: cls.id, ids });
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const reset = process.argv.includes("--reset-passwords");
  setupDemo({ reset, password: process.env.DEMO_PASSWORD, superadminPassword: process.env.SUPERADMIN_PASSWORD })
    .then((results) => {
      console.log("\nAI Gurukul demo accounts (organization: Demo School)\n");
      for (const { user, password } of results) {
        console.log(`  ${user.label.toUpperCase()} — ${user.what}`);
        console.log(`    email:    ${user.email}`);
        console.log(`    password: ${password ?? "(unchanged — already existed; rerun with --reset-passwords to issue a new one)"}\n`);
      }
      console.log("A live AI lesson for class 8-A Science is scheduled: sign in as the teacher → Live Classes → Open & start.");
      console.log("Store these passwords safely; they are not shown again. Change or disable demo accounts before real use.\n");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
