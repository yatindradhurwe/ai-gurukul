import { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant, type Db } from "../../database/pool.js";
import { hashPassword } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { STAFF_ROLES } from "../../lib/permissions.js";
import { requirePermission } from "../../middleware/authorization.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { assertStudentSeatAvailable } from "../tenants/service.js";

export const admissionsRouter = Router();
export const idCardsRouter = Router();
/** Unauthenticated: the school's public admission form. */
export const publicAdmissionsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const STAGES = ["enquiry", "applied", "interview", "offered", "admitted", "rejected"] as const;

const applicationSchema = z.object({
  studentName: z.string().trim().min(2).max(120),
  dateOfBirth: date.nullish(),
  gradeApplying: z.string().trim().min(1).max(40),
  parentName: z.string().trim().min(2).max(120),
  parentEmail: z.string().trim().toLowerCase().email(),
  parentPhone: z.string().trim().min(6).max(20),
  address: z.string().trim().max(400).nullish(),
  previousSchool: z.string().trim().max(160).nullish(),
  message: z.string().trim().max(2000).nullish(),
});

async function insertApplication(db: Db, tenantId: string, b: z.infer<typeof applicationSchema>, source: "website" | "office", status: string) {
  return (
    await db.query(
      `INSERT INTO admission_applications (tenant_id, student_name, date_of_birth, grade_applying, parent_name, parent_email, parent_phone, address, previous_school, message, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tenantId, b.studentName, b.dateOfBirth ?? null, b.gradeApplying, b.parentName, b.parentEmail, b.parentPhone, b.address ?? null, b.previousSchool ?? null, b.message ?? null, source, status],
    )
  ).rows[0];
}

async function publicTenant(slug: string) {
  const t = await withSystem(async (db) => (await db.query(`SELECT id, name, type, settings FROM tenants WHERE slug = $1 AND status = 'active'`, [slug])).rows[0]);
  if (!t || !["school", "coaching"].includes(t.type)) throw notFound("School");
  return t;
}

publicAdmissionsRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const t = await publicTenant(req.params.slug);
    res.json({ school: { name: t.name, logoUrl: t.settings?.logoUrl ?? null, supportEmail: t.settings?.supportEmail ?? null, supportPhone: t.settings?.supportPhone ?? null } });
  }),
);

publicAdmissionsRouter.post(
  "/:slug",
  rateLimit({ name: "public-admissions", windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const t = await publicTenant(req.params.slug);
    const b = parse(applicationSchema, req.body);
    const row = await withTenant(t.id, (db) => insertApplication(db, t.id, b, "website", "enquiry"));
    res.status(201).json({ ok: true, reference: row.id.slice(0, 8).toUpperCase() });
  }),
);

admissionsRouter.get(
  "/",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ status: z.enum(STAGES).optional(), search: z.string().trim().max(100).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const rows = await db.query(
        `SELECT * FROM admission_applications
          WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR student_name ILIKE '%' || $2 || '%' OR parent_name ILIKE '%' || $2 || '%' OR parent_phone ILIKE '%' || $2 || '%')
          ORDER BY updated_at DESC LIMIT 500`,
        [q.status ?? null, q.search || null],
      );
      const counts = Object.fromEntries((await db.query(`SELECT status, count(*)::int AS n FROM admission_applications GROUP BY status`)).rows.map((r) => [r.status, r.n]));
      return { applications: rows.rows, counts };
    });
    res.json(data);
  }),
);

admissionsRouter.post(
  "/",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(applicationSchema, req.body);
    const row = await withTenant(tenant.id, (db) => insertApplication(db, tenant.id, b, "office", "applied"));
    res.status(201).json({ application: row });
  }),
);

admissionsRouter.patch(
  "/:id",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ status: z.enum(["enquiry", "applied", "interview", "offered", "rejected"]).optional(), notes: z.string().trim().max(2000).nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const a = (await db.query(`SELECT status FROM admission_applications WHERE id = $1`, [req.params.id])).rows[0];
      if (!a) throw notFound("Application");
      if (a.status === "admitted") throw conflict("This student has already been admitted");
      const u = (
        await db.query(`UPDATE admission_applications SET status = COALESCE($2, status), notes = CASE WHEN $4 THEN $3 ELSE notes END, updated_at = now() WHERE id = $1 RETURNING *`, [
          req.params.id,
          b.status ?? null,
          b.notes ?? null,
          b.notes !== undefined,
        ])
      ).rows[0];
      if (b.status) await audit(db, { tenantId: tenant.id, actorId: userId, action: `admission.${b.status}`, resourceType: "admission_application", resourceId: u.id });
      return u;
    });
    res.json({ application: row });
  }),
);

/** Next admission number for the year, e.g. ADM-2026-0007. */
async function nextAdmissionNo(db: Db, tenantId: string) {
  const year = new Date().getFullYear();
  const n = (await db.query(`SELECT count(*)::int + 1 AS n FROM student_profiles WHERE tenant_id = $1 AND admission_no LIKE $2`, [tenantId, `ADM-${year}-%`])).rows[0].n;
  return `ADM-${year}-${String(n).padStart(4, "0")}`;
}

/** Admit an applicant: create the student's login and profile, enrol them, and link (or create) the parent. */
admissionsRouter.post(
  "/:id/admit",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        studentEmail: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(200),
        classId: z.string().uuid().nullish(),
        bloodGroup: z.string().trim().max(5).nullish(),
        createParent: z.boolean().default(false),
        parentPassword: z.string().min(8).max(200).nullish(),
      }),
      req.body,
    );
    if (b.createParent && !b.parentPassword) throw badRequest("Choose a password for the parent's account");
    const [studentHash, parentHash] = await Promise.all([hashPassword(b.password), b.parentPassword ? hashPassword(b.parentPassword) : Promise.resolve(null)]);
    const result = await withSystem(async (db) => {
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':admissions'))`, [tenant.id]);
      const a = (await db.query(`SELECT * FROM admission_applications WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, tenant.id])).rows[0];
      if (!a) throw notFound("Application");
      if (a.status === "admitted") throw conflict("This student has already been admitted");
      if (a.status === "rejected") throw conflict("This application was rejected");
      if ((await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [b.studentEmail])).rowCount) throw conflict("An account with the student's email already exists");
      if (b.classId && !(await db.query(`SELECT 1 FROM classes WHERE id = $1 AND tenant_id = $2`, [b.classId, tenant.id])).rowCount) throw notFound("Class");
      await assertStudentSeatAvailable(db, tenant.id);

      const user = (await db.query(`INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [a.student_name, b.studentEmail, studentHash])).rows[0];
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,'student')`, [tenant.id, user.id]);
      const cv = (await db.query(`SELECT id FROM curriculum_versions WHERE approval_status = 'approved' ORDER BY created_at LIMIT 1`)).rows[0];
      const admissionNo = await nextAdmissionNo(db, tenant.id);
      const sp = (
        await db.query(
          `INSERT INTO student_profiles (tenant_id, user_id, curriculum_version_id, admission_no, date_of_birth, blood_group, guardian_name, guardian_phone, address, admitted_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(now() AT TIME ZONE 'Asia/Kolkata')::date) RETURNING id`,
          [tenant.id, user.id, cv?.id ?? null, admissionNo, a.date_of_birth, b.bloodGroup ?? null, a.parent_name, a.parent_phone, a.address],
        )
      ).rows[0];
      if (b.classId) await db.query(`INSERT INTO class_enrollments (tenant_id, class_id, student_id) VALUES ($1,$2,$3)`, [tenant.id, b.classId, sp.id]);

      // Link the parent: an existing account with the application's email, or a new one if asked.
      let parentId = (await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [a.parent_email])).rows[0]?.id as string | undefined;
      let parentCreated = false;
      if (!parentId && b.createParent) {
        parentId = (await db.query(`INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [a.parent_name, a.parent_email, parentHash])).rows[0].id;
        parentCreated = true;
      }
      if (parentId) {
        await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,'parent') ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET status = 'active'`, [tenant.id, parentId]);
        await db.query(
          `INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,'guardian','granted') ON CONFLICT (parent_id, student_id) DO NOTHING`,
          [tenant.id, parentId, sp.id],
        );
      }
      await db.query(`UPDATE admission_applications SET status = 'admitted', student_id = $2, updated_at = now() WHERE id = $1`, [a.id, sp.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "admission.admit", resourceType: "student_profile", resourceId: sp.id, metadata: { admissionNo } });
      return { studentId: sp.id, admissionNo, parentLinked: !!parentId, parentCreated };
    });
    res.status(201).json(result);
  }),
);

/** Edit the details printed on a student's ID card and certificates. */
admissionsRouter.patch(
  "/students/:studentId",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({
        admissionNo: z.string().trim().max(30).nullish(),
        dateOfBirth: date.nullish(),
        bloodGroup: z.string().trim().max(5).nullish(),
        guardianName: z.string().trim().max(120).nullish(),
        guardianPhone: z.string().trim().max(20).nullish(),
        address: z.string().trim().max(400).nullish(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      if (b.admissionNo) {
        const dup = await db.query(`SELECT 1 FROM student_profiles WHERE admission_no = $1 AND id <> $2`, [b.admissionNo, req.params.studentId]);
        if (dup.rowCount) throw conflict(`Admission number ${b.admissionNo} is already used`);
      }
      const set = Object.entries({ admission_no: b.admissionNo, date_of_birth: b.dateOfBirth, blood_group: b.bloodGroup, guardian_name: b.guardianName, guardian_phone: b.guardianPhone, address: b.address }).filter(
        ([, v]) => v !== undefined,
      );
      if (!set.length) throw badRequest("Nothing to update");
      const r = (
        await db.query(`UPDATE student_profiles SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING id`, [req.params.studentId, ...set.map(([, v]) => v ?? null)])
      ).rows[0];
      if (!r) throw notFound("Student");
      return r;
    });
    res.json({ student: row });
  }),
);

// ---------------------------------------------------------------------------
// ID cards and certificates
// ---------------------------------------------------------------------------
const STUDENT_CARD = `sp.id, u.name, u.email, sp.admission_no, sp.date_of_birth, sp.blood_group, sp.guardian_name, sp.guardian_phone, sp.address, sp.admitted_on,
  (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = sp.id) AS classes`;

async function orgCardInfo(db: Db, tenantId: string) {
  const t = (await db.query(`SELECT name, settings FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  return { name: t.name, logoUrl: t.settings?.logoUrl ?? null, phone: t.settings?.supportPhone ?? null, email: t.settings?.supportEmail ?? null, primaryColor: t.settings?.primaryColor ?? null };
}

