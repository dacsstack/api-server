import type { Request, Response, NextFunction } from "express";
import { eq, type SQL } from "drizzle-orm";
import { db, userProfilesTable, leadsTable } from "@workspace/db";
import { verifyToken } from "./authService";

export type UserRole = "super_admin" | "admin" | "agent";

export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
}

export function getAuthContext(req: Request): AuthContext | null {
  return (req as any).__authCtx ?? null;
}

export function getUserId(req: Request): string | null {
  return getAuthContext(req)?.userId ?? null;
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const cookie = (req as any).cookies?.session;
  if (typeof cookie === "string" && cookie.length > 0) return cookie;
  return null;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  let [profile] = await db
    .select()
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, payload.userId));

  if (!profile) {
    res.status(401).json({ error: "User account not found" });
    return;
  }

  (req as any).__authCtx = {
    userId: profile.userId,
    orgId: profile.orgId,
    role: profile.role as UserRole,
  } satisfies AuthContext;

  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getAuthContext(req);
    if (!ctx || !roles.includes(ctx.role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}

export function orgConditions(ctx: AuthContext, table: { orgId: any }): SQL[] {
  if (ctx.role === "super_admin") return [];
  return [eq(table.orgId as any, ctx.orgId)];
}

export function leadConditions(ctx: AuthContext): SQL[] {
  if (ctx.role === "super_admin") return [];
  const conds: SQL[] = [eq(leadsTable.orgId as any, ctx.orgId)];
  if (ctx.role === "agent") {
    conds.push(eq(leadsTable.assignedTo as any, ctx.userId));
  }
  return conds;
}
