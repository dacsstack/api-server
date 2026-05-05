import { Router, type IRouter } from "express";
import { eq, ilike, or, isNull, sql, desc, and, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, leadsTable, pipelineStagesTable, activitiesTable, userProfilesTable } from "@workspace/db";
import { runAutomations } from "../lib/run-automations";
import {
  ListLeadsQueryParams,
  CreateLeadBody,
  GetLeadParams,
  UpdateLeadParams,
  UpdateLeadBody,
  DeleteLeadParams,
  UpdateLeadStageParams,
  UpdateLeadStageBody,
  UpdateLeadTagsParams,
  UpdateLeadTagsBody,
  ScoreLeadParams,
  GetLeadAiSummaryParams,
} from "@workspace/api-zod";
import { getAuthContext, leadConditions, orgConditions } from "../lib/auth";
import { sendEmailToLead } from "../lib/email";
import OpenAI from "openai";

const router: IRouter = Router();

const assigneeTable = alias(userProfilesTable, "assignee");

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

async function enrichLeadWithStage(lead: typeof leadsTable.$inferSelect) {
  if (!lead.stageId) return { ...lead, stageName: null, assignedToName: null };
  const [stage] = await db
    .select({ name: pipelineStagesTable.name })
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.id, lead.stageId));

  let assignedToName: string | null = null;
  if (lead.assignedTo) {
    const [assignee] = await db
      .select({ fullName: userProfilesTable.fullName })
      .from(userProfilesTable)
      .where(eq(userProfilesTable.userId, lead.assignedTo));
    assignedToName = assignee?.fullName ?? null;
  }
  return { ...lead, stageName: stage?.name ?? null, assignedToName };
}

router.get("/leads", async (req, res): Promise<void> => {
  const parsed = ListLeadsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { stage, search, tag, assignedTo, status, priority, followUpDue, myLeads, limit, offset } = parsed.data as any;

  const conditions = [isNull(leadsTable.deletedAt), ...leadConditions(ctx)];
  if (search) {
    conditions.push(or(
      ilike(leadsTable.fullName, `%${search}%`),
      ilike(leadsTable.email, `%${search}%`),
      ilike(leadsTable.company, `%${search}%`),
    )!);
  }
  if (assignedTo) conditions.push(eq(leadsTable.assignedTo, assignedTo));
  if (status) conditions.push(eq(leadsTable.status, status));
  if (priority) conditions.push(eq(leadsTable.priority, priority));
  if (followUpDue === "true" || followUpDue === true) {
    conditions.push(sql`${leadsTable.followUpAt} IS NOT NULL AND ${leadsTable.followUpAt} <= NOW()`);
  }
  if (myLeads === "true" || myLeads === true) {
    conditions.push(eq(leadsTable.assignedTo, ctx.userId));
  }

  const rows = await db
    .select({ lead: leadsTable, stageName: pipelineStagesTable.name, assignedToName: assigneeTable.fullName })
    .from(leadsTable)
    .leftJoin(pipelineStagesTable, eq(leadsTable.stageId, pipelineStagesTable.id))
    .leftJoin(assigneeTable, eq(leadsTable.assignedTo, assigneeTable.userId))
    .where(and(...conditions))
    .orderBy(desc(leadsTable.createdAt))
    .limit(limit)
    .offset(offset);

  let results = rows.map((r) => ({ ...r.lead, stageName: r.stageName ?? null, assignedToName: r.assignedToName ?? null }));
  if (stage) results = results.filter((l) => l.stageName?.toLowerCase() === stage.toLowerCase());
  if (tag) results = results.filter((l) => l.tags?.includes(tag));

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(isNull(leadsTable.deletedAt), ...leadConditions(ctx)));

  res.json({ leads: results, total: count });
});