idCardsRouter.get(
  "/",
  requirePermission("admissions.manage", "members.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ type: z.enum(["students", "staff"]).default("students"), classId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const org = await orgCardInfo(db, tenant.id);
      if (q.type === "staff") {
        const rows = await db.query(
          `SELECT u.id, u.name, u.email, p.employee_code, p.designation, p.department, p.phone, p.blood_group, p.date_joined
             FROM tenant_memberships m JOIN users u ON u.id = m.user_id LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.tenant_id = m.tenant_id
            WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id = ANY($2::text[]) GROUP BY u.id, p.id ORDER BY u.name`,
          [tenant.id, STAFF_ROLES],
        );
        return { org, type: "staff", cards: rows.rows };
      }
      const rows = await db.query(
        `SELECT ${STUDENT_CARD} FROM student_profiles sp JOIN users u ON u.id = sp.user_id
          WHERE EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = sp.tenant_id AND m.user_id = sp.user_id AND m.role_id = 'student' AND m.status = 'active')
            AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM class_enrollments e WHERE e.student_id = sp.id AND e.class_id = $1))
          ORDER BY u.name`,
        [q.classId ?? null],
      );
      return { org, type: "students", cards: rows.rows };
    });
    res.json(data);
  }),
);

/** The caller's own ID card (student or staff). */
idCardsRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const org = await orgCardInfo(db, tenant.id);
      if (tenant.studentProfileId) {
        const card = (await db.query(`SELECT ${STUDENT_CARD} FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [tenant.studentProfileId])).rows[0];
        return { org, type: "students", cards: [card] };
      }
      if (!tenant.roles.some((r) => STAFF_ROLES.includes(r))) throw forbidden("ID cards are for students and staff");
      const card = (
        await db.query(
          `SELECT u.id, u.name, u.email, p.employee_code, p.designation, p.department, p.phone, p.blood_group, p.date_joined
             FROM users u LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.tenant_id = $2 WHERE u.id = $1`,
          [userId, tenant.id],
        )
      ).rows[0];
      return { org, type: "staff", cards: [card] };
    });
    res.json(data);
  }),
);

idCardsRouter.get(
  "/certificates/:studentId",
  requirePermission("admissions.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ type: z.enum(["bonafide", "character"]).default("bonafide"), purpose: z.string().trim().max(160).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = (await db.query(`SELECT ${STUDENT_CARD} FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [req.params.studentId])).rows[0];
      if (!student) throw notFound("Student");
      const org = await orgCardInfo(db, tenant.id);
      const issuer = (await db.query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0].name;
      await audit(db, { tenantId: tenant.id, actorId: userId, action: `certificate.${q.type}`, resourceType: "student_profile", resourceId: student.id });
      const serial = `${q.type === "bonafide" ? "BC" : "CC"}-${new Date().getFullYear()}-${student.id.slice(0, 6).toUpperCase()}`;
      return { org, student, type: q.type, purpose: q.purpose ?? null, serial, issuedBy: issuer, issuedOn: new Date().toISOString().slice(0, 10) };
    });
    res.json(data);
  }),
);
