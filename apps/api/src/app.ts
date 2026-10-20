import cors from "cors";
import express from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import { pool } from "./database/pool.js";
import { authenticate, requireAuthentication } from "./middleware/authentication.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { resolveTenant } from "./middleware/tenant-context.js";
import { academicRouter } from "./modules/academic-planner/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { aiRouter } from "./modules/ai-tutor/routes.js";
import { assessmentsRouter, attemptsRouter } from "./modules/assessments/routes.js";
import { authRouter } from "./modules/auth/routes.js";
import { avatarRouter } from "./modules/avatar/routes.js";
import { billingRouter, billingWebhookRouter } from "./modules/billing/routes.js";
import { contentRouter } from "./modules/content/routes.js";
import { coursesRouter, curriculumRouter } from "./modules/curriculum/routes.js";
import { classesRouter, liveRouter } from "./modules/live/routes.js";
import { announcementsRouter } from "./modules/lms/announcements.js";
import { assignmentsRouter } from "./modules/lms/assignments.js";
import { attendanceRouter } from "./modules/lms/attendance.js";
import { dashboardRouter } from "./modules/lms/dashboard.js";
import { gradebookRouter } from "./modules/lms/gradebook.js";
import { timetableRouter } from "./modules/lms/timetable.js";
import { examsRouter } from "./modules/school/exams.js";
import { feesRouter } from "./modules/school/fees.js";
import { libraryRouter } from "./modules/school/library.js";
import { parentsRouter } from "./modules/parents/routes.js";
import { tenantsRouter } from "./modules/tenants/routes.js";
import { usageRouter } from "./modules/usage/routes.js";
import "./types.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true }));

  // Webhooks need the raw body for signature verification: mount before express.json().
  app.use("/api/v1/billing/webhooks", billingWebhookRouter);
  app.use(express.json({ limit: "1mb" }));
  app.use(authenticate);
  app.use("/api/v1", rateLimit({ name: "api", windowMs: 60_000, max: 300 }));

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  const tenantScoped = [requireAuthentication, resolveTenant];
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/tenants", tenantsRouter);
  app.use("/api/v1/billing", billingRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/curriculum", tenantScoped, curriculumRouter);
  app.use("/api/v1/courses", tenantScoped, coursesRouter);
  app.use("/api/v1/content", tenantScoped, contentRouter);
  app.use("/api/v1/ai", tenantScoped, aiRouter);
  app.use("/api/v1/avatar", tenantScoped, avatarRouter);
  app.use("/api/v1/assessments", tenantScoped, assessmentsRouter);
  app.use("/api/v1/attempts", tenantScoped, attemptsRouter);
  app.use("/api/v1/academic", tenantScoped, academicRouter);
  app.use("/api/v1/parents", tenantScoped, parentsRouter);
  app.use("/api/v1/usage", tenantScoped, usageRouter);
  app.use("/api/v1/classes", tenantScoped, classesRouter);
  app.use("/api/v1/live", tenantScoped, liveRouter);
  app.use("/api/v1/dashboard", tenantScoped, dashboardRouter);
  app.use("/api/v1/announcements", tenantScoped, announcementsRouter);
  app.use("/api/v1/assignments", tenantScoped, assignmentsRouter);
  app.use("/api/v1/attendance", tenantScoped, attendanceRouter);
  app.use("/api/v1/timetable", tenantScoped, timetableRouter);
  app.use("/api/v1/gradebook", tenantScoped, gradebookRouter);
  app.use("/api/v1/fees", tenantScoped, feesRouter);
  app.use("/api/v1/exams", tenantScoped, examsRouter);
  app.use("/api/v1/library", tenantScoped, libraryRouter);

  // Single-app deployments: serve the built React app and fall back to index.html for client routes.
  const webDist = env.WEB_DIST_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|health$|media\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorHandler);
  return app;
}
