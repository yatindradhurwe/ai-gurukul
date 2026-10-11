import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z, ZodTypeAny } from "zod";
import { badRequest, unauthorized } from "./errors.js";
import type { AuthContext, TenantContext } from "../types.js";

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest("Invalid request", result.error.flatten());
  return result.data;
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireTenant(req: Request): TenantContext {
  if (!req.tenant) throw unauthorized("Tenant context required");
  return req.tenant;
}
