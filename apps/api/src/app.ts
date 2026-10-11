import cors from "cors";
import express from "express";
import helmet from "helmet";
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

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorHandler);
  return app;
}
