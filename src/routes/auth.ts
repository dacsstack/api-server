import { Router } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, userProfilesTable } from "@workspace/db";
import { hashPassword, verifyPassword, signToken } from "../lib/authService";
import { requireAuth, getAuthContext } from "../lib/auth";
import { loginRateLimiter, registerRateLimiter } from "../middlewares/rateLimit";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

router.post("/auth/register", registerRateLimiter, async (req, res): Promise<void> => {
  const { email, password, fullName } = req.body as Record<string, unknown>;

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db
    .select({ id: userProfilesTable.id })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.email, normalizedEmail));

  if (existing.length > 0) {
    res.status(400).json({ error: "Unable to create account with these credentials" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const orgId = userId;

  const [profile] = await db
    .insert(userProfilesTable)
    .values({ userId, orgId, role: "admin", fullName: typeof fullName === "string" ? fullName : null, email: normalizedEmail, passwordHash })
    .returning();

  const token = signToken({ userId: profile.userId, orgId: profile.orgId, role: profile.role });

  res.cookie("session", token, COOKIE_OPTS);
  res.status(201).json({
    token,
    user: {
      id: profile.id,
      userId: profile.userId,
      orgId: profile.orgId,
      role: profile.role,
      fullName: profile.fullName,
      email: profile.email,
    },
  });
});

router.post("/auth/login", loginRateLimiter, async (req, res): Promise<void> => {
  const { email, password } = req.body as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const [profile] = await db
    .select()
    .from(userProfilesTable)
    .where(eq(userProfilesTable.email, normalizedEmail));

  if (!profile?.passwordHash) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, profile.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: profile.userId, orgId: profile.orgId, role: profile.role });

  res.cookie("session", token, COOKIE_OPTS);
  res.json({
    token,
    user: {
      id: profile.id,
      userId: profile.userId,
      orgId: profile.orgId,
      role: profile.role,
      fullName: profile.fullName,
      email: profile.email,
    },
  });
});

router.post("/auth/logout", (req, res): void => {
  res.clearCookie("session", { path: "/" });
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;

  const [profile] = await db
    .select()
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, ctx.userId));

  if (!profile) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  res.json({
    id: profile.id,
    userId: profile.userId,
    orgId: profile.orgId,
    role: profile.role,
    fullName: profile.fullName,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  });
});

export default router;
