import { Router } from "express";
import { z } from "zod";
import { withTenant } from "../../database/pool.js";
import { notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";

export const curriculumRouter = Router();
curriculumRouter.use(requirePermission("curriculum.read"));

curriculumRouter.get(
  "/boards",
  asyncHandler(async (req, res) => {
    const rows = await withTenant(requireTenant(req).id, (db) => db.query(`SELECT id, name, region FROM boards ORDER BY name`));
    res.json({ boards: rows.rows });
  }),
);

curriculumRouter.get(
  "/grades",
  asyncHandler(async (req, res) => {
    const rows = await withTenant(requireTenant(req).id, (db) => db.query(`SELECT id, name, sequence FROM grades ORDER BY sequence`));
    res.json({ grades: rows.rows });
  }),
);

curriculumRouter.get(
  "/versions",
  asyncHandler(async (req, res) => {
    const rows = await withTenant(requireTenant(req).id, (db) =>
      db.query(
        `SELECT cv.id, b.name AS board, g.name AS grade, cv.academic_year, cv.version, cv.source, cv.approval_status
           FROM curriculum_versions cv JOIN boards b ON b.id = cv.board_id JOIN grades g ON g.id = cv.grade_id
          WHERE cv.approval_status = 'approved' ORDER BY g.sequence`,
      ),
    );
    res.json({ versions: rows.rows });
  }),
);

curriculumRouter.get(
  "/subjects",
  asyncHandler(async (req, res) => {
    const rows = await withTenant(requireTenant(req).id, (db) => db.query(`SELECT id, name, code FROM subjects ORDER BY name`));
    res.json({ subjects: rows.rows });
  }),
);

const chaptersQuery = z.object({ curriculumVersionId: z.string().uuid().optional(), subjectId: z.string().uuid().optional() });

curriculumRouter.get(
  "/chapters",
  asyncHandler(async (req, res) => {
    const q = parse(chaptersQuery, req.query);
    const rows = await withTenant(requireTenant(req).id, async (db) => {
      const cv = q.curriculumVersionId ?? (await resolveStudent(req, db).catch(() => null))?.curriculumVersionId ?? null;
      return db.query(
        `SELECT c.id, c.title, c.sequence, c.subject_id, s.name AS subject, c.exam_weightage, c.weightage_source,
                (SELECT count(*)::int FROM topics t WHERE t.chapter_id = c.id) AS topic_count
           FROM chapters c JOIN subjects s ON s.id = c.subject_id
          WHERE ($1::uuid IS NULL OR c.curriculum_version_id = $1) AND ($2::uuid IS NULL OR c.subject_id = $2)
          ORDER BY s.name, c.sequence`,
        [cv, q.subjectId ?? null],
      );
    });
    res.json({ chapters: rows.rows });
  }),
);

curriculumRouter.get(
  "/topics",
  asyncHandler(async (req, res) => {
    const { chapterId } = parse(z.object({ chapterId: z.string().uuid() }), req.query);
    const rows = await withTenant(requireTenant(req).id, (db) =>
      db.query(
        `SELECT t.id, t.title, t.sequence, t.difficulty, t.estimated_minutes, t.prerequisite_topic_ids,
                (SELECT json_agg(json_build_object('id', l.id, 'title', l.title) ORDER BY l.created_at)
                   FROM lessons l WHERE l.topic_id = t.id AND l.status = 'published') AS lessons
           FROM topics t WHERE t.chapter_id = $1 ORDER BY t.sequence`,
        [chapterId],
      ),
    );
    res.json({ topics: rows.rows });
  }),
);

/**
 * The whole course in one call for the Courses page: subjects, their chapters,
 * topics and published lessons, with the student's lesson progress and latest
 * mastery when the caller is (or looks after) a student.
 */
curriculumRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ curriculumVersionId: z.string().uuid().optional() }), req.query);
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = tenant.studentProfileId ? await resolveStudent(req, db).catch(() => null) : null;
      const versions = (
        await db.query(
          `SELECT cv.id, b.name AS board, g.name AS grade, cv.academic_year FROM curriculum_versions cv
             JOIN boards b ON b.id = cv.board_id JOIN grades g ON g.id = cv.grade_id WHERE cv.approval_status = 'approved' ORDER BY g.sequence, b.name`,
        )
      ).rows;
      const cv = q.curriculumVersionId ?? student?.curriculumVersionId ?? versions[0]?.id ?? null;
      const rows = (
        await db.query(
          `SELECT s.id AS subject_id, s.name AS subject, c.id AS chapter_id, c.title AS chapter, c.sequence AS chapter_seq,
                  t.id AS topic_id, t.title AS topic, t.sequence AS topic_seq, t.difficulty, t.estimated_minutes,
                  (SELECT json_agg(json_build_object('id', l.id, 'title', l.title, 'status', lp.status) ORDER BY l.created_at)
                     FROM lessons l LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.student_id = $2
                    WHERE l.topic_id = t.id AND l.status = 'published') AS lessons,
                  (SELECT m.score FROM topic_mastery_history m WHERE m.topic_id = t.id AND m.student_id = $2 ORDER BY m.created_at DESC LIMIT 1) AS mastery
             FROM chapters c JOIN subjects s ON s.id = c.subject_id LEFT JOIN topics t ON t.chapter_id = c.id
            WHERE ($1::uuid IS NULL OR c.curriculum_version_id = $1)
            ORDER BY s.name, c.sequence, t.sequence`,
          [cv, student?.id ?? null],
        )
      ).rows;
      const subjects: any[] = [];
      for (const r of rows) {
        let sub = subjects.find((x) => x.id === r.subject_id);
        if (!sub) subjects.push((sub = { id: r.subject_id, name: r.subject, chapters: [] }));
        let ch = sub.chapters.find((x: any) => x.id === r.chapter_id);
        if (!ch) sub.chapters.push((ch = { id: r.chapter_id, title: r.chapter, sequence: r.chapter_seq, topics: [] }));
        if (r.topic_id)
          ch.topics.push({
            id: r.topic_id, title: r.topic, sequence: r.topic_seq, difficulty: r.difficulty, estimatedMinutes: r.estimated_minutes,
            lessons: r.lessons ?? [], mastery: r.mastery == null ? null : Number(r.mastery),
          });
      }
      return { versions, curriculumVersionId: cv, tracksProgress: !!student, subjects };
    });
    res.json(data);
  }),
);

