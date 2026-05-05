import { Router, type IRouter } from "express";
import { eq, isNull, sql, desc, gte, and, or } from "drizzle-orm";
import {
  db, leadsTable, pipelineStagesTable, activitiesTable,
  appointmentsTable, notificationsTable, userProfilesTable,
} from "@workspace/db";
import { getAuthContext, leadConditions, orgConditions } from "../lib/auth";

const router: IRouter = Router();

router.get("/analytics/dashboard", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const lConds = [isNull(leadsTable.deletedAt), ...leadConditions(ctx)];

  const [{ totalLeads }] = await db
    .select({ totalLeads: sql<number>`count(*)::int` })
    .from(leadsTable).where(and(...lConds));

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const [{ newLeadsThisMonth }] = await db
    .select({ newLeadsThisMonth: sql<number>`count(*)::int` })
    .from(leadsTable).where(and(...lConds, gte(leadsTable.createdAt, monthStart)));

  const [dealsAgg] = await db
    .select({
      totalDealsValue: sql<number>`COALESCE(SUM(${leadsTable.dealValue}), 0)::float`,
      wonDealsValue: sql<number>`COALESCE(SUM(CASE WHEN ${leadsTable.status} = 'won' THEN ${leadsTable.dealValue} ELSE 0 END), 0)::float`,
    }).from(leadsTable).where(and(...lConds));

  const [{ avgLeadScore }] = await db
    .select({ avgLeadScore: sql<number>`COALESCE(AVG(${leadsTable.aiScore}), 0)::float` })
    .from(leadsTable).where(and(...lConds));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const apptConds = orgConditions(ctx, appointmentsTable);

  const [{ appointmentsToday }] = await db
    .select({ appointmentsToday: sql<number>`count(*)::int` })
    .from(appointmentsTable)
    .where(and(...apptConds, gte(appointmentsTable.startAt, today), sql`${appointmentsTable.startAt} < ${tomorrow}`));

  const [{ unreadNotifications }] = await db
    .select({ unreadNotifications: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, ctx.userId), eq(notificationsTable.isRead, false)));

  const stageConds = orgConditions(ctx, pipelineStagesTable);
  const stages = await db.select().from(pipelineStagesTable)
    .where(stageConds.length ? and(...stageConds) : undefined)
    .orderBy(sql`${pipelineStagesTable.order} ASC`);

  const stageBreakdown = await Promise.all(stages.map(async (stage) => {
    const [agg] = await db
      .select({
        count: sql<number>`count(*)::int`,
        value: sql<number>`COALESCE(SUM(${leadsTable.dealValue}), 0)::float`,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.stageId, stage.id), isNull(leadsTable.deletedAt), ...leadConditions(ctx)));
    return { stageName: stage.name, count: agg.count, value: agg.value, color: stage.color };
  }));

  res.json({
    totalLeads, newLeadsThisMonth,
    totalDealsValue: dealsAgg.totalDealsValue,
    wonDealsValue: dealsAgg.wonDealsValue,
    conversionRate: totalLeads > 0
      ? Math.round((dealsAgg.wonDealsValue / (dealsAgg.totalDealsValue || 1)) * 100) : 0,
    avgLeadScore: Math.round(avgLeadScore),
    appointmentsToday, unreadNotifications, stageBreakdown,
  });
});

