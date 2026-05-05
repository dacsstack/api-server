import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, activitiesTable, leadsTable } from "@workspace/db";
import { ListActivitiesQueryParams, CreateActivityBody } from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";

const router: IRouter = Router();

router.get("/activities", async (req, res): Promise<void> => {
  const parsed = ListActivitiesQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { leadId, contactId, limit, offset } = parsed.data;

  const conditions = [...orgConditions(ctx, activitiesTable)];
  if (leadId) conditions.push(eq(activitiesTable.leadId, leadId));
  if (contactId) conditions.push(eq(activitiesTable.contactId, contactId));

  const rows = await db
    .select({ activity: activitiesTable, leadName: leadsTable.fullName })
    .from(activitiesTable)
    .leftJoin(leadsTable, eq(activitiesTable.leadId, leadsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(activitiesTable.createdAt))
    .limit(limit).offset(offset);

  res.json(rows.map((r) => ({ ...r.activity, leadName: r.leadName ?? null })));
});

router.post("/activities", async (req, res): Promise<void> => {
  const parsed = CreateActivityBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [activity] = await db.insert(activitiesTable)
    .values({ ...parsed.data, ownerId: ctx.userId, orgId: ctx.orgId })
    .returning();
  res.status(201).json({ ...activity, leadName: null });
});

export default router;
