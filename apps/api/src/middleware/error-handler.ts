import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === "23505") return res.status(409).json({ error: { code: "conflict", message: "Duplicate record" } });
  if (pgCode === "42501") return res.status(403).json({ error: { code: "forbidden", message: "Access denied" } });
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_request", message: "Malformed JSON body" } });
  }
  console.error(`[${req.method} ${req.path}]`, err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
}
