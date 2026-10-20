import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { STAFF_ROLES } from "../../lib/permissions.js";
import { requirePermission } from "../../middleware/authorization.js";

export const hrRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
const rupees = z.number().min(0).max(100_000_00).transform((r) => Math.round(r * 100));
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Pro-rate a monthly amount by paid days, to the rupee. */
const prorate = (paise: number, ratio: number) => Math.round((paise * ratio) / 100) * 100;

export interface SalaryInput {
  basic: number;
  hra: number;
  da: number;
  other: number;
  pfPercent: number;
  professionalTax: number;
  tds: number;
}

/** Compute a payslip from a salary structure and the paid fraction of the month. */
export function computePayslip(s: SalaryInput, workingDays: number, unpaidDays: number) {
  const ratio = workingDays > 0 ? Math.max(0, workingDays - unpaidDays) / workingDays : 1;
  const earnings = { Basic: prorate(s.basic, ratio), HRA: prorate(s.hra, ratio), DA: prorate(s.da, ratio), "Other allowances": prorate(s.other, ratio) };
  const gross = Object.values(earnings).reduce((t, v) => t + v, 0);
  const deductions = {
    "Provident fund": Math.round((earnings.Basic * s.pfPercent) / 100 / 100) * 100,
    "Professional tax": gross > 0 ? s.professionalTax : 0,
    "Income tax (TDS)": gross > 0 ? s.tds : 0,
  };
  const totalDeductions = Object.values(deductions).reduce((t, v) => t + v, 0);
  return { earnings, deductions, gross, totalDeductions, net: Math.max(0, gross - totalDeductions) };
}

const PROFILE_COLUMNS = `p.id AS profile_id, p.employee_code, p.designation, p.department, p.date_joined, p.phone, p.blood_group, p.bank_account_last4,
  p.basic_paise, p.hra_paise, p.da_paise, p.other_paise, p.pf_percent, p.professional_tax_paise, p.tds_paise, p.status`;

/** Every employee (any staff role) with their HR profile, if set up. */
hrRouter.get(
  "/staff",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT u.id AS user_id, u.name, u.email, array_agg(DISTINCT m.role_id) AS roles, ${PROFILE_COLUMNS},
                (SELECT count(*) FILTER (WHERE a.status = 'present')::int FROM staff_attendance a WHERE a.user_id = u.id AND date_trunc('month', a.date) = date_trunc('month', ${TODAY})) AS present_this_month,
                (SELECT count(*) FILTER (WHERE a.status IN ('absent','half_day'))::int FROM staff_attendance a WHERE a.user_id = u.id AND date_trunc('month', a.date) = date_trunc('month', ${TODAY})) AS absent_this_month
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id = ANY($2::text[])
          GROUP BY u.id, p.id ORDER BY u.name`,
        [tenant.id, STAFF_ROLES],
      ),
    );
    res.json({ staff: rows.rows });
  }),
);

hrRouter.put(
  "/staff/:userId",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        employeeCode: z.string().trim().min(1).max(30),
        designation: z.string().trim().max(80).default(""),
        department: z.string().trim().max(80).default(""),
        dateJoined: date.nullish(),
        phone: z.string().trim().max(20).nullish(),
        bloodGroup: z.string().trim().max(5).nullish(),
        bankAccountLast4: z.string().regex(/^\d{4}$/, "Last 4 digits only").nullish(),
        basic: rupees,
        hra: rupees.default(0),
        da: rupees.default(0),
        other: rupees.default(0),
        pfPercent: z.number().min(0).max(100).default(12),
        professionalTax: rupees.default(200),
        tds: rupees.default(0),
        status: z.enum(["active", "on_leave", "left"]).default("active"),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const member = await db.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role_id = ANY($3::text[])`, [tenant.id, req.params.userId, STAFF_ROLES]);
      if (!member.rowCount) throw notFound("Staff member");
      const dup = await db.query(`SELECT 1 FROM staff_profiles WHERE employee_code = $1 AND user_id <> $2`, [b.employeeCode, req.params.userId]);
      if (dup.rowCount) throw conflict(`Employee code ${b.employeeCode} is already used`);
      const p = (
        await db.query(
          `INSERT INTO staff_profiles (tenant_id, user_id, employee_code, designation, department, date_joined, phone, blood_group, bank_account_last4,
                                       basic_paise, hra_paise, da_paise, other_paise, pf_percent, professional_tax_paise, tds_paise, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, designation = EXCLUDED.designation, department = EXCLUDED.department,
             date_joined = EXCLUDED.date_joined, phone = EXCLUDED.phone, blood_group = EXCLUDED.blood_group, bank_account_last4 = EXCLUDED.bank_account_last4,
             basic_paise = EXCLUDED.basic_paise, hra_paise = EXCLUDED.hra_paise, da_paise = EXCLUDED.da_paise, other_paise = EXCLUDED.other_paise,
             pf_percent = EXCLUDED.pf_percent, professional_tax_paise = EXCLUDED.professional_tax_paise, tds_paise = EXCLUDED.tds_paise, status = EXCLUDED.status
           RETURNING *`,
          [
            tenant.id, req.params.userId, b.employeeCode, b.designation, b.department, b.dateJoined ?? null, b.phone ?? null, b.bloodGroup ?? null, b.bankAccountLast4 ?? null,
            b.basic, b.hra, b.da, b.other, b.pfPercent, b.professionalTax, b.tds, b.status,
          ],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "hr.profile.update", resourceType: "staff_profile", resourceId: p.id });
      return p;
    });
    res.json({ profile: row });
  }),
);

