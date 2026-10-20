import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";

export const feesRouter = Router();

const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
/** Amounts arrive in rupees (up to 2 decimals) and are stored as integer paise. */
const rupees = z.number().positive().max(10_000_000).transform((r) => Math.round(r * 100));
const CATEGORIES = ["tuition", "admission", "transport", "exam", "library", "activity", "hostel", "other"] as const;
const METHODS = ["cash", "upi", "card", "cheque", "bank_transfer", "online"] as const;

/** Invoice columns plus paid / balance / state, computed from payments. `i` must alias fee_invoices. */
export const INVOICE_COLUMNS = `
  i.id, i.student_id, i.structure_id, i.title, i.amount_paise, i.discount_paise, i.discount_note, i.due_date, i.status, i.created_at,
  COALESCE((SELECT sum(p.amount_paise) FROM fee_payments p WHERE p.invoice_id = i.id), 0)::bigint AS paid_paise,
  (i.amount_paise - i.discount_paise - COALESCE((SELECT sum(p.amount_paise) FROM fee_payments p WHERE p.invoice_id = i.id), 0))::bigint AS balance_paise`;

export const INVOICE_STATE = `CASE
  WHEN i.status = 'cancelled' THEN 'cancelled'
  WHEN i.amount_paise - i.discount_paise - COALESCE((SELECT sum(p.amount_paise) FROM fee_payments p WHERE p.invoice_id = i.id), 0) <= 0 THEN 'paid'
  WHEN i.due_date < ${TODAY} THEN 'overdue'
  WHEN EXISTS (SELECT 1 FROM fee_payments p WHERE p.invoice_id = i.id) THEN 'partial'
  ELSE 'due' END`;

/** Bill a structure to every matching student who hasn't been billed yet. Returns how many invoices were created. */
async function billStructure(db: Db, tenantId: string, s: { id: string; name: string; amount_paise: number; due_date: string; class_id: string | null }) {
  const r = await db.query(
    `INSERT INTO fee_invoices (tenant_id, student_id, structure_id, title, amount_paise, due_date)
     SELECT $1, sp.id, $2, $3, $4, $5 FROM student_profiles sp
      WHERE sp.tenant_id = $1
        AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = $1 AND m.user_id = sp.user_id AND m.role_id = 'student' AND m.status = 'active')
        AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM class_enrollments e WHERE e.class_id = $6 AND e.student_id = sp.id))
     ON CONFLICT (structure_id, student_id) DO NOTHING`,
    [tenantId, s.id, s.name, s.amount_paise, s.due_date, s.class_id],
  );
  return r.rowCount ?? 0;
}

feesRouter.get(
  "/summary",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const totals = (
        await db.query(
          `SELECT COALESCE(sum(amount_paise - discount_paise), 0)::bigint AS billed,
                  COALESCE(sum(paid_paise), 0)::bigint AS collected,
                  COALESCE(sum(GREATEST(balance_paise, 0)), 0)::bigint AS outstanding,
                  COALESCE(sum(GREATEST(balance_paise, 0)) FILTER (WHERE state = 'overdue'), 0)::bigint AS overdue,
                  count(*) FILTER (WHERE state = 'overdue')::int AS overdue_count,
                  count(DISTINCT student_id) FILTER (WHERE state = 'overdue')::int AS overdue_students
             FROM (SELECT ${INVOICE_COLUMNS}, ${INVOICE_STATE} AS state FROM fee_invoices i WHERE i.status = 'open') x`,
        )
      ).rows[0];
      const month = (
        await db.query(`SELECT COALESCE(sum(amount_paise), 0)::bigint AS n FROM fee_payments WHERE paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')`)
      ).rows[0].n;
      const byMethod = await db.query(`SELECT method, sum(amount_paise)::bigint AS amount, count(*)::int AS payments FROM fee_payments GROUP BY method ORDER BY amount DESC`);
      const recent = await db.query(
        `SELECT p.id, p.receipt_no, p.amount_paise, p.method, p.paid_at, i.title, u.name AS student
           FROM fee_payments p JOIN fee_invoices i ON i.id = p.invoice_id JOIN student_profiles sp ON sp.id = i.student_id JOIN users u ON u.id = sp.user_id
          ORDER BY p.paid_at DESC LIMIT 8`,
      );
      return { totals: { ...totals, collectedThisMonth: month }, byMethod: byMethod.rows, recent: recent.rows };
    });
    res.json(data);
  }),
);

