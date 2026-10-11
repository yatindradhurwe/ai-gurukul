import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

/**
 * Fixed-window in-memory limiter, keyed by user (or IP when anonymous).
 * Swap for a Redis-backed limiter when running more than one API instance.
 */
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (env.RATE_LIMIT_DISABLED === "true") return next();
    const key = `${opts.name}:${req.auth?.userId ?? req.ip}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader("RateLimit-Remaining", Math.max(0, opts.max - entry.count));
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return next(new AppError(429, "rate_limited", "Too many requests, please slow down"));
    }
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    next();
  };
}
