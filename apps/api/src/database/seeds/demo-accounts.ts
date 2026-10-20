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

  // Five school days of attendance, ending yesterday (today is left for the teacher to mark).
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
         VALUES ($1,$2,$3,(now() AT TIME ZONE 'Asia/Kolkata')::date - $4::int,$5,$6) ON CONFLICT DO NOTHING`,
        [t, cls, sid, i + 1, status, ids.teacher],
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
