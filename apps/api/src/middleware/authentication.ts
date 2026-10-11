import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { unauthorized } from "../lib/errors.js";

interface AccessTokenClaims {
  sub: string;
  adm?: boolean;
  typ: "access";
}

export function signAccessToken(userId: string, isPlatformAdmin: boolean): string {
  const claims: AccessTokenClaims = { sub: userId, adm: isPlatformAdmin || undefined, typ: "access" };
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, issuer: "ai-gurukul" });
}

/** Populates req.auth when a valid bearer token is present. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const claims = jwt.verify(header.slice(7), env.JWT_SECRET, { issuer: "ai-gurukul" }) as AccessTokenClaims;
    if (claims.typ !== "access") throw new Error("wrong token type");
    req.auth = { userId: claims.sub, isPlatformAdmin: Boolean(claims.adm) };
    next();
  } catch {
    next(unauthorized("Invalid or expired access token"));
  }
}

export function requireAuthentication(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  next();
}
