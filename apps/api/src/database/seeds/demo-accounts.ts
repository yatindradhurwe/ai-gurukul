/**
 * Creates a ready-to-use demo school with one login per role and prints them.
 *
 *   npm run setup:demo                         # random passwords, printed once
 *   DEMO_PASSWORD='MyPass#2026' npm run setup:demo
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
  role: string;
  what: string;
}

const USERS: DemoUser[] = [
  { key: "admin", name: "Platform Admin", email: process.env.ADMIN_EMAIL ?? `admin@${DOMAIN}`, role: "tenant_owner", what: "Platform super-admin (+ owner of Demo School)" },
  { key: "principal", name: "Principal Sharma", email: `principal@${DOMAIN}`, role: "tenant_owner", what: "School owner: members, content, billing" },
  { key: "teacher", name: "Meera Iyer", email: `teacher@${DOMAIN}`, role: "teacher", what: "Teacher: classes, live AI lessons, doubts" },
  { key: "student1", name: "Ravi Kumar", email: `student1@${DOMAIN}`, role: "student", what: "Student (enrolled in 8-A Science)" },
  { key: "student2", name: "Anya Singh", email: `student2@${DOMAIN}`, role: "student", what: "Student (enrolled in 8-A Science)" },
  { key: "parent", name: "Sunita Kumar", email: `parent@${DOMAIN}`, role: "parent", what: "Parent of Ravi Kumar" },
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

export async function setupDemo(opts: { reset?: boolean; password?: string } = {}) {
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
      const r = await ensureUser(db, u, opts.password ?? generatePassword(), !!opts.reset);
      ids[u.key] = r.id;
      results.push({ user: u, password: r.password });
      await db.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET status = 'active'`,
        [tenant.id, r.id, u.role],
      );
      if (u.role === "student") {
        await db.query(
          `INSERT INTO student_profiles (tenant_id, user_id, curriculum_version_id) VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET curriculum_version_id = COALESCE(student_profiles.curriculum_version_id, EXCLUDED.curriculum_version_id)`,
          [tenant.id, r.id, cv?.id ?? null],
        );
      }
    }
    await db.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [ids.admin]);

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
  setupDemo({ reset, password: process.env.DEMO_PASSWORD })
    .then((results) => {
      console.log("\nAI Gurukul demo accounts (organization: Demo School)\n");
      for (const { user, password } of results) {
        console.log(`  ${user.what}`);
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
