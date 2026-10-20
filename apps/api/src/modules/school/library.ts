import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";

export const libraryRouter = Router();

export const LOAN_DAYS = 14;
export const MAX_ACTIVE_LOANS = 5;
/** Late fine per day, in paise (₹2). */
export const FINE_PER_DAY_PAISE = 200;

const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const LOAN_COLUMNS = `l.id, l.book_id, b.title, b.author, l.user_id, u.name AS borrower, l.issued_at, l.due_date, l.returned_at, l.fine_paise, l.fine_paid,
  GREATEST(0, ${TODAY} - l.due_date)::int AS days_overdue,
  CASE WHEN l.returned_at IS NOT NULL THEN 'returned' WHEN l.due_date < ${TODAY} THEN 'overdue' ELSE 'active' END AS state,
  CASE WHEN l.returned_at IS NULL THEN GREATEST(0, ${TODAY} - l.due_date) * ${FINE_PER_DAY_PAISE} ELSE l.fine_paise END::bigint AS fine_due_paise`;

const bookSchema = z.object({
  title: z.string().trim().min(1).max(250),
  author: z.string().trim().max(200).default(""),
  isbn: z.string().trim().max(20).nullish(),
  category: z.string().trim().min(1).max(60).default("General"),
  publisher: z.string().trim().max(120).nullish(),
  shelf: z.string().trim().max(40).nullish(),
  copies: z.number().int().min(0).max(10000).default(1),
});

/** Catalogue, open to every member. */
libraryRouter.get(
  "/books",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ search: z.string().trim().max(100).optional(), category: z.string().trim().max(60).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const books = await db.query(
        `SELECT b.*, b.total_copies - (SELECT count(*)::int FROM library_loans l WHERE l.book_id = b.id AND l.returned_at IS NULL) AS available,
                EXISTS (SELECT 1 FROM library_loans l WHERE l.book_id = b.id AND l.user_id = $3 AND l.returned_at IS NULL) AS with_me
           FROM library_books b
          WHERE ($1::text IS NULL OR b.title ILIKE '%' || $1 || '%' OR b.author ILIKE '%' || $1 || '%' OR b.isbn = $1)
            AND ($2::text IS NULL OR b.category = $2)
          ORDER BY b.title LIMIT 500`,
        [q.search || null, q.category || null, userId],
      );
      const categories = (await db.query(`SELECT category, count(*)::int AS n FROM library_books GROUP BY category ORDER BY category`)).rows;
      return { books: books.rows, categories };
    });
    res.json(data);
  }),
);

libraryRouter.post(
  "/books",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(bookSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if (body.isbn) {
        const dup = await db.query(`SELECT title FROM library_books WHERE isbn = $1`, [body.isbn]);
        if (dup.rowCount) throw conflict(`ISBN ${body.isbn} is already in the catalogue (${dup.rows[0].title}); add copies to it instead`);
      }
      return (
        await db.query(
          `INSERT INTO library_books (tenant_id, title, author, isbn, category, publisher, shelf, total_copies) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [tenant.id, body.title, body.author, body.isbn ?? null, body.category, body.publisher ?? null, body.shelf ?? null, body.copies],
        )
      ).rows[0];
    });
    res.status(201).json({ book: row });
  }),
);

libraryRouter.patch(
  "/books/:id",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(bookSchema.partial(), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const b = (await db.query(`SELECT * FROM library_books WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b) throw notFound("Book");
      if (body.copies !== undefined) {
        const out = (await db.query(`SELECT count(*)::int AS n FROM library_loans WHERE book_id = $1 AND returned_at IS NULL`, [b.id])).rows[0].n;
        if (body.copies < out) throw badRequest(`${out} copies are on loan; the total can't be less than that`);
      }
      return (
        await db.query(
          `UPDATE library_books SET title = COALESCE($2, title), author = COALESCE($3, author), isbn = COALESCE($4, isbn), category = COALESCE($5, category),
                  publisher = COALESCE($6, publisher), shelf = COALESCE($7, shelf), total_copies = COALESCE($8, total_copies) WHERE id = $1 RETURNING *`,
          [b.id, body.title ?? null, body.author ?? null, body.isbn ?? null, body.category ?? null, body.publisher ?? null, body.shelf ?? null, body.copies ?? null],
        )
      ).rows[0];
    });
    res.json({ book: row });
  }),
);

