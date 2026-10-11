import type { Request } from "express";
import type { Db } from "../database/pool.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { requireAuth, requireTenant } from "./http.js";

export interface StudentRef {
  id: string; // student_profiles.id
  userId: string;
  name: string;
  curriculumVersionId: string | null;
  dailyStudyMinutes: number;
  weekdayMinutes: Record<string, number>;
  timezone: string;
  language: string;
  access: "self" | "parent" | "staff";
}

/**
 * Decide whose academic records this request may touch:
 * - a student acts on their own profile;
 * - a parent only on children linked to them with consent granted;
 * - teachers/admins (planner.manage_students / reports.class) on students in their tenant.
 * RLS additionally confines every lookup to the current tenant.
 */
export async function resolveStudent(req: Request, db: Db, requestedId?: string | null): Promise<StudentRef> {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const targetId = requestedId || tenant.studentProfileId;
  if (!targetId) throw badRequest("studentId is required");

  const row = (
    await db.query(
      `SELECT sp.id, sp.user_id, u.name, sp.curriculum_version_id, sp.daily_study_minutes, sp.weekday_minutes, sp.timezone, sp.language
         FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`,
      [targetId],
    )
  ).rows[0];
  if (!row) throw notFound("Student");

  const base = {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    curriculumVersionId: row.curriculum_version_id,
    dailyStudyMinutes: row.daily_study_minutes,
    weekdayMinutes: row.weekday_minutes ?? {},
    timezone: row.timezone,
    language: row.language,
  };
  if (row.user_id === userId) return { ...base, access: "self" };

  if (tenant.permissions.has("reports.children")) {
    const link = await db.query(
      `SELECT 1 FROM parent_student_links WHERE parent_id = $1 AND student_id = $2 AND consent_status = 'granted'`,
      [userId, row.id],
    );
    if (link.rowCount) return { ...base, access: "parent" };
  }
  if (tenant.permissions.has("planner.manage_students") || tenant.permissions.has("reports.class")) {
    return { ...base, access: "staff" };
  }
  throw forbidden("You are not authorized to access this student's records");
}
