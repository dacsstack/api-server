import { Router, type IRouter } from "express";
import { isNull, desc, and, eq, gte } from "drizzle-orm";
import { db, leadsTable, pipelineStagesTable, activitiesTable, appointmentsTable } from "@workspace/db";
import { ChatWithAiBody } from "@workspace/api-zod";
import { getAuthContext, leadConditions, orgConditions } from "../lib/auth";
import { aiRateLimiter } from "../middlewares/rateLimit";
import OpenAI from "openai";

const router: IRouter = Router();

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function getRecommendedAction(score: number): string {
  if (score >= 80) return "Schedule a product demo immediately";
  if (score >= 60) return "Send personalized follow-up email";
  return "Nurture with content and check in next week";
}

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

async function buildSmartFallback(
  message: string,
  leads: any[],
  stages: any[],
): Promise<{ reply: string; suggestedActions: string[] }> {
  const msg = message.toLowerCase();

  const scoredLeads = (leads as any[]).filter((l) => l.aiScore != null).sort((a, b) => b.aiScore - a.aiScore);
  const highScoreLeads = scoredLeads.filter((l) => l.aiScore >= 80);
  const medScoreLeads = scoredLeads.filter((l) => l.aiScore >= 60 && l.aiScore < 80);
  const unscoredLeads = (leads as any[]).filter((l) => l.aiScore == null);
  const totalValue = (leads as any[]).reduce((s, l) => s + (l.dealValue ?? 0), 0);

  const topLead = scoredLeads[0];

  // ── top scoring / best leads ──────────────────────────────────────────────
  if (msg.match(/top.?scor|best lead|highest score|priority lead/)) {
    if (highScoreLeads.length === 0 && scoredLeads.length === 0) {
      return {
        reply: `None of your ${leads.length} leads have been AI-scored yet. Click the ★ button next to any lead to score them — the AI ranks each lead 0–100 and tells you exactly how to proceed.`,
        suggestedActions: ["How do I score a lead?", "Show me all leads", "What leads need follow-up?"],
      };
    }
    const list = scoredLeads.slice(0, 5).map((l) => `• **${l.fullName}** (${l.company ?? "independent"}) — score ${l.aiScore}`).join("\n");
    return {
      reply: `Your top-scoring leads right now:\n\n${list}\n\n${highScoreLeads.length > 0 ? `${highScoreLeads.length} lead${highScoreLeads.length > 1 ? "s" : ""} are in the high-priority zone (80+) — I'd recommend reaching out to ${highScoreLeads[0].fullName} first.` : "Aim to get leads into the 80+ zone by following up consistently."}`,
      suggestedActions: ["What action should I take with " + (topLead?.fullName ?? "my top lead") + "?", "Show pipeline value", "Which leads need follow-up?"],
    };
  }

  // ── follow-up / overdue ───────────────────────────────────────────────────
  if (msg.match(/follow.?up|overdue|contact|reach out|who (should|to) call/)) {
    const toFollow = (leads as any[]).filter((l) => l.status !== "won" && l.status !== "lost").slice(0, 5);
    if (toFollow.length === 0) {
      return {
        reply: "Your pipeline looks clear! No open leads need immediate follow-up.",
        suggestedActions: ["Show top-scoring leads", "Show pipeline value", "How can I improve conversion?"],
      };
    }
    const list = toFollow.map((l) => `• **${l.fullName}** (${l.company ?? "—"})`).join("\n");
    return {
      reply: `Here are leads that should be on your radar for follow-up:\n\n${list}\n\nA good rule: touch high-score leads every 2–3 days, medium-score leads weekly.`,
      suggestedActions: ["Show top-scoring leads", "How do I improve my pipeline?", "What's my total pipeline value?"],
    };
  }

  // ── pipeline value / revenue ──────────────────────────────────────────────
  if (msg.match(/pipeline|value|revenue|deal|money|\$|worth/)) {
    const stageList = (stages as any[]).map((s) => {
      const stageLeads = (leads as any[]).filter((l) => l.stageId === s.id);
      const val = stageLeads.reduce((sum: number, l: any) => sum + (l.dealValue ?? 0), 0);
      return `• **${s.name}**: ${stageLeads.length} leads${val > 0 ? ` — $${fmt(val)}` : ""}`;
    }).join("\n");

    return {
      reply: `Your current pipeline breakdown:\n\n${stageList}\n\n**Total pipeline value: $${fmt(totalValue)}**\n\n${totalValue === 0 ? "Add deal values to your leads to track revenue potential." : `Focus energy on moving leads in the Proposal and Qualified stages — that's where deals close.`}`,
      suggestedActions: ["Which leads are in Proposal?", "Show top-scoring leads", "What leads need follow-up?"],
    };
  }

  // ── conversion / improve / strategy ──────────────────────────────────────
  if (msg.match(/conver|improv|strateg|tip|advice|how (can|do|should)|best practice/)) {
    return {
      reply: `Here are the top 3 actions to improve your pipeline right now:\n\n1. **Score unscored leads** — ${unscoredLeads.length} of your leads have no AI score yet. Use the ★ button to prioritize where to spend your time.\n2. **Follow up with high-scorers** — ${highScoreLeads.length > 0 ? `You have ${highScoreLeads.length} high-priority lead${highScoreLeads.length > 1 ? "s" : ""} (80+). Reach out within 24 hours.` : "Get more leads into the 80+ zone by qualifying them on budget, authority, need, and timeline."}\n3. **Move deals forward** — Leads stall when there's no clear next step. Every conversation should end with a scheduled follow-up.`,
      suggestedActions: ["Show top-scoring leads", "What leads need follow-up?", "Show pipeline value"],
    };
  }

  // ── unscored leads ────────────────────────────────────────────────────────
  if (msg.match(/unscore|not score|score (my|all|the) lead|ai score/)) {
    return {
      reply: `You have **${unscoredLeads.length} unscored lead${unscoredLeads.length !== 1 ? "s" : ""}** out of ${leads.length} total.\n\n${unscoredLeads.length > 0 ? `Unscored: ${unscoredLeads.slice(0, 4).map((l: any) => l.fullName).join(", ")}${unscoredLeads.length > 4 ? ` and ${unscoredLeads.length - 4} more` : ""}.\n\nClick the ★ icon in the Leads table to score each one.` : "All your leads have been scored — great work!"}`,
      suggestedActions: ["Show top-scoring leads", "Which leads need follow-up?", "How can I improve conversion?"],
    };
  }

  // ── summary / activity / this week ───────────────────────────────────────
  if (msg.match(/summar|activit|this week|week|overview|status|how (am i|are we) doing/)) {
    return {
      reply: `**CRM snapshot:**\n\n• **${leads.length}** active lead${leads.length !== 1 ? "s" : ""}\n• **$${fmt(totalValue)}** total pipeline value\n• **${highScoreLeads.length}** high-priority lead${highScoreLeads.length !== 1 ? "s" : ""} (score 80+)\n• **${medScoreLeads.length}** medium-priority lead${medScoreLeads.length !== 1 ? "s" : ""} (score 60–79)\n• **${unscoredLeads.length}** unscored lead${unscoredLeads.length !== 1 ? "s" : ""}\n\n${highScoreLeads.length > 0 ? `**Priority:** Focus on ${highScoreLeads[0].fullName} — your highest-scoring lead.` : "Score your leads to get prioritization recommendations."}`,
      suggestedActions: ["Show top-scoring leads", "What leads need follow-up?", "How can I improve conversion?"],
    };
  }

  // ── count / how many ─────────────────────────────────────────────────────
  if (msg.match(/how many|count|total|number of/)) {
    return {
      reply: `You currently have **${leads.length} active lead${leads.length !== 1 ? "s" : ""}** in your CRM.\n\n• ${highScoreLeads.length} high priority (80+ score)\n• ${medScoreLeads.length} medium priority (60–79 score)\n• ${unscoredLeads.length} not yet scored\n• Pipeline value: $${fmt(totalValue)}`,
      suggestedActions: ["Show top-scoring leads", "Show pipeline breakdown", "Which leads need follow-up?"],
    };
  }

  // ── default helpful response ──────────────────────────────────────────────
  return {
    reply: `Here's what I can see in your CRM right now:\n\n• **${leads.length} active leads** with $${fmt(totalValue)} in pipeline value\n• **${highScoreLeads.length} high-priority** leads ready to close\n• **${unscoredLeads.length} leads** waiting to be scored\n\nWhat would you like to dig into?`,
    suggestedActions: ["Show me top-scoring leads", "What leads need follow-up?", "How can I improve my conversion rate?", "Summarize my pipeline value"],
  };
}