libraryRouter.delete(
  "/books/:id",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const out = await db.query(`SELECT 1 FROM library_loans WHERE book_id = $1 AND returned_at IS NULL LIMIT 1`, [req.params.id]);
      if (out.rowCount) throw conflict("Copies of this book are on loan");
      const r = await db.query(`DELETE FROM library_books WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Book");
    });
    res.json({ ok: true });
  }),
);

libraryRouter.get(
  "/summary",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const row = await withTenant(tenant.id, async (db) =>
      (
        await db.query(
          `SELECT (SELECT count(*)::int FROM library_books) AS titles,
                  (SELECT COALESCE(sum(total_copies), 0)::int FROM library_books) AS copies,
                  (SELECT count(*)::int FROM library_loans WHERE returned_at IS NULL) AS on_loan,
                  (SELECT count(*)::int FROM library_loans WHERE returned_at IS NULL AND due_date < ${TODAY}) AS overdue,
                  (SELECT COALESCE(sum(fine_paise), 0)::bigint FROM library_loans WHERE returned_at IS NOT NULL AND NOT fine_paid) AS fines_unpaid_paise`,
        )
      ).rows[0],
    );
    res.json({ summary: row, rules: { loanDays: LOAN_DAYS, maxActiveLoans: MAX_ACTIVE_LOANS, finePerDayPaise: FINE_PER_DAY_PAISE } });
  }),
);

/** Members who can borrow: everyone active in the organization. */
libraryRouter.get(
  "/members",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT u.id, u.name, u.email, array_agg(DISTINCT m.role_id) AS roles,
                (SELECT count(*)::int FROM library_loans l WHERE l.user_id = u.id AND l.returned_at IS NULL) AS active_loans
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id <> 'parent'
          GROUP BY u.id ORDER BY u.name`,
        [tenant.id],
      ),
    );
    res.json({ members: rows.rows });
  }),
);

