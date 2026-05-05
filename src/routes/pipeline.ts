import { Router, type IRouter } from "express";
import { eq, asc, isNull, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, pipelineStagesTable, leadsTable, userProfilesTable } from "@workspace/db";
import {
  CreatePipelineStageBody, UpdatePipelineStageParams,
  UpdatePipelineStageBody, DeletePipelineStageParams,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions, leadConditions } from "../lib/auth";

const router: IRouter = Router();
const assigneeProfile = alias(userProfilesTable, "assignee_profile");

router.get("/pipeline/stages", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const conds = orgConditions(ctx, pipelineStagesTable);
  const stages = await db.select().from(pipelineStagesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(pipelineStagesTable.order));
  res.json(stages);
});

router.post("/pipeline/stages", async (req, res): Promise<void> => {
  const parsed = CreatePipelineStageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [stage] = await db.insert(pipelineStagesTable)
    .values({ ...parsed.data, ownerId: ctx.userId, orgId: ctx.orgId })
    .returning();
  res.status(201).json(stage);
});

router.patch("/pipeline/stages/:id", async (req, res): Promise<void> => {
  const params = UpdatePipelineStageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdatePipelineStageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [stage] = await db.update(pipelineStagesTable).set(parsed.data)
    .where(and(eq(pipelineStagesTable.id, params.data.id), ...orgConditions(ctx, pipelineStagesTable)))
    .returning();

  if (!stage) { res.status(404).json({ error: "Stage not found" }); return; }
  res.json(stage);
});

router.delete("/pipeline/stages/:id", async (req, res): Promise<void> => {
  const params = DeletePipelineStageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [stage] = await db.delete(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.id, params.data.id), ...orgConditions(ctx, pipelineStagesTable)))
    .returning();

  if (!stage) { res.status(404).json({ error: "Stage not found" }); return; }
  res.sendStatus(204);
});

const DEFAULT_STAGES = [
  { name: "New Lead",     color: "#6366f1", order: 0 },
  { name: "Qualified",   color: "#8b5cf6", order: 1 },
  { name: "Proposal",    color: "#f59e0b", order: 2 },
  { name: "Negotiation", color: "#ef4444", order: 3 },
  { name: "Closed Won",  color: "#22c55e", order: 4 },
];

router.get("/pipeline/board", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;

  let stages = await db.select().from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.orgId, ctx.orgId))
    .orderBy(asc(pipelineStagesTable.order));

  // Auto-seed default stages for orgs that have none yet
  if (stages.length === 0 && ctx.orgId) {
    stages = await db.insert(pipelineStagesTable)
      .values(DEFAULT_STAGES.map((d) => ({ ...d, orgId: ctx.orgId, ownerId: ctx.userId })))
      .returning();
  }

  const leadConds = leadConditions(ctx);
  const boardStages = await Promise.all(
    stages.map(async (stage) => {
      const conditions = [eq(leadsTable.stageId, stage.id), isNull(leadsTable.deletedAt), ...leadConds];

      const rows = await db
        .select({
          lead: leadsTable,
          assignedToName: assigneeProfile.fullName,
        })
        .from(leadsTable)
        .leftJoin(assigneeProfile, eq(leadsTable.assignedTo, assigneeProfile.userId))
        .where(and(...conditions));

      const leads = rows.map((r) => ({
        ...r.lead,
        stageName: stage.name,
        assignedToName: r.assignedToName ?? null,
      }));

      return {
        stage,
        leads,
        totalValue: leads.reduce((sum, l) => sum + (l.dealValue ?? 0), 0),
      };
    }),
  );

  res.json({ stages: boardStages });
});

export default router;
