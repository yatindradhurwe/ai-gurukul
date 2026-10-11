import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { Permission } from "../lib/permissions.js";

/** Require at least one of the listed permissions in the current tenant. */
export const requirePermission =
  (...anyOf: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(unauthorized("Tenant context required"));
    if (!anyOf.some((p) => req.tenant!.permissions.has(p))) return next(forbidden());
    next();
  };

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.isPlatformAdmin) return next(forbidden("Platform administrator access required"));
  next();
}