router.get("/analytics/pipeline", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const stageConds = orgConditions(ctx, pipelineStagesTable);

  const stages = await db.select().from(pipelineStagesTable)
    .where(stageConds.length ? and(...stageConds) : undefined)
    .orderBy(sql`${pipelineStagesTable.order} ASC`);

  const stageStats = await Promise.all(stages.map(async (stage) => {
    const [agg] = await db
      .select({
        count: sql<number>`count(*)::int`,
        value: sql<number>`COALESCE(SUM(${leadsTable.dealValue}), 0)::float`,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.stageId, stage.id), isNull(leadsTable.deletedAt), ...leadConditions(ctx)));
    return { stageName: stage.name, count: agg.count, value: agg.value, color: stage.color };
  }));

  const weeksAgo8 = new Date(); weeksAgo8.setDate(weeksAgo8.getDate() - 56);
  const lConds = leadConditions(ctx);
  const weeklyRaw = await db
    .select({
      week: sql<string>`TO_CHAR(DATE_TRUNC('week', ${leadsTable.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .where(and(gte(leadsTable.createdAt, weeksAgo8), ...lConds))
    .groupBy(sql`DATE_TRUNC('week', ${leadsTable.createdAt})`)
    .orderBy(sql`DATE_TRUNC('week', ${leadsTable.createdAt})`);

  const totalLeads = stageStats.reduce((s, st) => s + st.count, 0);
  const conversionFunnel = stageStats.map((s) => ({
    stage: s.stageName, count: s.count,
    percentage: totalLeads > 0 ? Math.round((s.count / totalLeads) * 100) : 0,
  }));

  res.json({ stageStats, weeklyNewLeads: weeklyRaw, conversionFunnel });
});

router.get("/analytics/activity-feed", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const limit = parseInt(String(req.query.limit ?? "20"), 10);
  const conds = orgConditions(ctx, activitiesTable);

  const rows = await db
    .select({ activity: activitiesTable, leadName: leadsTable.fullName })
    .from(activitiesTable)
    .leftJoin(leadsTable, eq(activitiesTable.leadId, leadsTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(activitiesTable.createdAt)).limit(limit);

  res.json(rows.map((r) => ({ ...r.activity, leadName: r.leadName ?? null })));
});

router.get("/analytics/top-leads", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const limit = parseInt(String(req.query.limit ?? "10"), 10);

  const rows = await db
    .select({ lead: leadsTable, stageName: pipelineStagesTable.name })
    .from(leadsTable)
    .leftJoin(pipelineStagesTable, eq(leadsTable.stageId, pipelineStagesTable.id))
    .where(and(isNull(leadsTable.deletedAt), ...leadConditions(ctx)))
    .orderBy(desc(leadsTable.aiScore)).limit(limit);

  res.json({ leads: rows.map((r) => ({ ...r.lead, stageName: r.stageName ?? null })), total: rows.length });
});

router.get("/analytics/agents", async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;

  const rows = await db
    .select({
      userId: userProfilesTable.userId,
      fullName: userProfilesTable.fullName,
      role: userProfilesTable.role,
      totalLeads: sql<number>`COUNT(CASE WHEN ${leadsTable.deletedAt} IS NULL THEN 1 END)::int`,
      wonLeads: sql<number>`COUNT(CASE WHEN ${leadsTable.status} = 'won' AND ${leadsTable.deletedAt} IS NULL THEN 1 END)::int`,
      lostLeads: sql<number>`COUNT(CASE WHEN ${leadsTable.status} = 'lost' AND ${leadsTable.deletedAt} IS NULL THEN 1 END)::int`,
      activeLeads: sql<number>`COUNT(CASE WHEN ${leadsTable.status} NOT IN ('won','lost') AND ${leadsTable.deletedAt} IS NULL THEN 1 END)::int`,
      wonValue: sql<number>`COALESCE(SUM(CASE WHEN ${leadsTable.status} = 'won' AND ${leadsTable.deletedAt} IS NULL THEN ${leadsTable.dealValue} ELSE 0 END), 0)::float`,
    })
    .from(userProfilesTable)
    .leftJoin(leadsTable, eq(leadsTable.assignedTo, userProfilesTable.userId))
    .where(and(
      eq(userProfilesTable.orgId, ctx.orgId),
      or(eq(userProfilesTable.role, "agent"), eq(userProfilesTable.role, "admin")),
    ))
    .groupBy(userProfilesTable.userId, userProfilesTable.fullName, userProfilesTable.role)
    .orderBy(desc(sql<number>`COUNT(CASE WHEN ${leadsTable.status} = 'won' AND ${leadsTable.deletedAt} IS NULL THEN 1 END)`));

  const agents = rows.map((row) => ({
    ...row,
    conversionRate: row.totalLeads > 0 ? Math.round((row.wonLeads / row.totalLeads) * 100) : 0,
  }));

  res.json(agents);
});

export default router;