libraryRouter.get(
  "/loans",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ state: z.enum(["active", "overdue", "returned", "out"]).optional(), userId: z.string().uuid().optional() }), req.query);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT * FROM (
           SELECT ${LOAN_COLUMNS} FROM library_loans l JOIN library_books b ON b.id = l.book_id JOIN users u ON u.id = l.user_id
            WHERE ($1::uuid IS NULL OR l.user_id = $1)
         ) x WHERE $2::text IS NULL OR x.state = $2 OR ($2 = 'out' AND x.state IN ('active','overdue'))
         ORDER BY (x.state = 'overdue') DESC, x.returned_at DESC NULLS FIRST, x.due_date
         LIMIT 500`,
        [q.userId ?? null, q.state ?? null],
      ),
    );
    res.json({ loans: rows.rows });
  }),
);

libraryRouter.post(
  "/loans",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({ bookId: z.string().uuid(), userId: z.string().uuid(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }),
      req.body,
    );
    const loan = await withTenant(tenant.id, async (db) => {
      if (body.dueDate && (await db.query(`SELECT $1::date < ${TODAY} AS past`, [body.dueDate])).rows[0].past) throw badRequest("The due date is in the past");
      const b = (await db.query(`SELECT * FROM library_books WHERE id = $1 FOR UPDATE`, [body.bookId])).rows[0];
      if (!b) throw notFound("Book");
      const out = (await db.query(`SELECT count(*)::int AS n FROM library_loans WHERE book_id = $1 AND returned_at IS NULL`, [b.id])).rows[0].n;
      if (out >= b.total_copies) throw conflict("No copies of this book are available");
      const member = await db.query(
        `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role_id <> 'parent'`,
        [tenant.id, body.userId],
      );
      if (!member.rowCount) throw badRequest("The borrower is not a member of this organization");
      const mine = (await db.query(`SELECT count(*)::int AS n, bool_or(book_id = $2) AS has FROM library_loans WHERE user_id = $1 AND returned_at IS NULL`, [body.userId, b.id])).rows[0];
      if (mine.has) throw conflict("This member already has a copy of this book");
      if (mine.n >= MAX_ACTIVE_LOANS) throw conflict(`This member already has ${MAX_ACTIVE_LOANS} books; return one first`);
      const l = (
        await db.query(
          `INSERT INTO library_loans (tenant_id, book_id, user_id, due_date, issued_by)
           VALUES ($1,$2,$3,COALESCE($4::date, ${TODAY} + $5::int),$6) RETURNING *`,
          [tenant.id, b.id, body.userId, body.dueDate ?? null, LOAN_DAYS, userId],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "library.issue", resourceType: "library_loan", resourceId: l.id });
      return l;
    });
    res.status(201).json({ loan });
  }),
);

libraryRouter.post(
  "/loans/:id/return",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(z.object({ waiveFine: z.boolean().default(false), finePaid: z.boolean().default(false) }), req.body ?? {});
    const loan = await withTenant(tenant.id, async (db) => {
      const l = (
        await db.query(`SELECT id, returned_at, GREATEST(0, ${TODAY} - due_date)::int AS late FROM library_loans WHERE id = $1 FOR UPDATE`, [req.params.id])
      ).rows[0];
      if (!l) throw notFound("Loan");
      if (l.returned_at) throw conflict("This book has already been returned");
      const fine = body.waiveFine ? 0 : l.late * FINE_PER_DAY_PAISE;
      const r = (
        await db.query(`UPDATE library_loans SET returned_at = now(), returned_to = $2, fine_paise = $3, fine_paid = $4 WHERE id = $1 RETURNING *`, [
          l.id,
          userId,
          fine,
          fine === 0 || body.finePaid,
        ])
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "library.return", resourceType: "library_loan", resourceId: l.id, metadata: { fine, waived: body.waiveFine } });
      return r;
    });
    res.json({ loan });
  }),
);

libraryRouter.post(
  "/loans/:id/renew",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const loan = await withTenant(tenant.id, async (db) => {
      const l = (await db.query(`SELECT * FROM library_loans WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!l) throw notFound("Loan");
      if (l.returned_at) throw conflict("This book has already been returned");
      return (
        await db.query(`UPDATE library_loans SET due_date = GREATEST(due_date, ${TODAY}) + $2::int WHERE id = $1 RETURNING *`, [l.id, LOAN_DAYS])
      ).rows[0];
    });
    res.json({ loan });
  }),
);

libraryRouter.post(
  "/loans/:id/fine-paid",
  requirePermission("library.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`UPDATE library_loans SET fine_paid = true WHERE id = $1 AND returned_at IS NOT NULL`, [req.params.id]);
      if (!r.rowCount) throw notFound("Returned loan");
    });
    res.json({ ok: true });
  }),
);

/** The caller's own loans; parents pass studentId to see a child's. */
libraryRouter.get(
  "/my",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const borrower = q.studentId ? (await resolveStudent(req, db, q.studentId)).userId : userId;
      const loans = await db.query(
        `SELECT ${LOAN_COLUMNS} FROM library_loans l JOIN library_books b ON b.id = l.book_id JOIN users u ON u.id = l.user_id
          WHERE l.user_id = $1 ORDER BY l.returned_at DESC NULLS FIRST, l.due_date LIMIT 100`,
        [borrower],
      );
      return { loans: loans.rows, rules: { loanDays: LOAN_DAYS, maxActiveLoans: MAX_ACTIVE_LOANS, finePerDayPaise: FINE_PER_DAY_PAISE } };
    });
    res.json(data);
  }),
);
