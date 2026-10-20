import type { Request } from "express";
import type { Db } from "../../database/pool.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { requireAuth, requireTenant } from "../../lib/http.js";

/** Organization-wide staff (admins, owners) can manage every class, not only their own. */
export const isOrgAdmin = (req: Request) => {
  const t = requireTenant(req);
  return t.permissions.has("members.manage") || t.permissions.has("tenant.manage");
};

export interface ClassAccess {
  cls: { id: string; name: string; teacher_id: string };
  /** The caller teaches this class or administers the organization. */
  staff: boolean;
}

/**
 * Load a class the caller may see: its teacher, an org admin with classes.manage,
 * an enrolled student, or a parent of an enrolled child.
 */
export async function loadClass(req: Request, db: Db, classId: string, opts: { manage?: boolean } = {}): Promise<ClassAccess> {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const cls = (await db.query(`SELECT id, name, teacher_id FROM classes WHERE id = $1`, [classId])).rows[0];
  if (!cls) throw notFound("Class");
  const staff = tenant.permissions.has("classes.manage") && (cls.teacher_id === userId || isOrgAdmin(req));
  if (staff) return { cls, staff };
  if (opts.manage) throw forbidden("Only this class's teacher or an admin can do that");
  const visible = await db.query(
    `SELECT 1 FROM class_enrollments e
      WHERE e.class_id = $1 AND (e.student_id = $2 OR e.student_id IN (
        SELECT student_id FROM parent_student_links WHERE parent_id = $3 AND consent_status = 'granted'))`,
    [classId, tenant.studentProfileId, userId],
  );
  if (!visible.rowCount) throw forbidden("You are not part of this class");
  return { cls, staff };
}

/**
 * SQL fragment (and params) selecting the class ids visible to the caller.
 * `p` is the index of the first placeholder to use.
 */
export function visibleClassesSql(req: Request, p: number): { sql: string; params: unknown[] } {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  return {
    sql: `SELECT c.id FROM classes c
           WHERE ($${p}::boolean AND ($${p + 1}::boolean OR c.teacher_id = $${p + 2}))
              OR EXISTS (SELECT 1 FROM class_enrollments e WHERE e.class_id = c.id AND (e.student_id = $${p + 3}
                         OR e.student_id IN (SELECT student_id FROM parent_student_links WHERE parent_id = $${p + 2} AND consent_status = 'granted')))`,
    params: [tenant.permissions.has("classes.manage"), isOrgAdmin(req), userId, tenant.studentProfileId],
  };
}

/** Students enrolled in a class, by name. */
export async function roster(db: Db, classId: string) {
  return (
    await db.query(
      `SELECT sp.id AS student_id, u.name, u.email FROM class_enrollments e
         JOIN student_profiles sp ON sp.id = e.student_id JOIN users u ON u.id = sp.user_id
        WHERE e.class_id = $1 ORDER BY u.name`,
      [classId],
    )
  ).rows as { student_id: string; name: string; email: string }[];
}

/** CBSE-style grade band for a percentage. */
export function gradeFor(percent: number | null): string | null {
  if (percent == null) return null;
  if (percent >= 91) return "A1";
  if (percent >= 81) return "A2";
  if (percent >= 71) return "B1";
  if (percent >= 61) return "B2";
  if (percent >= 51) return "C1";
  if (percent >= 41) return "C2";
  if (percent >= 33) return "D";
  return "E";
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
