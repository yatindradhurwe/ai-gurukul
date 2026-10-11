import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../../lib/crypto.js";
import { ROLE_NAMES, ROLE_PERMISSIONS } from "../../lib/permissions.js";
import { migrate } from "../migrate.js";
import { pool } from "../pool.js";
import { DIAGNOSTIC_QUESTIONS, PLANS, SCIENCE_CHAPTERS } from "./data.js";

/** Idempotent reference + demo content seed. Safe to run repeatedly. */
export async function seed(log = console.log) {
  await migrate(() => {});
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const [id, perms] of Object.entries(ROLE_PERMISSIONS)) {
      await db.query(`INSERT INTO roles (id, name, permissions) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`, [
        id,
        ROLE_NAMES[id],
        perms,
      ]);
    }
    for (const p of PLANS) {
      await db.query(
        `INSERT INTO plans (code, name, price_paise, billing_period, audience, entitlements) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_paise = EXCLUDED.price_paise, entitlements = EXCLUDED.entitlements`,
        [p.code, p.name, p.price_paise, p.billing_period, p.audience, JSON.stringify(p.entitlements)],
      );
    }

    const existing = await db.query(`SELECT id FROM curriculum_versions LIMIT 1`);
    if (existing.rowCount === 0) {
      const board = (await db.query(`INSERT INTO boards (name, region) VALUES ('CBSE','India') RETURNING id`)).rows[0];
      const grade = (await db.query(`INSERT INTO grades (name, sequence) VALUES ('Class 8', 8) RETURNING id`)).rows[0];
      const science = (await db.query(`INSERT INTO subjects (name, code) VALUES ('Science','SCI') RETURNING id`)).rows[0];
      await db.query(`INSERT INTO subjects (name, code) VALUES ('Mathematics','MATH')`);
      const cv = (
        await db.query(
          `INSERT INTO curriculum_versions (board_id, grade_id, academic_year, version, source, approval_status)
           VALUES ($1,$2,'2026-27',1,'Demo syllabus modelled on the CBSE Class 8 Science chapter structure — verify against the official syllabus before production use','approved')
           RETURNING id`,
          [board.id, grade.id],
        )
      ).rows[0];

      const topicIds = new Map<string, string>();
      let chapterSeq = 0;
      for (const ch of SCIENCE_CHAPTERS) {
        const chapter = (
          await db.query(`INSERT INTO chapters (curriculum_version_id, subject_id, title, sequence) VALUES ($1,$2,$3,$4) RETURNING id`, [
            cv.id,
            science.id,
            ch.title,
            ++chapterSeq,
          ])
        ).rows[0];
        let topicSeq = 0;
        for (const t of ch.topics) {
          const prereqs = (t.prereqs ?? []).map((k) => topicIds.get(k)!);
          const topic = (
            await db.query(
              `INSERT INTO topics (chapter_id, title, sequence, difficulty, estimated_minutes, prerequisite_topic_ids) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [chapter.id, t.title, ++topicSeq, t.difficulty, t.minutes, prereqs],
            )
          ).rows[0];
          topicIds.set(t.key, topic.id);
          const lesson = (
            await db.query(`INSERT INTO lessons (topic_id, title, content, status) VALUES ($1,$2,$3,'published') RETURNING id`, [topic.id, t.title, t.lesson])
          ).rows[0];
          const asset = (
            await db.query(
              `INSERT INTO content_assets (lesson_id, title, type, license_metadata, processing_status, approval_status)
               VALUES ($1,$2,'text',$3,'indexed','approved') RETURNING id`,
              [lesson.id, `${ch.title} — ${t.title} (demo notes)`, JSON.stringify({ source: "AI Gurukul demo content", licence: "original", review: "pending subject-expert review" })],
            )
          ).rows[0];
          for (const [i, para] of t.lesson.split(/\n\s*\n/).entries()) {
            await db.query(`INSERT INTO document_chunks (asset_id, topic_id, chunk_text, page_number) VALUES ($1,$2,$3,$4)`, [asset.id, topic.id, para.trim(), i + 1]);
          }
        }
      }

      const max = DIAGNOSTIC_QUESTIONS.reduce((a, q) => a + q.marks, 0);
      const assessment = (
        await db.query(`INSERT INTO assessments (title, kind, max_marks, status, chapter_id) VALUES ('Class 8 Science — diagnostic quiz','diagnostic',$1,'published',NULL) RETURNING id`, [max])
      ).rows[0];
      for (const [i, q] of DIAGNOSTIC_QUESTIONS.entries()) {
        await db.query(
          `INSERT INTO questions (assessment_id, topic_id, type, prompt, options, answer_key, marks, sequence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [assessment.id, topicIds.get(q.topic), q.type, q.prompt, q.options ? JSON.stringify(q.options) : null, JSON.stringify(q.answer_key), q.marks, i + 1],
        );
      }
      log("seeded demo CBSE Class 8 Science curriculum");
    }

    const adminEmail = process.env.SEED_ADMIN_EMAIL;
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (adminEmail && adminPassword) {
      await db.query(
        `INSERT INTO users (name, email, password_hash, is_platform_admin) VALUES ('Platform Admin',$1,$2,true)
         ON CONFLICT (lower(email)) DO UPDATE SET is_platform_admin = true`,
        [adminEmail.toLowerCase(), await hashPassword(adminPassword)],
      );
      log(`platform admin ensured: ${adminEmail}`);
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