export const coursesRouter = Router();

coursesRouter.get(
  "/lessons/:id",
  requirePermission("curriculum.read"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const lesson = (
        await db.query(
          `SELECT l.id, l.title, l.content, l.version, l.topic_id, t.title AS topic, c.id AS chapter_id, c.title AS chapter, s.name AS subject
             FROM lessons l JOIN topics t ON t.id = l.topic_id JOIN chapters c ON c.id = t.chapter_id JOIN subjects s ON s.id = c.subject_id
            WHERE l.id = $1 AND (l.status = 'published' OR $2)`,
          [req.params.id, tenant.permissions.has("content.manage") || tenant.permissions.has("content.review")],
        )
      ).rows[0];
      if (!lesson) throw notFound("Lesson");
      if (tenant.studentProfileId) {
        await db.query(
          `INSERT INTO lesson_progress (tenant_id, student_id, lesson_id) VALUES ($1,$2,$3)
           ON CONFLICT (student_id, lesson_id) DO UPDATE SET last_viewed_at = now()`,
          [tenant.id, tenant.studentProfileId, lesson.id],
        );
      }
      return lesson;
    });
    // Text content is always returned, independent of avatar availability.
    res.json({ lesson: data });
  }),
);

coursesRouter.post(
  "/lessons/:id/complete",
  requirePermission("assessments.take"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    if (!tenant.studentProfileId) throw notFound("Student profile");
    const row = await withTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO lesson_progress (tenant_id, student_id, lesson_id, status, completed_at) VALUES ($1,$2,$3,'completed',now())
         ON CONFLICT (student_id, lesson_id) DO UPDATE SET status = 'completed', completed_at = COALESCE(lesson_progress.completed_at, now())
         RETURNING status, completed_at`,
        [tenant.id, tenant.studentProfileId, req.params.id],
      ),
    );
    res.json({ progress: row.rows[0] });
  }),
);

coursesRouter.get(
  "/continue",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, (req.query.studentId as string) || null);
      const last = await db.query(
        `SELECT l.id, l.title, t.title AS topic, lp.status, lp.last_viewed_at
           FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id JOIN topics t ON t.id = l.topic_id
          WHERE lp.student_id = $1 ORDER BY (lp.status = 'in_progress') DESC, lp.last_viewed_at DESC LIMIT 1`,
        [student.id],
      );
      if (last.rows[0]) return last.rows[0];
      // Nothing started yet: suggest the first published lesson in the student's curriculum.
      const first = await db.query(
        `SELECT l.id, l.title, t.title AS topic, 'not_started' AS status FROM lessons l
           JOIN topics t ON t.id = l.topic_id JOIN chapters c ON c.id = t.chapter_id
          WHERE l.status = 'published' AND ($1::uuid IS NULL OR c.curriculum_version_id = $1)
          ORDER BY c.sequence, t.sequence LIMIT 1`,
        [student.curriculumVersionId],
      );
      return first.rows[0] ?? null;
    });
    res.json({ lesson: data });
  }),
);
