import { Router, type IRouter } from "express";
import { eq, ilike, or, sql, desc, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, contactsTable, userProfilesTable } from "@workspace/db";
import {
  ListContactsQueryParams, CreateContactBody, GetContactParams,
  UpdateContactParams, UpdateContactBody, DeleteContactParams,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";

const router: IRouter = Router();
const creatorProfile = alias(userProfilesTable, "creator_profile");

/** Returns base conditions for a contact query.
 *  Admins/super-admins see all contacts in the org.
 *  Agents only see contacts they personally created. */
function contactConditions(ctx: ReturnType<typeof getAuthContext> & object) {
  const conditions = [...orgConditions(ctx, contactsTable)];
  if (ctx.role === "agent") {
    conditions.push(eq(contactsTable.ownerId, ctx.userId));
  }
  return conditions;
}

router.get("/contacts", async (req, res): Promise<void> => {
  const parsed = ListContactsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { search, limit, offset } = parsed.data;

  const conditions = [...contactConditions(ctx)];
  if (search) {
    conditions.push(or(
      ilike(contactsTable.fullName, `%${search}%`),
      ilike(contactsTable.email, `%${search}%`),
      ilike(contactsTable.company, `%${search}%`),
    )!);
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({ contact: contactsTable, createdByName: creatorProfile.fullName })
    .from(contactsTable)
    .leftJoin(creatorProfile, eq(contactsTable.ownerId, creatorProfile.userId))
    .where(whereClause)
    .orderBy(desc(contactsTable.createdAt)).limit(limit).offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contactsTable)
    .where(whereClause);

  res.json({
    contacts: rows.map((r) => ({ ...r.contact, createdByName: r.createdByName ?? null })),
    total: count,
  });
});

router.post("/contacts", async (req, res): Promise<void> => {
  const parsed = CreateContactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [contact] = await db.insert(contactsTable)
    .values({ ...parsed.data, ownerId: ctx.userId, orgId: ctx.orgId })
    .returning();

  const [profile] = await db
    .select({ fullName: userProfilesTable.fullName })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, ctx.userId));

  res.status(201).json({ ...contact, createdByName: profile?.fullName ?? null });
});

router.get("/contacts/:id", async (req, res): Promise<void> => {
  const params = GetContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [row] = await db
    .select({ contact: contactsTable, createdByName: creatorProfile.fullName })
    .from(contactsTable)
    .leftJoin(creatorProfile, eq(contactsTable.ownerId, creatorProfile.userId))
    .where(and(eq(contactsTable.id, params.data.id), ...contactConditions(ctx)));

  if (!row) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json({ ...row.contact, createdByName: row.createdByName ?? null });
});

router.patch("/contacts/:id", async (req, res): Promise<void> => {
  const params = UpdateContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateContactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [contact] = await db.update(contactsTable).set(parsed.data)
    .where(and(eq(contactsTable.id, params.data.id), ...contactConditions(ctx)))
    .returning();

  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

  const [profile] = await db
    .select({ fullName: userProfilesTable.fullName })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.userId, contact.ownerId!));

  res.json({ ...contact, createdByName: profile?.fullName ?? null });
});

router.delete("/contacts/:id", async (req, res): Promise<void> => {
  const params = DeleteContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [contact] = await db.delete(contactsTable)
    .where(and(eq(contactsTable.id, params.data.id), ...contactConditions(ctx)))
    .returning();

  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.sendStatus(204);
});

export default router;