hrRouter.get(
  "/attendance",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ date: date.optional() }), req.query);
    const rows = await withTenant(tenant.id, async (db) => {
      const day = q.date ?? (await db.query(`SELECT ${TODAY}::text AS d`)).rows[0].d;
      const list = await db.query(
        `SELECT u.id AS user_id, u.name, p.designation, a.status
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.tenant_id = m.tenant_id
           LEFT JOIN staff_attendance a ON a.user_id = u.id AND a.date = $3
          WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id = ANY($2::text[]) AND COALESCE(p.status, 'active') <> 'left'
          GROUP BY u.id, p.id, a.status ORDER BY u.name`,
        [tenant.id, STAFF_ROLES, day],
      );
      return { date: day, staff: list.rows };
    });
    res.json(rows);
  }),
);

hrRouter.post(
  "/attendance",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({ date, records: z.array(z.object({ userId: z.string().uuid(), status: z.enum(["present", "absent", "half_day", "leave"]) })).min(1).max(500) }),
      req.body,
    );
    const saved = await withTenant(tenant.id, async (db) => {
      if ((await db.query(`SELECT $1::date > ${TODAY} AS f`, [b.date])).rows[0].f) throw badRequest("Attendance cannot be marked for a future date");
      const staff = new Set(
        (await db.query(`SELECT user_id FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' AND role_id = ANY($2::text[])`, [tenant.id, STAFF_ROLES])).rows.map((r) => r.user_id),
      );
      for (const r of b.records) {
        if (!staff.has(r.userId)) throw badRequest("Every person must be a staff member");
        await db.query(
          `INSERT INTO staff_attendance (tenant_id, user_id, date, status, marked_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, user_id, date) DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, marked_at = now()`,
          [tenant.id, r.userId, b.date, r.status, userId],
        );
      }
      return b.records.length;
    });
    res.json({ saved });
  }),
);

/** Working days in a month: Monday–Saturday, minus holidays on the school calendar. */
async function workingDays(db: Db, m: string) {
  return (
    await db.query(
      `SELECT count(*)::int AS n FROM generate_series(($1 || '-01')::date, (($1 || '-01')::date + interval '1 month' - interval '1 day'), interval '1 day') d
        WHERE extract(isodow FROM d) < 7
          AND NOT EXISTS (SELECT 1 FROM school_events e WHERE e.kind = 'holiday' AND e.audience IN ('all','staff') AND d BETWEEN e.start_date AND e.end_date)`,
      [m],
    )
  ).rows[0].n as number;
}