router.get("/ai/recommendations", aiRateLimiter, async (req, res): Promise<void> => {
  const ctx = getAuthContext(req)!;
  const lConds = [isNull(leadsTable.deletedAt), ...leadConditions(ctx)];

  const leads = await db.select().from(leadsTable)
    .where(and(...lConds))
    .orderBy(desc(leadsTable.createdAt)).limit(20);

  const recommendations = leads
    .filter((l) => l.aiScore !== null && l.aiScore >= 60).slice(0, 5)
    .map((lead, idx) => ({
      id: idx + 1,
      leadId: lead.id,
      leadName: lead.fullName,
      action: getRecommendedAction(lead.aiScore ?? 50),
      reason: lead.aiScoreSummary ?? `High-potential lead with score ${lead.aiScore}`,
      priority: (lead.aiScore ?? 0) >= 80 ? "high" : "medium",
    }));

  if (recommendations.length === 0) {
    const fallback = leads.slice(0, 3).map((lead, idx) => ({
      id: idx + 1, leadId: lead.id, leadName: lead.fullName,
      action: "Score this lead with AI to get personalized recommendations",
      reason: "Lead has not been AI-scored yet", priority: "low",
    }));
    res.json(fallback);
    return;
  }

  res.json(recommendations);
});

router.post("/ai/chat", aiRateLimiter, async (req, res): Promise<void> => {
  const parsed = ChatWithAiBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [leads, stages] = await Promise.all([
    db.select().from(leadsTable)
      .where(and(isNull(leadsTable.deletedAt), ...leadConditions(ctx)))
      .orderBy(desc(leadsTable.aiScore))
      .limit(50),
    db.select().from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.orgId, ctx.orgId)),
  ]);

  const crmContext = `CRM data: ${leads.length} active leads, pipeline value $${leads.reduce((s, l) => s + (l.dealValue ?? 0), 0).toLocaleString()}. Leads: ${leads.slice(0, 8)
    .map((l) => `${l.fullName} (${l.company ?? "unknown"}, score: ${l.aiScore ?? "unscored"})`).join("; ")}`;

  const ai = getOpenAI();
  if (ai) {
    try {
      const c = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are DacsStack CRM AI assistant. ${crmContext}. ${parsed.data.context ?? ""}
Respond with valid JSON only: { "reply": string, "suggestedActions": string[] }
reply should be 2-4 sentences max, actionable, specific to the data.
suggestedActions should be 3 short follow-up questions (max 8 words each).`,
          },
          { role: "user", content: parsed.data.message },
        ],
        response_format: { type: "json_object" },
        max_tokens: 500,
      });
      const r = JSON.parse(c.choices[0].message.content ?? "{}");
      res.json({ reply: r.reply, suggestedActions: r.suggestedActions ?? [] });
      return;
    } catch (err) {
      req.log.warn({ err }, "AI chat failed");
    }
  }

  // Smart rule-based fallback using real CRM data
  const fallback = await buildSmartFallback(parsed.data.message, leads as any[], stages as any[]);
  res.json(fallback);
});

export default router;