feesRouter.get(
  "/structures",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT s.*, c.name AS class_name,
                (SELECT count(*)::int FROM fee_invoices i WHERE i.structure_id = s.id AND i.status = 'open') AS invoices,
                (SELECT COALESCE(sum(p.amount_paise), 0)::bigint FROM fee_payments p JOIN fee_invoices i ON i.id = p.invoice_id WHERE i.structure_id = s.id) AS collected_paise,
                (SELECT COALESCE(sum(i.amount_paise - i.discount_paise), 0)::bigint FROM fee_invoices i WHERE i.structure_id = s.id AND i.status = 'open') AS billed_paise
           FROM fee_structures s LEFT JOIN classes c ON c.id = s.class_id
          ORDER BY s.due_date DESC, s.created_at DESC`,
      ),
    );
    res.json({ structures: rows.rows });
  }),
);

feesRouter.post(
  "/structures",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(160), category: z.enum(CATEGORIES).default("tuition"), amount: rupees, dueDate: date, classId: z.string().uuid().nullish() }),
      req.body,
    );
    const data = await withTenant(tenant.id, async (db) => {
      if (body.classId) {
        const c = await db.query(`SELECT 1 FROM classes WHERE id = $1`, [body.classId]);
        if (!c.rowCount) throw notFound("Class");
      }
      const s = (
        await db.query(
          `INSERT INTO fee_structures (tenant_id, name, category, amount_paise, due_date, class_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, body.name, body.category, body.amount, body.dueDate, body.classId ?? null, userId],
        )
      ).rows[0];
      const billed = await billStructure(db, tenant.id, s);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "fees.structure.create", resourceType: "fee_structure", resourceId: s.id, metadata: { billed } });
      return { structure: s, billed };
    });
    res.status(201).json(data);
  }),
);

/** Bill students who joined after the structure was created. */
feesRouter.post(
  "/structures/:id/apply",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const billed = await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT * FROM fee_structures WHERE id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Fee structure");
      return billStructure(db, tenant.id, s);
    });
    res.json({ billed });
  }),
);

feesRouter.delete(
  "/structures/:id",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT id FROM fee_structures WHERE id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Fee structure");
      const paid = await db.query(`SELECT 1 FROM fee_payments p JOIN fee_invoices i ON i.id = p.invoice_id WHERE i.structure_id = $1 LIMIT 1`, [s.id]);
      if (paid.rowCount) throw conflict("Payments have been received against this fee; cancel individual invoices instead");
      await db.query(`DELETE FROM fee_structures WHERE id = $1`, [s.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "fees.structure.delete", resourceType: "fee_structure", resourceId: s.id });
    });
    res.json({ ok: true });
  }),
);

/** Classes a fee can be billed to (the fees office may not otherwise see classes). */
feesRouter.get(
  "/classes",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(`SELECT c.id, c.name, (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students FROM classes c ORDER BY c.name`),
    );
    res.json({ classes: rows.rows });
  }),
);

