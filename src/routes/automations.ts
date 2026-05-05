import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, automationsTable } from "@workspace/db";
import {
  CreateAutomationBody, UpdateAutomationParams,
  UpdateAutomationBody, DeleteAutomationParams, ToggleAutomationBody,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";

const router: IRouter = Router();

router.get("/automations", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const conds = orgConditions(ctx, automationsTable);
  const automations = await db.select().from(automationsTable)
    .where(conds.length ? and(...conds) : undefined);
  res.json(automations);
});

router.post("/automations", async (req, res): Promise<void> => {
  const parsed = CreateAutomationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [automation] = await db.insert(automationsTable)
    .values({ ...parsed.data, ownerId: ctx.userId, orgId: ctx.orgId })
    .returning();
  res.status(201).json(automation);
});

router.patch("/automations/:id", async (req, res): Promise<void> => {
  const params = UpdateAutomationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateAutomationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [automation] = await db.update(automationsTable).set(parsed.data)
    .where(and(eq(automationsTable.id, params.data.id), ...orgConditions(ctx, automationsTable)))
    .returning();

  if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
  res.json(automation);
});

router.delete("/automations/:id", async (req, res): Promise<void> => {
  const params = DeleteAutomationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [automation] = await db.delete(automationsTable)
    .where(and(eq(automationsTable.id, params.data.id), ...orgConditions(ctx, automationsTable)))
    .returning();

  if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
  res.sendStatus(204);
});

router.patch("/automations/:id/toggle", async (req, res): Promise<void> => {
  const params = UpdateAutomationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = ToggleAutomationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [automation] = await db.update(automationsTable).set({ isActive: parsed.data.isActive })
    .where(and(eq(automationsTable.id, params.data.id), ...orgConditions(ctx, automationsTable)))
    .returning();

  if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
  res.json(automation);
});

export default router;
