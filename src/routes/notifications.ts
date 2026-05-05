import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { ListNotificationsQueryParams, MarkNotificationReadParams } from "@workspace/api-zod";
import { getAuthContext } from "../lib/auth";

const router: IRouter = Router();

router.get("/notifications", async (req, res): Promise<void> => {
  const parsed = ListNotificationsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const conditions = [eq(notificationsTable.userId, ctx.userId)];
  if (parsed.data.unreadOnly) conditions.push(eq(notificationsTable.isRead, false));

  const notifications = await db.select().from(notificationsTable)
    .where(and(...conditions))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(50);

  res.json(notifications);
});

router.patch("/notifications/:id/read", async (req, res): Promise<void> => {
  const params = MarkNotificationReadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [notification] = await db.update(notificationsTable).set({ isRead: true })
    .where(and(eq(notificationsTable.id, params.data.id), eq(notificationsTable.userId, ctx.userId)))
    .returning();

  if (!notification) { res.status(404).json({ error: "Notification not found" }); return; }
  res.json(notification);
});

router.post("/notifications/read-all", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  await db.update(notificationsTable).set({ isRead: true })
    .where(and(eq(notificationsTable.userId, ctx.userId), eq(notificationsTable.isRead, false)));
  res.sendStatus(204);
});

export default router;