/** Students who can be billed, with their classes. */
feesRouter.get(
  "/students",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT sp.id AS student_id, u.name, u.email,
                (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = sp.id) AS classes
           FROM student_profiles sp JOIN users u ON u.id = sp.user_id
          WHERE EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = sp.tenant_id AND m.user_id = sp.user_id AND m.role_id = 'student' AND m.status = 'active')
          ORDER BY u.name`,
      ),
    );
    res.json({ students: rows.rows });
  }),
);

feesRouter.get(
  "/invoices",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(
      z.object({
        state: z.enum(["due", "partial", "overdue", "paid", "cancelled", "unpaid"]).optional(),
        studentId: z.string().uuid().optional(),
        structureId: z.string().uuid().optional(),
        search: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT * FROM (
           SELECT ${INVOICE_COLUMNS}, ${INVOICE_STATE} AS state, u.name AS student, u.email,
                  (SELECT string_agg(c.name, ', ') FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = i.student_id) AS classes
             FROM fee_invoices i JOIN student_profiles sp ON sp.id = i.student_id JOIN users u ON u.id = sp.user_id
            WHERE ($1::uuid IS NULL OR i.student_id = $1) AND ($2::uuid IS NULL OR i.structure_id = $2)
              AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%' OR u.email ILIKE '%' || $3 || '%')
         ) x
         WHERE ($4::text IS NULL OR x.state = $4 OR ($4 = 'unpaid' AND x.state IN ('due','partial','overdue')))
         ORDER BY (x.state = 'overdue') DESC, x.due_date, x.student
         LIMIT 1000`,
        [q.studentId ?? null, q.structureId ?? null, q.search || null, q.state ?? null],
      ),
    );
    res.json({ invoices: rows.rows });
  }),
);

feesRouter.post(
  "/invoices",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(z.object({ studentId: z.string().uuid(), title: z.string().trim().min(1).max(160), amount: rupees, dueDate: date }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const sp = await db.query(`SELECT 1 FROM student_profiles WHERE id = $1`, [body.studentId]);
      if (!sp.rowCount) throw notFound("Student");
      const i = (
        await db.query(`INSERT INTO fee_invoices (tenant_id, student_id, title, amount_paise, due_date) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
          tenant.id,
          body.studentId,
          body.title,
          body.amount,
          body.dueDate,
        ])
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "fees.invoice.create", resourceType: "fee_invoice", resourceId: i.id });
      return i;
    });
    res.status(201).json({ invoice: row });
  }),
);

/** Concession / discount, or cancel an invoice that has no payments. */
feesRouter.patch(
  "/invoices/:id",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        discount: z.number().min(0).max(10_000_000).transform((r) => Math.round(r * 100)).optional(),
        discountNote: z.string().trim().max(300).nullish(),
        status: z.enum(["open", "cancelled"]).optional(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const i = (await db.query(`SELECT ${INVOICE_COLUMNS} FROM fee_invoices i WHERE i.id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!i) throw notFound("Invoice");
      if (body.status === "cancelled" && Number(i.paid_paise) > 0) throw conflict("This invoice has payments and cannot be cancelled");
      if (body.discount !== undefined && body.discount > Number(i.amount_paise) - Number(i.paid_paise)) throw badRequest("The concession is larger than the unpaid amount");
      const u = (
        await db.query(
          `UPDATE fee_invoices SET discount_paise = COALESCE($2, discount_paise), discount_note = CASE WHEN $4 THEN $3 ELSE discount_note END, status = COALESCE($5, status)
            WHERE id = $1 RETURNING *`,
          [i.id, body.discount ?? null, body.discountNote ?? null, body.discountNote !== undefined, body.status ?? null],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "fees.invoice.update", resourceType: "fee_invoice", resourceId: i.id, metadata: body });
      return u;
    });
    res.json({ invoice: row });
  }),
);

feesRouter.post(
  "/invoices/:id/payments",
  requirePermission("fees.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({ amount: rupees, method: z.enum(METHODS), reference: z.string().trim().max(120).nullish(), paidAt: z.string().datetime({ offset: true }).nullish() }),
      req.body,
    );
    const payment = await withTenant(tenant.id, async (db) => {
      // Serialise payments per tenant so receipt numbers are gap-free and an invoice can't be overpaid concurrently.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':fee-receipts'))`, [tenant.id]);
      const i = (await db.query(`SELECT ${INVOICE_COLUMNS} FROM fee_invoices i WHERE i.id = $1`, [req.params.id])).rows[0];
      if (!i) throw notFound("Invoice");
      if (i.status === "cancelled") throw conflict("This invoice is cancelled");
      if (body.amount > Number(i.balance_paise)) throw badRequest(`Payment is more than the balance due (₹${(Number(i.balance_paise) / 100).toFixed(2)})`);
      const year = new Date().getFullYear();
      const seq = (await db.query(`SELECT count(*)::int + 1 AS n FROM fee_payments WHERE receipt_no LIKE $1`, [`RCPT-${year}-%`])).rows[0].n;
      const receiptNo = `RCPT-${year}-${String(seq).padStart(5, "0")}`;
      const p = (
        await db.query(
          `INSERT INTO fee_payments (tenant_id, invoice_id, amount_paise, method, reference, receipt_no, paid_at, received_by)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8) RETURNING *`,
          [tenant.id, i.id, body.amount, body.method, body.reference ?? null, receiptNo, body.paidAt ?? null, userId],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "fees.payment", resourceType: "fee_payment", resourceId: p.id, metadata: { amount: body.amount, receiptNo } });
      return p;
    });
    res.status(201).json({ payment });
  }),
);

