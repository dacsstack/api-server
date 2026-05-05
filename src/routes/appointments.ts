import { Router, type IRouter } from "express";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, appointmentsTable, leadsTable, userProfilesTable } from "@workspace/db";
import {
  ListAppointmentsQueryParams, CreateAppointmentBody,
  UpdateAppointmentParams, UpdateAppointmentBody, DeleteAppointmentParams,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";
import { sendAppointmentConfirmation } from "../lib/email";

const router: IRouter = Router();

const assigneeProfile = alias(userProfilesTable, "assignee_profile");

router.get("/appointments", async (req, res): Promise<void> => {
  const parsed = ListAppointmentsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { leadId, from, to } = parsed.data;

  const conditions = [...orgConditions(ctx, appointmentsTable)];

  // Agents only see appointments assigned to them
  if (ctx.role === "agent") {
    conditions.push(eq(appointmentsTable.assignedTo, ctx.userId));
  }

  if (leadId) conditions.push(eq(appointmentsTable.leadId, leadId));
  if (from) conditions.push(gte(appointmentsTable.startAt, new Date(from)));
  if (to) conditions.push(lte(appointmentsTable.endAt, new Date(to)));

  const rows = await db
    .select({
      appt: appointmentsTable,
      leadName: leadsTable.fullName,
      assignedToName: assigneeProfile.fullName,
    })
    .from(appointmentsTable)
    .leftJoin(leadsTable, eq(appointmentsTable.leadId, leadsTable.id))
    .leftJoin(assigneeProfile, eq(appointmentsTable.assignedTo, assigneeProfile.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(appointmentsTable.startAt));

  res.json(rows.map((r) => ({
    ...r.appt,
    leadName: r.leadName ?? null,
    assignedToName: r.assignedToName ?? null,
  })));
});

router.post("/appointments", async (req, res): Promise<void> => {
  const parsed = CreateAppointmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  // Agents always assign to themselves; admins can specify a target agent
  const assignedTo = ctx.role === "agent"
    ? ctx.userId
    : (parsed.data.assignedTo ?? ctx.userId);

  const [appt] = await db.insert(appointmentsTable).values({
    ...parsed.data,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    assignedTo,
    startAt: new Date(parsed.data.startAt),
    endAt: new Date(parsed.data.endAt),
  }).returning();

  // Fetch assignedToName for response
  const [assigneeRow] = await db
    .select({ fullName: userProfilesTable.fullName })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, assignedTo));

  sendAppointmentConfirmation(appt).catch(() => {});
  res.status(201).json({ ...appt, leadName: null, assignedToName: assigneeRow?.fullName ?? null });
});

router.patch("/appointments/:id", async (req, res): Promise<void> => {
  const params = UpdateAppointmentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateAppointmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.startAt) data.startAt = new Date(parsed.data.startAt);
  if (parsed.data.endAt) data.endAt = new Date(parsed.data.endAt);

  // Handle assignedTo explicitly (may arrive from quick-assign)
  if (Object.prototype.hasOwnProperty.call(req.body, "assignedTo")) {
    data.assignedTo = req.body.assignedTo ?? null;
  }

  // Handle notes explicitly
  if (Object.prototype.hasOwnProperty.call(req.body, "notes")) {
    data.notes = req.body.notes ?? null;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const updateConditions = [...orgConditions(ctx, appointmentsTable), eq(appointmentsTable.id, params.data.id)];
  // Agents can only update appointments assigned to them
  if (ctx.role === "agent") {
    updateConditions.push(eq(appointmentsTable.assignedTo, ctx.userId));
  }

  const [appt] = await db.update(appointmentsTable).set(data)
    .where(and(...updateConditions))
    .returning();

  if (!appt) { res.status(404).json({ error: "Appointment not found" }); return; }

  const [row] = await db
    .select({
      appt: appointmentsTable,
      leadName: leadsTable.fullName,
      assignedToName: assigneeProfile.fullName,
    })
    .from(appointmentsTable)
    .leftJoin(leadsTable, eq(appointmentsTable.leadId, leadsTable.id))
    .leftJoin(assigneeProfile, eq(appointmentsTable.assignedTo, assigneeProfile.userId))
    .where(eq(appointmentsTable.id, params.data.id));

  res.json({ ...row.appt, leadName: row.leadName ?? null, assignedToName: row.assignedToName ?? null });
});

router.delete("/appointments/:id", async (req, res): Promise<void> => {
  const params = DeleteAppointmentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [appt] = await db.delete(appointmentsTable)
    .where(and(eq(appointmentsTable.id, params.data.id), ...orgConditions(ctx, appointmentsTable)))
    .returning();

  if (!appt) { res.status(404).json({ error: "Appointment not found" }); return; }
  res.sendStatus(204);
});

export default router;
