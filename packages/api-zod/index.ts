import { z } from "zod";

// ── Health ────────────────────────────────────────────────────────────────────

export const HealthCheckResponse = z.object({
  status: z.string(),
});

// ── Leads ─────────────────────────────────────────────────────────────────────

export const ListLeadsQueryParams = z.object({
  stage: z.string().optional(),
  search: z.string().optional(),
  tag: z.string().optional(),
  assignedTo: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  followUpDue: z.union([z.boolean(), z.string()]).optional(),
  myLeads: z.union([z.boolean(), z.string()]).optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateLeadBody = z.object({
  fullName: z.string(),
  email: z.string().email(),
  company: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  dealValue: z.number().optional(),
  tags: z.array(z.string()).optional(),
  stageId: z.number().optional(),
  assignedTo: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: z.string().optional(),
});

export const GetLeadParams = z.object({
  id: z.coerce.number(),
});

export const UpdateLeadParams = z.object({
  id: z.coerce.number(),
});

export const UpdateLeadBody = z.object({
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  dealValue: z.number().optional(),
  tags: z.array(z.string()).optional(),
  assignedTo: z.string().optional(),
  notes: z.string().optional(),
  followUpAt: z.string().optional(),
});

export const DeleteLeadParams = z.object({
  id: z.coerce.number(),
});

export const UpdateLeadStageParams = z.object({
  id: z.coerce.number(),
});

export const UpdateLeadStageBody = z.object({
  stageId: z.number(),
});

export const UpdateLeadTagsParams = z.object({
  id: z.coerce.number(),
});

export const UpdateLeadTagsBody = z.object({
  tags: z.array(z.string()),
});

export const ScoreLeadParams = z.object({
  id: z.coerce.number(),
});

export const GetLeadAiSummaryParams = z.object({
  id: z.coerce.number(),
});

// ── Contacts ──────────────────────────────────────────────────────────────────

export const ListContactsQueryParams = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateContactBody = z.object({
  fullName: z.string(),
  email: z.string().email(),
  company: z.string().optional(),
});

export const GetContactParams = z.object({
  id: z.coerce.number(),
});

export const UpdateContactParams = z.object({
  id: z.coerce.number(),
});

export const UpdateContactBody = z.object({
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  company: z.string().optional(),
});

export const DeleteContactParams = z.object({
  id: z.coerce.number(),
});

// ── Pipeline Stages ───────────────────────────────────────────────────────────

export const CreatePipelineStageBody = z.object({
  name: z.string(),
  order: z.number(),
});

export const UpdatePipelineStageParams = z.object({
  id: z.coerce.number(),
});

export const UpdatePipelineStageBody = z.object({
  name: z.string().optional(),
  order: z.number().optional(),
});

export const DeletePipelineStageParams = z.object({
  id: z.coerce.number(),
});

// ── Activities ────────────────────────────────────────────────────────────────

export const ListActivitiesQueryParams = z.object({
  leadId: z.coerce.number().optional(),
  contactId: z.coerce.number().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateActivityBody = z.object({
  type: z.string(),
  description: z.string(),
  leadId: z.number(),
});

// ── Notes ─────────────────────────────────────────────────────────────────────

export const ListNotesQueryParams = z.object({
  leadId: z.coerce.number().optional(),
  contactId: z.coerce.number().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateNoteBody = z.object({
  content: z.string(),
  leadId: z.number().optional(),
  contactId: z.number().optional(),
  isPinned: z.boolean().optional(),
});

export const UpdateNoteParams = z.object({
  id: z.coerce.number(),
});

export const UpdateNoteBody = z.object({
  content: z.string().optional(),
  isPinned: z.boolean().optional(),
});

export const DeleteNoteParams = z.object({
  id: z.coerce.number(),
});

// ── Appointments ──────────────────────────────────────────────────────────────

export const ListAppointmentsQueryParams = z.object({
  leadId: z.coerce.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateAppointmentBody = z.object({
  title: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  leadId: z.number().optional(),
  assignedTo: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  notes: z.string().optional(),
});

export const UpdateAppointmentParams = z.object({
  id: z.coerce.number(),
});

export const UpdateAppointmentBody = z.object({
  title: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  notes: z.string().optional(),
  assignedTo: z.string().optional(),
});

export const DeleteAppointmentParams = z.object({
  id: z.coerce.number(),
});

// ── Notifications ─────────────────────────────────────────────────────────────

export const ListNotificationsQueryParams = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const MarkNotificationReadParams = z.object({
  id: z.coerce.number(),
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const ListTasksQueryParams = z.object({
  leadId: z.coerce.number().optional(),
  assignedTo: z.string().optional(),
  dueBefore: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const CreateTaskBody = z.object({
  title: z.string(),
  leadId: z.number().optional(),
  description: z.string().optional(),
  dueAt: z.string().optional(),
  priority: z.string().optional(),
  assignedTo: z.string().optional(),
});

export const UpdateTaskParams = z.object({
  id: z.coerce.number(),
});

export const UpdateTaskBody = z.object({
  title: z.string().optional(),
  completed: z.boolean().optional(),
  description: z.string().optional(),
  dueAt: z.string().optional(),
  priority: z.string().optional(),
  leadId: z.number().optional(),
  assignedTo: z.string().optional(),
});

export const DeleteTaskParams = z.object({
  id: z.coerce.number(),
});

// ── AI ────────────────────────────────────────────────────────────────────────

export const ChatWithAiBody = z.object({
  message: z.string(),
  context: z.string().optional(),
});

// ── Automations ───────────────────────────────────────────────────────────────

export const CreateAutomationBody = z.object({
  name: z.string(),
  trigger: z.string(),
  condition: z.string().optional(),
  action: z.string(),
});

export const UpdateAutomationParams = z.object({
  id: z.coerce.number(),
});

export const UpdateAutomationBody = z.object({
  name: z.string().optional(),
  trigger: z.string().optional(),
  condition: z.string().optional(),
  action: z.string().optional(),
});

export const DeleteAutomationParams = z.object({
  id: z.coerce.number(),
});

export const ToggleAutomationBody = z.object({
  isActive: z.boolean(),
});