/** May the caller see this student's fee records? Fee staff always; otherwise the student or a consented parent. */
async function assertFeeAccess(req: Request, db: Db, studentId: string) {
  if (requireTenant(req).permissions.has("fees.manage")) return;
  const s = await resolveStudent(req, db, studentId);
  if (s.access === "staff") throw forbidden("Fee records are visible to the fees office, the student and their parents");
}

/** A student's own fees (or a parent's child): invoices with payments. */
feesRouter.get(
  "/student",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const targetId = q.studentId ?? tenant.studentProfileId;
      if (!targetId) throw badRequest("studentId is required");
      await assertFeeAccess(req, db, targetId);
      const student = (await db.query(`SELECT sp.id, u.name FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [targetId])).rows[0];
      if (!student) throw notFound("Student");
      const invoices = await db.query(
        `SELECT ${INVOICE_COLUMNS}, ${INVOICE_STATE} AS state FROM fee_invoices i WHERE i.student_id = $1 AND i.status = 'open' ORDER BY i.due_date`,
        [targetId],
      );
      const payments = await db.query(
        `SELECT p.id, p.invoice_id, p.receipt_no, p.amount_paise, p.method, p.reference, p.paid_at
           FROM fee_payments p JOIN fee_invoices i ON i.id = p.invoice_id WHERE i.student_id = $1 ORDER BY p.paid_at DESC`,
        [targetId],
      );
      const due = invoices.rows.reduce((t, i) => t + Math.max(0, Number(i.balance_paise)), 0);
      const overdue = invoices.rows.filter((i) => i.state === "overdue").reduce((t, i) => t + Number(i.balance_paise), 0);
      const paid = payments.rows.reduce((t, p) => t + Number(p.amount_paise), 0);
      return { student, totals: { due_paise: due, overdue_paise: overdue, paid_paise: paid }, invoices: invoices.rows, payments: payments.rows };
    });
    res.json(data);
  }),
);

feesRouter.get(
  "/receipts/:paymentId",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const p = (
        await db.query(
          `SELECT p.*, r.name AS received_by_name FROM fee_payments p JOIN users r ON r.id = p.received_by WHERE p.id = $1`,
          [req.params.paymentId],
        )
      ).rows[0];
      if (!p) throw notFound("Receipt");
      const i = (await db.query(`SELECT ${INVOICE_COLUMNS} FROM fee_invoices i WHERE i.id = $1`, [p.invoice_id])).rows[0];
      await assertFeeAccess(req, db, i.student_id);
      const student = (
        await db.query(
          `SELECT u.name, u.email, (SELECT string_agg(c.name, ', ') FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = sp.id) AS classes
             FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`,
          [i.student_id],
        )
      ).rows[0];
      const org = (await db.query(`SELECT name, settings FROM tenants WHERE id = $1`, [tenant.id])).rows[0];
      return {
        organization: { name: org.name, supportEmail: org.settings?.supportEmail ?? null, supportPhone: org.settings?.supportPhone ?? null },
        receipt: { id: p.id, receipt_no: p.receipt_no, amount_paise: p.amount_paise, method: p.method, reference: p.reference, paid_at: p.paid_at, received_by: p.received_by_name },
        invoice: { id: i.id, title: i.title, amount_paise: i.amount_paise, discount_paise: i.discount_paise, paid_paise: i.paid_paise, balance_paise: i.balance_paise, due_date: i.due_date },
        student,
      };
    });
    res.json(data);
  }),
);
