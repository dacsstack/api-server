import { Router, type IRouter } from "express";
import { eq, and, lte, desc } from "drizzle-orm";
import { db, tasksTable, leadsTable } from "@workspace/db";
import {
  ListTasksQueryParams,
  CreateTaskBody,
  UpdateTaskParams,
  UpdateTaskBody,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";

const router: IRouter = Router();

router.get("/tasks", async (req, res): Promise<void> => {
  const parsed = ListTasksQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { leadId, assignedTo, dueBefore } = parsed.data as any;

  // Read boolean flags from raw query string — z.coerce.boolean() converts "false"→true
  const rawCompleted = req.query.completed as string | undefined;
  const rawMyTasks = req.query.myTasks as string | undefined;

  const conditions = [...orgConditions(ctx, tasksTable)];
  if (leadId) conditions.push(eq(tasksTable.leadId, leadId));
  if (assignedTo) conditions.push(eq(tasksTable.assignedTo, assignedTo));
  if (rawCompleted === "true") conditions.push(eq(tasksTable.completed, true));
  else if (rawCompleted === "false") conditions.push(eq(tasksTable.completed, false));
  if (rawMyTasks === "true") conditions.push(eq(tasksTable.assignedTo, ctx.userId));
  if (dueBefore) conditions.push(lte(tasksTable.dueAt, new Date(dueBefore as string)));

  const rows = await db
    .select({ task: tasksTable, leadName: leadsTable.fullName })
    .from(tasksTable)
    .leftJoin(leadsTable, eq(tasksTable.leadId, leadsTable.id))
    .where(and(...conditions))
    .orderBy(desc(tasksTable.dueAt));

  res.json(rows.map((r) => ({ ...r.task, leadName: r.leadName ?? null })));
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { title, description, dueAt, priority, leadId, assignedTo } = parsed.data as any;

  const [task] = await db.insert(tasksTable).values({
    title,
    description: description ?? null,
    dueAt: dueAt ? new Date(dueAt) : null,
    priority: priority ?? "medium",
    leadId: leadId ?? null,
    assignedTo: assignedTo ?? ctx.userId,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
  }).returning();

  const leadName = task.leadId
    ? (await db.select({ fullName: leadsTable.fullName }).from(leadsTable).where(eq(leadsTable.id, task.leadId)))[0]?.fullName ?? null
    : null;

  res.status(201).json({ ...task, leadName });
});

router.patch("/tasks/:id", async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { title, description, dueAt, priority, completed, leadId, assignedTo } = parsed.data as any;

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (dueAt !== undefined) updates.dueAt = dueAt ? new Date(dueAt) : null;
  if (priority !== undefined) updates.priority = priority;
  if (leadId !== undefined) updates.leadId = leadId;
  if (assignedTo !== undefined) updates.assignedTo = assignedTo;
  if (completed === true) { updates.completed = true; updates.completedAt = new Date(); }
  if (completed === false) { updates.completed = false; updates.completedAt = null; }

  const [task] = await db
    .update(tasksTable)
    .set(updates)
    .where(and(eq(tasksTable.id, params.data.id), ...orgConditions(ctx, tasksTable)))
    .returning();

  if (!task) { res.status(404).json({ error: "Task not found" }); return; }

  const leadName = task.leadId
    ? (await db.select({ fullName: leadsTable.fullName }).from(leadsTable).where(eq(leadsTable.id, task.leadId)))[0]?.fullName ?? null
    : null;

  res.json({ ...task, leadName });
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  await db
    .delete(tasksTable)
    .where(and(eq(tasksTable.id, params.data.id), ...orgConditions(ctx, tasksTable)));

  res.status(204).end();
});

export default router;
