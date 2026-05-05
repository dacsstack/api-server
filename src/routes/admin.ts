import { Router, type IRouter } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db, userProfilesTable } from "@workspace/db";
import { getAuthContext, requireRole } from "../lib/auth";

const router: IRouter = Router();

router.get("/me", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const [profile] = await db.select().from(userProfilesTable)
    .where(eq(userProfilesTable.userId, ctx.userId));
  res.json(profile ?? { userId: ctx.userId, orgId: ctx.orgId, role: ctx.role });
});

router.patch("/me", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const { fullName, email, avatarUrl } = req.body as { fullName?: string; email?: string; avatarUrl?: string };

  const [profile] = await db.update(userProfilesTable)
    .set({ fullName, email, avatarUrl })
    .where(eq(userProfilesTable.userId, ctx.userId))
    .returning();

  res.json(profile);
});

router.get("/members", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const members = await db
    .select({
      userId: userProfilesTable.userId,
      fullName: userProfilesTable.fullName,
      email: userProfilesTable.email,
      role: userProfilesTable.role,
      avatarUrl: userProfilesTable.avatarUrl,
    })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.orgId, ctx.orgId));
  res.json(members);
});

router.get("/admin/users", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;

  const filter = ctx.role === "super_admin"
    ? undefined
    : eq(userProfilesTable.orgId, ctx.orgId);

  const users = await db.select().from(userProfilesTable)
    .where(filter);

  res.json(users);
});

router.post("/admin/users", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const { email, role, fullName, confirmReassign } = req.body as {
    email?: string; role?: string; fullName?: string; confirmReassign?: boolean;
  };

  if (!email) { res.status(400).json({ error: "email required" }); return; }

  const orgId = ctx.role === "super_admin" && req.body.orgId ? req.body.orgId : ctx.orgId;
  const normalizedEmail = email.toLowerCase().trim();

  const [existingUser] = await db.select().from(userProfilesTable)
    .where(eq(userProfilesTable.email, normalizedEmail));

  if (!existingUser) {
    res.status(404).json({ error: "No registered user found with that email address" });
    return;
  }

  if (existingUser.userId === ctx.userId) {
    res.status(400).json({ error: "You cannot add yourself as a team member" });
    return;
  }

  const isInDifferentOrg = existingUser.orgId !== orgId;
  if (isInDifferentOrg && ctx.role !== "super_admin" && !confirmReassign) {
    res.status(409).json({
      error: "confirm_required",
      message: `This user belongs to a different organization. Adding them will move them to your org. Confirm to proceed.`,
      currentOrgId: existingUser.orgId,
      currentRole: existingUser.role,
    });
    return;
  }

  const [updated] = await db.update(userProfilesTable)
    .set({ orgId, role: role ?? "agent", ...(fullName ? { fullName } : {}) })
    .where(eq(userProfilesTable.userId, existingUser.userId))
    .returning();
  res.json(updated);
});

router.patch("/admin/users/:userId/role", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const userId = String(req.params.userId);
  const { role } = req.body as { role: string };

  if (!["admin", "agent", "super_admin"].includes(role)) {
    res.status(400).json({ error: "Invalid role. Must be admin, agent, or super_admin" });
    return;
  }

  if (role === "super_admin" && ctx.role !== "super_admin") {
    res.status(403).json({ error: "Only super admins can grant super_admin role" });
    return;
  }

  const cond = ctx.role === "super_admin"
    ? eq(userProfilesTable.userId, userId)
    : and(eq(userProfilesTable.userId, userId), eq(userProfilesTable.orgId, ctx.orgId));

  const [updated] = await db.update(userProfilesTable).set({ role })
    .where(cond)
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found in your organization" }); return; }
  res.json(updated);
});

router.delete("/admin/users/:userId", requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const userId = String(req.params.userId);

  if (userId === ctx.userId) { res.status(400).json({ error: "Cannot remove yourself" }); return; }

  const cond = ctx.role === "super_admin"
    ? eq(userProfilesTable.userId, userId)
    : and(eq(userProfilesTable.userId, userId), eq(userProfilesTable.orgId, ctx.orgId));

  const [removed] = await db.delete(userProfilesTable).where(cond).returning();
  if (!removed) { res.status(404).json({ error: "User not found" }); return; }
  res.sendStatus(204);
});

router.get("/super-admin/orgs", requireRole("super_admin"), async (req, res): Promise<void> => {
  const orgs = await db
    .selectDistinct({ orgId: userProfilesTable.orgId })
    .from(userProfilesTable);

  const orgStats = await Promise.all(orgs.map(async ({ orgId }) => {
    const members = await db.select().from(userProfilesTable)
      .where(eq(userProfilesTable.orgId, orgId));
    return {
      orgId,
      memberCount: members.length,
      adminCount: members.filter((m) => m.role === "admin").length,
      agentCount: members.filter((m) => m.role === "agent").length,
      members,
    };
  }));

  res.json(orgStats);
});

router.patch("/super-admin/users/:userId/org", requireRole("super_admin"), async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { orgId, role } = req.body as { orgId: string; role?: string };

  if (!orgId) { res.status(400).json({ error: "orgId required" }); return; }

  const [updated] = await db.update(userProfilesTable)
    .set({ orgId, ...(role ? { role } : {}) })
    .where(eq(userProfilesTable.userId, userId))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json(updated);
});

export default router;