router.post("/leads", async (req, res): Promise<void> => {
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  // Auto-assign to the first pipeline stage if none provided
  let stageId = (parsed.data as any).stageId ?? null;
  if (!stageId && ctx.orgId) {
    const [firstStage] = await db
      .select({ id: pipelineStagesTable.id })
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.orgId, ctx.orgId))
      .orderBy(asc(pipelineStagesTable.order))
      .limit(1);
    stageId = firstStage?.id ?? null;
  }

  const { followUpAt, ...restData } = parsed.data as any;
  const [lead] = await db.insert(leadsTable).values({
    ...restData,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    assignedTo: parsed.data.assignedTo ?? ctx.userId,
    stageId,
    ...(followUpAt ? { followUpAt: new Date(followUpAt) } : {}),
  }).returning();

  await db.insert(activitiesTable).values({
    type: "lead_created",
    description: `Lead ${lead.fullName} was created`,
    leadId: lead.id,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    performedBy: ctx.userId,
  });

  const enriched = await enrichLeadWithStage(lead);
  runAutomations("lead_created", { lead }, ctx).catch(() => {});

  // Auto-score in background — fire and forget
  (async () => {
    const ai = getOpenAI();
    if (!ai) return;
    try {
      const leadContext = {
        name: lead.fullName, email: lead.email, company: lead.company ?? null,
        title: lead.title ?? null, source: lead.source ?? null, dealValue: lead.dealValue ?? null,
        priority: lead.priority ?? null, tags: lead.tags ?? [], notes: lead.notes ?? null,
        utmSource: lead.utmSource ?? null, utmMedium: lead.utmMedium ?? null,
        utmCampaign: lead.utmCampaign ?? null, daysSinceCreated: 0,
      };
      const systemPrompt = `You are a B2B sales intelligence engine. Score this CRM lead and return JSON:
{"score":<int 0-100>,"breakdown":{"fit":<int>,"intent":<int>,"urgency":<int>,"engagement":<int>},"summary":"<2 sentences>","nextAction":"<specific next step>"}
Score higher (70+) if: has company+title, deal value >$5k, came from paid campaign. Score lower (<40) if: missing company/title, no deal value, unknown source.`;
      const c = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(leadContext) },
        ],
        response_format: { type: "json_object" }, max_tokens: 400,
      });
      const r = JSON.parse(c.choices[0].message.content ?? "{}");
      const autoScore = Math.min(100, Math.max(0, Math.round(r.score ?? 50)));
      const breakdown = r.breakdown && typeof r.breakdown === "object" ? JSON.stringify({
        fit: Math.min(100, Math.max(0, Math.round(r.breakdown.fit ?? 50))),
        intent: Math.min(100, Math.max(0, Math.round(r.breakdown.intent ?? 50))),
        urgency: Math.min(100, Math.max(0, Math.round(r.breakdown.urgency ?? 50))),
        engagement: Math.min(100, Math.max(0, Math.round(r.breakdown.engagement ?? 50))),
      }) : null;
      await db.update(leadsTable).set({
        aiScore: autoScore,
        aiScoreSummary: r.summary ?? null,
        aiScoreBreakdown: breakdown,
        aiNextAction: r.nextAction ?? null,
        aiScoredAt: new Date(),
      }).where(eq(leadsTable.id, lead.id));
    } catch (_) { /* silent — auto-scoring is best-effort */ }
  })();

  res.status(201).json(enriched);
});

router.get("/leads/:id", async (req, res): Promise<void> => {
  const params = GetLeadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [row] = await db
    .select({ lead: leadsTable, stageName: pipelineStagesTable.name, assignedToName: assigneeTable.fullName })
    .from(leadsTable)
    .leftJoin(pipelineStagesTable, eq(leadsTable.stageId, pipelineStagesTable.id))
    .leftJoin(assigneeTable, eq(leadsTable.assignedTo, assigneeTable.userId))
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)));

  if (!row) { res.status(404).json({ error: "Lead not found" }); return; }
  res.json({ ...row.lead, stageName: row.stageName ?? null, assignedToName: row.assignedToName ?? null });
});

