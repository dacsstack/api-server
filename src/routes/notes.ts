import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, notesTable } from "@workspace/db";
import {
  ListNotesQueryParams, CreateNoteBody,
  UpdateNoteParams, UpdateNoteBody, DeleteNoteParams,
} from "@workspace/api-zod";
import { getAuthContext, orgConditions } from "../lib/auth";

const router: IRouter = Router();

router.get("/notes", async (req, res): Promise<void> => {
  const parsed = ListNotesQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;
  const { leadId, contactId } = parsed.data;

  const conditions = [...orgConditions(ctx, notesTable)];
  if (leadId) conditions.push(eq(notesTable.leadId, leadId));
  if (contactId) conditions.push(eq(notesTable.contactId, contactId));

  const notes = await db.select().from(notesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(notesTable.createdAt));

  res.json(notes.map((n) => ({ ...n, isPinned: n.isPinned === "true" })));
});

router.post("/notes", async (req, res): Promise<void> => {
  const parsed = CreateNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [note] = await db.insert(notesTable).values({
    ...parsed.data,
    ownerId: ctx.userId,
    orgId: ctx.orgId,
    authorId: ctx.userId,
    isPinned: parsed.data.isPinned ? "true" : "false",
  }).returning();
  res.status(201).json({ ...note, isPinned: note.isPinned === "true" });
});

router.patch("/notes/:id", async (req, res): Promise<void> => {
  const params = UpdateNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const data: Record<string, unknown> = {};
  if (parsed.data.content != null) data.content = parsed.data.content;
  if (parsed.data.isPinned != null) data.isPinned = parsed.data.isPinned ? "true" : "false";

  const [note] = await db.update(notesTable).set(data)
    .where(and(eq(notesTable.id, params.data.id), ...orgConditions(ctx, notesTable)))
    .returning();

  if (!note) { res.status(404).json({ error: "Note not found" }); return; }
  res.json({ ...note, isPinned: note.isPinned === "true" });
});

router.delete("/notes/:id", async (req, res): Promise<void> => {
  const params = DeleteNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ctx = getAuthContext(req)!;

  const [note] = await db.delete(notesTable)
    .where(and(eq(notesTable.id, params.data.id), ...orgConditions(ctx, notesTable)))
    .returning();

  if (!note) { res.status(404).json({ error: "Note not found" }); return; }
  res.sendStatus(204);
});

export default router;
