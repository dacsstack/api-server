import { drizzle } from "drizzle-orm/node-postgres";
import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  json,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "admin",
  "agent",
]);

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);

export const leadPriorityEnum = pgEnum("lead_priority", [
  "low",
  "medium",
  "high",
]);

export const automationTriggerEnum = pgEnum("automation_trigger", [
  "lead_created",
  "ai_scored",
  "stage_changed",
  "no_activity",
  "deal_won",
  "deal_lost",
]);

export const automationActionEnum = pgEnum("automation_action", [
  "log_activity",
  "send_notification",
  "send_reminder",
  "send_email",
  "update_status",
]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "info",
  "success",
  "warning",
]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const userProfilesTable = pgTable("user_profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull().unique(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 255 }),
  role: varchar("role", { length: 50 }).notNull().default("agent"),
  avatarUrl: varchar("avatar_url", { length: 1024 }),
  passwordHash: varchar("password_hash", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pipelineStagesTable = pgTable("pipeline_stages", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  order: integer("order").notNull().default(0),
  color: varchar("color", { length: 50 }),
  ownerId: varchar("owner_id", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  title: varchar("title", { length: 255 }),
  source: varchar("source", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default("new"),
  priority: varchar("priority", { length: 50 }).notNull().default("medium"),
  dealValue: integer("deal_value"),
  tags: text("tags").array(),
  stageId: integer("stage_id").references(() => pipelineStagesTable.id),
  assignedTo: varchar("assigned_to", { length: 255 }).references(
    () => userProfilesTable.userId,
  ),
  ownerId: varchar("owner_id", { length: 255 }),
  notes: text("notes"),
  followUpAt: timestamp("follow_up_at"),
  deletedAt: timestamp("deleted_at"),
  aiScore: integer("ai_score"),
  aiScoreSummary: text("ai_score_summary"),
  aiScoreBreakdown: text("ai_score_breakdown"),
  aiNextAction: text("ai_next_action"),
  aiScoredAt: timestamp("ai_scored_at"),
  utmSource: varchar("utm_source", { length: 255 }),
  utmMedium: varchar("utm_medium", { length: 255 }),
  utmCampaign: varchar("utm_campaign", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  ownerId: varchar("owner_id", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const activitiesTable = pgTable("activities", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 100 }).notNull(),
  description: text("description"),
  leadId: integer("lead_id"),
  contactId: integer("contact_id"),
  ownerId: varchar("owner_id", { length: 255 }),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  performedBy: varchar("performed_by", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const appointmentsTable = pgTable("appointments", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  leadId: integer("lead_id"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  location: varchar("location", { length: 500 }),
  meetingUrl: varchar("meeting_url", { length: 1024 }),
  notes: text("notes"),
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),
  assignedTo: varchar("assigned_to", { length: 255 }),
  ownerId: varchar("owner_id", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const automationsTable = pgTable("automations", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  trigger: varchar("trigger", { length: 100 }).notNull(),
  condition: text("condition"),
  action: varchar("action", { length: 100 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ownerId: varchar("owner_id", { length: 255 }),
  runCount: integer("run_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitationsTable = pgTable("invitations", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull().default("agent"),
  token: varchar("token", { length: 255 }).notNull().unique(),
  invitedBy: varchar("invited_by", { length: 255 }),
  invitedByName: varchar("invited_by_name", { length: 255 }),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const notesTable = pgTable("notes", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id"),
  contactId: integer("contact_id"),
  content: text("content").notNull(),
  ownerId: varchar("owner_id", { length: 255 }),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  authorId: varchar("author_id", { length: 255 }),
  isPinned: varchar("is_pinned", { length: 10 }).default("false"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  type: varchar("type", { length: 50 }).notNull().default("info"),
  linkedEntityType: varchar("linked_entity_type", { length: 100 }),
  linkedEntityId: varchar("linked_entity_id", { length: 255 }),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  dueAt: timestamp("due_at"),
  priority: varchar("priority", { length: 50 }).notNull().default("medium"),
  assignedTo: varchar("assigned_to", { length: 255 }),
  ownerId: varchar("owner_id", { length: 255 }),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Type exports ─────────────────────────────────────────────────────────────

export type Appointment = typeof appointmentsTable.$inferSelect;
export type Lead = typeof leadsTable.$inferSelect;
export type Contact = typeof contactsTable.$inferSelect;
export type Activity = typeof activitiesTable.$inferSelect;
export type UserProfile = typeof userProfilesTable.$inferSelect;
export type Note = typeof notesTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type Task = typeof tasksTable.$inferSelect;
export type PipelineStage = typeof pipelineStagesTable.$inferSelect;
export type Automation = typeof automationsTable.$inferSelect;
export type Invitation = typeof invitationsTable.$inferSelect;

// ── Database connection ───────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const db = drizzle(process.env.DATABASE_URL);