router.patch("/leads/:id", async (req, res): Promise<void> => {
  const params = UpdateLeadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateLeadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [current] = await db
    .select({ assignedTo: leadsTable.assignedTo, status: leadsTable.status })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)));

  const { followUpAt, ...updateRest } = parsed.data as any;
  const updateData: Record<string, unknown> = { ...updateRest };
  if (followUpAt !== undefined) updateData.followUpAt = followUpAt ? new Date(followUpAt) : null;

  const [lead] = await db
    .update(leadsTable)
    .set(updateData)
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)))
    .returning();

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const activityInserts: typeof activitiesTable.$inferInsert[] = [];

  if (parsed.data.assignedTo && parsed.data.assignedTo !== current?.assignedTo) {
    const [assignee] = await db
      .select({ fullName: userProfilesTable.fullName })
      .from(userProfilesTable)
      .where(eq(userProfilesTable.userId, parsed.data.assignedTo));
    activityInserts.push({
      type: "reassigned",
      description: `Lead assigned to ${assignee?.fullName ?? parsed.data.assignedTo}`,
      leadId: lead.id,
      ownerId: ctx.userId,
      orgId: ctx.orgId,
      performedBy: ctx.userId,
    });
  }

  if (parsed.data.status && parsed.data.status !== current?.status) {
    activityInserts.push({
      type: "status_changed",
      description: `Lead status changed to ${parsed.data.status}`,
      leadId: lead.id,
      ownerId: ctx.userId,
      orgId: ctx.orgId,
      performedBy: ctx.userId,
    });
  }

  if (activityInserts.length > 0) {
    await db.insert(activitiesTable).values(activityInserts);
  }

  // Fire deal_won / deal_lost automations
  if (parsed.data.status && parsed.data.status !== current?.status) {
    const newStatus = parsed.data.status;
    if (newStatus === "won" || newStatus === "lost") {
      runAutomations(newStatus === "won" ? "deal_won" : "deal_lost", { lead }, ctx).catch(() => {});
    }
  }

  res.json(await enrichLeadWithStage(lead));
});

router.delete("/leads/:id", async (req, res): Promise<void> => {
  const params = DeleteLeadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [lead] = await db
    .update(leadsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)))
    .returning();

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  res.sendStatus(204);
});

router.patch("/leads/:id/stage", async (req, res): Promise<void> => {
  const params = UpdateLeadStageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateLeadStageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [lead] = await db
    .update(leadsTable)
    .set({ stageId: parsed.data.stageId })
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)))
    .returning();

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const [stage] = await db.select().from(pipelineStagesTable).where(eq(pipelineStagesTable.id, parsed.data.stageId));
  await db.insert(activitiesTable).values({
    type: "stage_changed",
    description: `Lead moved to stage: ${stage?.name ?? parsed.data.stageId}`,
    leadId: lead.id,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    performedBy: ctx.userId,
  });

  runAutomations("stage_changed", { lead, stageName: stage?.name }, ctx).catch(() => {});
  res.json(await enrichLeadWithStage(lead));
});

router.patch("/leads/:id/tags", async (req, res): Promise<void> => {
  const params = UpdateLeadTagsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateLeadTagsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [lead] = await db
    .update(leadsTable)
    .set({ tags: parsed.data.tags })
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)))
    .returning();

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  res.json(await enrichLeadWithStage(lead));
});

