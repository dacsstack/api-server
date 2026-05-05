import { and, eq, sql } from "drizzle-orm";
import { db, automationsTable, activitiesTable, notificationsTable, leadsTable, userProfilesTable } from "@workspace/db";
import type { AuthContext } from "./auth";
import { sendDealWonEmail, sendDealLostEmail, sendLeadCreatedNotification } from "./email";
import { logger } from "./logger";

async function getActorEmail(ctx: AuthContext): Promise<string | null> {
  const [profile] = await db
    .select({ email: userProfilesTable.email })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, ctx.userId));
  return profile?.email ?? null;
}

export type AutomationTrigger =
  | "lead_created"
  | "ai_scored"
  | "stage_changed"
  | "no_activity"
  | "deal_won"
  | "deal_lost";

export interface AutomationPayload {
  lead?: typeof leadsTable.$inferSelect;
  stageName?: string;
  aiScore?: number;
}

function evalCondition(condition: string | null, payload: AutomationPayload): boolean {
  if (!condition || condition.trim() === "") return true;
  try {
    const lead = payload.lead;
    const match = condition.trim().match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
    if (!match) return true;
    const [, field, op, rawValue] = match;

    const fieldMap: Record<string, unknown> = {
      ai_score:   lead?.aiScore   ?? 0,
      deal_value: lead?.dealValue ?? 0,
      status:     lead?.status    ?? "",
      priority:   lead?.priority  ?? "",
      source:     lead?.source    ?? "",
    };

    const fieldVal = fieldMap[field];
    if (fieldVal === undefined) return true;

    const numVal = parseFloat(rawValue);
    const isNum  = !isNaN(numVal);

    switch (op) {
      case ">=": return isNum ? Number(fieldVal) >= numVal : String(fieldVal) >= rawValue;
      case "<=": return isNum ? Number(fieldVal) <= numVal : String(fieldVal) <= rawValue;
      case ">":  return isNum ? Number(fieldVal) >  numVal : String(fieldVal) >  rawValue;
      case "<":  return isNum ? Number(fieldVal) <  numVal : String(fieldVal) <  rawValue;
      case "==": return String(fieldVal) === rawValue;
      case "!=": return String(fieldVal) !== rawValue;
      default:   return true;
    }
  } catch {
    return true;
  }
}

const NOTIF_TITLES: Record<AutomationTrigger, (p: AutomationPayload) => string> = {
  lead_created:  (p) => `New Lead: ${p.lead?.fullName ?? "Unknown"}`,
  ai_scored:     (p) => `AI Score Updated: ${p.lead?.fullName ?? "Unknown"}`,
  stage_changed: (p) => `Stage Changed: ${p.lead?.fullName ?? "Unknown"}`,
  no_activity:   (p) => `No Activity: ${p.lead?.fullName ?? "Unknown"}`,
  deal_won:      (p) => `Deal Won: ${p.lead?.fullName ?? "Unknown"}`,
  deal_lost:     (p) => `Deal Lost: ${p.lead?.fullName ?? "Unknown"}`,
};

const NOTIF_MESSAGES: Record<AutomationTrigger, (p: AutomationPayload) => string> = {
  lead_created:  (p) => `New lead ${p.lead?.fullName ?? ""} was added to the pipeline.`,
  ai_scored:     (p) => `${p.lead?.fullName ?? "Lead"} received an AI score of ${p.aiScore ?? p.lead?.aiScore ?? "N/A"}.`,
  stage_changed: (p) => `${p.lead?.fullName ?? "Lead"} was moved to stage: ${p.stageName ?? "Unknown"}.`,
  no_activity:   (p) => `${p.lead?.fullName ?? "Lead"} has had no activity for an extended period.`,
  deal_won:      (p) => `${p.lead?.fullName ?? "Lead"} has been marked as Closed Won!`,
  deal_lost:     (p) => `${p.lead?.fullName ?? "Lead"} has been marked as Closed Lost.`,
};

const NOTIF_TYPES: Record<AutomationTrigger, "info" | "success" | "warning"> = {
  lead_created:  "info",
  ai_scored:     "info",
  stage_changed: "info",
  no_activity:   "warning",
  deal_won:      "success",
  deal_lost:     "warning",
};

export async function runAutomations(
  trigger: AutomationTrigger,
  payload: AutomationPayload,
  ctx: AuthContext,
): Promise<void> {
  try {
    const activeAutos = await db.select().from(automationsTable).where(
      and(
        eq(automationsTable.orgId, ctx.orgId),
        eq(automationsTable.trigger, trigger),
        eq(automationsTable.isActive, true),
      ),
    );

    if (activeAutos.length === 0) return;

    const lead = payload.lead;

    await Promise.all(activeAutos.map(async (auto) => {
      if (!evalCondition(auto.condition, payload)) return;

      try {
        switch (auto.action) {
          case "log_activity": {
            if (lead) {
              await db.insert(activitiesTable).values({
                type: trigger,
                description: `Automation "${auto.name}": ${trigger.replace(/_/g, " ")}`,
                leadId: lead.id,
                ownerId: ctx.userId,
                orgId: ctx.orgId,
                performedBy: ctx.userId,
              });
            }
            break;
          }

          case "send_notification":
          case "send_reminder": {
            await db.insert(notificationsTable).values({
              orgId: ctx.orgId,
              userId: lead?.assignedTo ?? ctx.userId,
              title:   NOTIF_TITLES[trigger](payload),
              message: NOTIF_MESSAGES[trigger](payload),
              type:    NOTIF_TYPES[trigger],
              linkedEntityType: lead ? "lead" : undefined,
              linkedEntityId:   lead ? String(lead.id) : undefined,
            });
            break;
          }

          case "send_email": {
            const actorEmail = await getActorEmail(ctx);
            if (trigger === "deal_won" && lead?.email) {
              sendDealWonEmail({ toEmail: lead.email, leadName: lead.fullName }).catch(() => {});
            } else if (trigger === "deal_lost" && lead?.email) {
              sendDealLostEmail({ toEmail: lead.email, leadName: lead.fullName }).catch(() => {});
            } else {
              sendLeadCreatedNotification(
                lead?.fullName ?? "Unknown",
                lead?.company ?? null,
                actorEmail,
              ).catch(() => {});
            }
            break;
          }

          case "update_status": {
            if (lead && trigger === "deal_won") {
              await db.update(leadsTable).set({ status: "won" }).where(eq(leadsTable.id, lead.id));
            } else if (lead && trigger === "deal_lost") {
              await db.update(leadsTable).set({ status: "lost" }).where(eq(leadsTable.id, lead.id));
            }
            break;
          }
        }

        await db.update(automationsTable)
          .set({ runCount: sql`${automationsTable.runCount} + 1` })
          .where(eq(automationsTable.id, auto.id));

        logger.info({ autoId: auto.id, trigger, action: auto.action }, "Automation executed");
      } catch (err) {
        logger.warn({ err, autoId: auto.id }, "Automation action failed");
      }
    }));
  } catch (err) {
    logger.warn({ err, trigger }, "runAutomations failed");
  }
}