hrRouter.post(
  "/payroll/generate",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ month }), req.body);
    const result = await withTenant(tenant.id, async (db) => {
      if ((await db.query(`SELECT ($1 || '-01')::date > ${TODAY} AS f`, [b.month])).rows[0].f) throw badRequest("Payroll can't be run for a future month");
      const working = await workingDays(db, b.month);
      const staff = (await db.query(`SELECT * FROM staff_profiles WHERE status <> 'left' AND basic_paise > 0`)).rows;
      let generated = 0;
      let skipped = 0;
      for (const p of staff) {
        const unpaid = Number(
          (
            await db.query(
              `SELECT (SELECT COALESCE(sum(CASE a.status WHEN 'absent' THEN 1 WHEN 'half_day' THEN 0.5 ELSE 0 END), 0) FROM staff_attendance a
                        WHERE a.user_id = $1 AND to_char(a.date, 'YYYY-MM') = $2)
                    + (SELECT count(*) FROM leave_requests l, generate_series(l.start_date, l.end_date, interval '1 day') d
                        WHERE l.kind = 'staff' AND l.staff_id = $1 AND l.status = 'approved' AND l.leave_type = 'unpaid' AND to_char(d, 'YYYY-MM') = $2 AND extract(isodow FROM d) < 7) AS n`,
              [p.user_id, b.month],
            )
          ).rows[0].n,
        );
        const slip = computePayslip(
          { basic: Number(p.basic_paise), hra: Number(p.hra_paise), da: Number(p.da_paise), other: Number(p.other_paise), pfPercent: Number(p.pf_percent), professionalTax: Number(p.professional_tax_paise), tds: Number(p.tds_paise) },
          working,
          Math.min(unpaid, working),
        );
        const r = await db.query(
          `INSERT INTO payslips (tenant_id, user_id, month, working_days, unpaid_days, earnings, deductions, gross_paise, deductions_paise, net_paise, generated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (tenant_id, user_id, month) DO UPDATE SET working_days = EXCLUDED.working_days, unpaid_days = EXCLUDED.unpaid_days, earnings = EXCLUDED.earnings,
             deductions = EXCLUDED.deductions, gross_paise = EXCLUDED.gross_paise, deductions_paise = EXCLUDED.deductions_paise, net_paise = EXCLUDED.net_paise,
             generated_by = EXCLUDED.generated_by, generated_at = now()
             WHERE payslips.status = 'draft'
           RETURNING id`,
          [tenant.id, p.user_id, b.month, working, Math.min(unpaid, working), JSON.stringify(slip.earnings), JSON.stringify(slip.deductions), slip.gross, slip.totalDeductions, slip.net, userId],
        );
        r.rowCount ? generated++ : skipped++;
      }
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "payroll.generate", metadata: { month: b.month, generated, skipped } });
      return { month: b.month, workingDays: working, generated, skippedPaid: skipped };
    });
    res.json(result);
  }),
);

const SLIP_COLUMNS = `s.id, s.user_id, u.name, s.month, s.working_days, s.unpaid_days, s.earnings, s.deductions, s.gross_paise, s.deductions_paise, s.net_paise,
  s.status, s.generated_at, s.paid_at, p.employee_code, p.designation, p.department, p.bank_account_last4, p.date_joined`;
const SLIP_JOINS = `FROM payslips s JOIN users u ON u.id = s.user_id LEFT JOIN staff_profiles p ON p.user_id = s.user_id AND p.tenant_id = s.tenant_id`;

hrRouter.get(
  "/payroll",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ month }), req.query);
    const rows = await withTenant(tenant.id, (db) => db.query(`SELECT ${SLIP_COLUMNS} ${SLIP_JOINS} WHERE s.month = $1 ORDER BY u.name`, [q.month]));
    const slips = rows.rows;
    res.json({
      month: q.month,
      payslips: slips,
      totals: { gross: slips.reduce((t, s) => t + Number(s.gross_paise), 0), net: slips.reduce((t, s) => t + Number(s.net_paise), 0), paid: slips.filter((s) => s.status === "paid").length },
    });
  }),
);

hrRouter.post(
  "/payslips/:id/pay",
  requirePermission("payroll.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`UPDATE payslips SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'draft'`, [req.params.id]);
      if (!r.rowCount) throw notFound("Unpaid payslip");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "payroll.paid", resourceType: "payslip", resourceId: req.params.id });
    });
    res.json({ ok: true });
  }),
);

/** A staff member's own payslips (paid ones only — drafts may still change). */
hrRouter.get(
  "/payslips/mine",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) => db.query(`SELECT ${SLIP_COLUMNS} ${SLIP_JOINS} WHERE s.user_id = $1 AND s.status = 'paid' ORDER BY s.month DESC`, [userId]));
    res.json({ payslips: rows.rows });
  }),
);

hrRouter.get(
  "/payslips/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT ${SLIP_COLUMNS} ${SLIP_JOINS} WHERE s.id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Payslip");
      const manager = tenant.permissions.has("payroll.manage");
      if (!manager && (s.user_id !== userId || s.status !== "paid")) throw forbidden();
      const org = (await db.query(`SELECT name, settings FROM tenants WHERE id = $1`, [tenant.id])).rows[0];
      return { org: { name: org.name, address: org.settings?.address ?? null }, payslip: s };
    });
    res.json(data);
  }),
);