router.post("/leads/:id/score", async (req, res): Promise<void> => {
  const params = ScoreLeadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)));

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  let aiScore = 50;
  let aiScoreSummary = "Standard lead with moderate conversion potential.";
  let aiScoreBreakdown: string | null = null;
  let aiNextAction: string | null = null;

  const ai = getOpenAI();
  if (ai) {
    try {
      const leadContext = {
        name: lead.fullName,
        email: lead.email,
        company: lead.company ?? null,
        title: lead.title ?? null,
        source: lead.source ?? null,
        dealValue: lead.dealValue ?? null,
        priority: lead.priority ?? null,
        tags: lead.tags ?? [],
        notes: lead.notes ?? null,
        utmSource: lead.utmSource ?? null,
        utmMedium: lead.utmMedium ?? null,
        utmCampaign: lead.utmCampaign ?? null,
        daysSinceCreated: Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000),
      };

      const systemPrompt = `You are a B2B sales intelligence engine. Score this CRM lead and return a JSON object with this exact shape:
{
  "score": <integer 0-100, overall lead quality>,
  "breakdown": {
    "fit": <integer 0-100, how well the lead matches an ideal customer profile based on company/title/deal value>,
    "intent": <integer 0-100, signals of buying intent: UTM campaign/medium, source quality, notes content>,
    "urgency": <integer 0-100, time pressure signals: priority field, follow-up timing, campaign type>,
    "engagement": <integer 0-100, how engaged the lead is: has email, phone, notes, tags, came from a campaign>
  },
  "summary": <2-sentence plain-English assessment of this lead's quality and likely fit>,
  "nextAction": <one specific, actionable next step the sales agent should take — be concrete, e.g. "Send a case study about [topic] since they came from a paid campaign targeting [keyword]">
}

Rules:
- Score higher (70+) if: has a company AND title, deal value over $5k, came from a paid campaign (utm_medium=cpc/paid_social), has notes showing interest
- Score lower (below 40) if: missing company/title, no deal value, source is unknown, no engagement signals
- The overall score should roughly equal the weighted average: fit*0.35 + intent*0.30 + urgency*0.20 + engagement*0.15
- nextAction must be specific to THIS lead's data — never generic advice`;

      const c = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(leadContext) },
        ],
        response_format: { type: "json_object" },
        max_tokens: 400,
      });

      const r = JSON.parse(c.choices[0].message.content ?? "{}");
      aiScore = Math.min(100, Math.max(0, Math.round(r.score ?? 50)));
      aiScoreSummary = r.summary ?? aiScoreSummary;
      aiNextAction = r.nextAction ?? null;
      if (r.breakdown && typeof r.breakdown === "object") {
        aiScoreBreakdown = JSON.stringify({
          fit: Math.min(100, Math.max(0, Math.round(r.breakdown.fit ?? 50))),
          intent: Math.min(100, Math.max(0, Math.round(r.breakdown.intent ?? 50))),
          urgency: Math.min(100, Math.max(0, Math.round(r.breakdown.urgency ?? 50))),
          engagement: Math.min(100, Math.max(0, Math.round(r.breakdown.engagement ?? 50))),
        });
      }
    } catch (err) { req.log.warn({ err }, "AI scoring failed"); }
  }

  const [scoredLead] = await db.update(leadsTable).set({
    aiScore,
    aiScoreSummary,
    aiScoreBreakdown,
    aiNextAction,
    aiScoredAt: new Date(),
  })
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)))
    .returning();

  if (scoredLead) {
    runAutomations("ai_scored", { lead: scoredLead, aiScore }, ctx).catch(() => {});
  }

  res.json({ id: params.data.id, aiScore, aiScoreSummary, aiScoreBreakdown, aiNextAction });
});

router.post("/leads/:id/email", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { subject, body: emailBody } = req.body ?? {};
  if (typeof subject !== "string" || !subject.trim() || typeof emailBody !== "string" || !emailBody.trim()) {
    res.status(400).json({ error: "subject and body are required" }); return;
  }
  const ctx = getAuthContext(req)!;

  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, id), ...leadConditions(ctx)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!lead.email) { res.status(400).json({ error: "Lead has no email address" }); return; }

  const [agent] = await db.select({ fullName: userProfilesTable.fullName })
    .from(userProfilesTable).where(eq(userProfilesTable.userId, ctx.userId));

  await sendEmailToLead({
    toEmail: lead.email,
    leadName: lead.fullName,
    subject: subject.trim(),
    body: emailBody.trim(),
    agentName: agent?.fullName ?? null,
  });

  await db.insert(activitiesTable).values({
    type: "email_sent",
    description: `Email sent to lead: "${subject.trim()}"`,
    leadId: lead.id,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    performedBy: ctx.userId,
  });

  res.json({ ok: true });
});

router.get("/leads/:id/summary", async (req, res): Promise<void> => {
  const params = GetLeadAiSummaryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), ...leadConditions(ctx)));

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const activities = await db.select().from(activitiesTable)
    .where(and(eq(activitiesTable.leadId, params.data.id), ...orgConditions(ctx, activitiesTable)))
    .orderBy(desc(activitiesTable.createdAt)).limit(10);

  let summary = `${lead.fullName} from ${lead.company ?? "Unknown"} is a ${lead.status} lead.`;
  let suggestions = ["Schedule a follow-up call", "Send a personalized demo", "Connect on LinkedIn"];

  const ai = getOpenAI();
  if (ai) {
    try {
      const c = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Analyze lead and provide JSON: { summary: string, suggestions: string[] }" },
          { role: "user", content: JSON.stringify({ ...lead, recentActivities: activities.map(a => a.description) }) },
        ],
        response_format: { type: "json_object" }, max_tokens: 400,
      });
      const r = JSON.parse(c.choices[0].message.content ?? "{}");
      summary = r.summary ?? summary;
      suggestions = r.suggestions ?? suggestions;
    } catch { /* fallback */ }
  }

  res.json({ summary, suggestions });
});

export default router;
