import { Router, type IRouter } from "express";
import { eq, and, isNull, gt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, userProfilesTable, invitationsTable } from "@workspace/db";
import { hashPassword, signToken } from "../lib/authService";
import { requireAuth, getAuthContext, requireRole } from "../lib/auth";
import { sendTeamInvite } from "../lib/email";

const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domains) return `https://${domains}`;
  const proto = req.get("x-forwarded-proto") ?? req.protocol ?? "http";
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

// ── Admin: list pending invites for org ──────────────────────────────────────
router.get("/admin/invitations", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const now = new Date();

  const invites = await db.select().from(invitationsTable)
    .where(
      and(
        eq(invitationsTable.orgId, ctx.orgId),
        isNull(invitationsTable.acceptedAt),
        gt(invitationsTable.expiresAt, now),
      ),
    );

  res.json(invites);
});

// ── Admin: send invite ───────────────────────────────────────────────────────
router.post("/admin/invitations", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const { email, role } = req.body as { email?: string; role?: string };

  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedRole = ["admin", "agent"].includes(role ?? "") ? (role as string) : "agent";

  // Check if already a member
  const [existing] = await db.select({ id: userProfilesTable.id, orgId: userProfilesTable.orgId })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.email, normalizedEmail));

  if (existing?.orgId === ctx.orgId) {
    res.status(409).json({ error: "This person is already a member of your organization" });
    return;
  }

  // Revoke any prior pending invite for this email+org
  await db.delete(invitationsTable).where(
    and(eq(invitationsTable.email, normalizedEmail), eq(invitationsTable.orgId, ctx.orgId)),
  );

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [inviterProfile] = await db.select({ fullName: userProfilesTable.fullName, email: userProfilesTable.email })
    .from(userProfilesTable).where(eq(userProfilesTable.userId, ctx.userId));

  const inviterName = inviterProfile?.fullName ?? inviterProfile?.email ?? "Your team";

  const [invite] = await db.insert(invitationsTable)
    .values({
      token,
      email: normalizedEmail,
      role: normalizedRole,
      orgId: ctx.orgId,
      invitedBy: ctx.userId,
      invitedByName: inviterName,
      expiresAt,
    })
    .returning();

  const inviteUrl = `${getBaseUrl(req)}/invite/${token}`;

  // Fire-and-forget email
  sendTeamInvite({
    toEmail: normalizedEmail,
    invitedByName: inviterName,
    orgName: "DacsStack CRM",
    role: normalizedRole,
    inviteUrl,
  }).catch(() => {});

  res.status(201).json({ ...invite, inviteUrl });
});

// ── Admin: revoke invite ─────────────────────────────────────────────────────
router.delete("/admin/invitations/:id", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [removed] = await db.delete(invitationsTable)
    .where(and(eq(invitationsTable.id, id), eq(invitationsTable.orgId, ctx.orgId)))
    .returning();

  if (!removed) { res.status(404).json({ error: "Invite not found" }); return; }
  res.sendStatus(204);
});

// ── Public: look up invite token ─────────────────────────────────────────────
router.get("/auth/invite/:token", async (req, res): Promise<void> => {
  const { token } = req.params;
  const now = new Date();

  const [invite] = await db.select().from(invitationsTable)
    .where(and(eq(invitationsTable.token, token), isNull(invitationsTable.acceptedAt), gt(invitationsTable.expiresAt, now)));

  if (!invite) {
    res.status(404).json({ error: "Invite not found or has expired" });
    return;
  }

  res.json({
    email: invite.email,
    role: invite.role,
    invitedByName: invite.invitedByName,
    expiresAt: invite.expiresAt,
  });
});

// ── Public: accept invite ────────────────────────────────────────────────────
router.post("/auth/invite/:token/accept", async (req, res): Promise<void> => {
  const { token } = req.params;
  const { password, fullName } = req.body as { password?: string; fullName?: string };

  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const now = new Date();
  const [invite] = await db.select().from(invitationsTable)
    .where(and(eq(invitationsTable.token, token), isNull(invitationsTable.acceptedAt), gt(invitationsTable.expiresAt, now)));

  if (!invite) {
    res.status(404).json({ error: "Invite not found or has expired" });
    return;
  }

  // Check if email already has an account — merge into the invited org instead
  const [existingUser] = await db.select().from(userProfilesTable)
    .where(eq(userProfilesTable.email, invite.email));

  let profile;

  if (existingUser) {
    // Update existing user: move to invited org with invited role
    const [updated] = await db.update(userProfilesTable)
      .set({ orgId: invite.orgId, role: invite.role, ...(fullName ? { fullName } : {}) })
      .where(eq(userProfilesTable.userId, existingUser.userId))
      .returning();
    profile = updated;
  } else {
    // Create new account
    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    const [created] = await db.insert(userProfilesTable)
      .values({
        userId,
        orgId: invite.orgId,
        role: invite.role,
        email: invite.email,
        fullName: typeof fullName === "string" && fullName ? fullName : null,
        passwordHash,
      })
      .returning();
    profile = created;
  }

  // Mark invite accepted
  await db.update(invitationsTable)
    .set({ acceptedAt: now })
    .where(eq(invitationsTable.token, token));

  const jwtToken = signToken({ userId: profile.userId, orgId: profile.orgId, role: profile.role });

  res.cookie("session", jwtToken, COOKIE_OPTS);
  res.json({
    token: jwtToken,
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

export default router;
