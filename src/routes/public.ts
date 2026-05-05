import { Router, type IRouter } from "express";
import { eq, and, lt, gt } from "drizzle-orm";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db, leadsTable, appointmentsTable, userProfilesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  sendLeadInquiryConfirmation,
  sendBookingConfirmationToLead,
  sendLeadCreatedNotification,
} from "../lib/email";
import OpenAI from "openai";

// --- Cloudflare Turnstile verification ---
async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured — skip (dev/pre-launch mode)
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

const router: IRouter = Router();

// --- Rate limiters ---

const orgLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions from this IP. Please try again in an hour." },
});

const bookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many booking attempts from this IP. Please try again in an hour." },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Chat limit reached. Please try again later." },
});

// --- OpenAI ---

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// GET /api/public/org/:orgId — org branding for the public booking page
router.get("/public/org/:orgId", orgLookupLimiter, async (req, res): Promise<void> => {
  const { orgId } = req.params;
  if (!orgId) { res.status(400).json({ error: "Missing orgId" }); return; }

  const [admin] = await db
    .select({ fullName: userProfilesTable.fullName, orgId: userProfilesTable.orgId })
    .from(userProfilesTable)
    .where(and(eq(userProfilesTable.orgId, orgId), eq(userProfilesTable.role, "admin")))
    .limit(1);

  if (!admin) {
    const [any] = await db
      .select({ fullName: userProfilesTable.fullName, orgId: userProfilesTable.orgId })
      .from(userProfilesTable)
      .where(eq(userProfilesTable.orgId, orgId))
      .limit(1);
    if (!any) { res.status(404).json({ error: "Organization not found" }); return; }
    res.json({ orgId: any.orgId, orgName: any.fullName ?? "Our Team" });
    return;
  }

  res.json({ orgId: admin.orgId, orgName: admin.fullName ?? "Our Team" });
});

const UtmFields = z.object({
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(200).optional(),
  utmContent: z.string().max(200).optional(),
  utmTerm: z.string().max(200).optional(),
});

// POST /api/public/inquiry — submit a lead inquiry (no auth)
const InquiryBody = z.object({
  orgId: z.string().min(1).max(100),
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(254),
  phone: z.string().max(50).optional(),
  company: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
  captchaToken: z.string().optional(),
}).merge(UtmFields);

router.post("/public/inquiry", inquiryLimiter, async (req, res): Promise<void> => {
  const parsed = InquiryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { orgId, fullName, email, phone, company, message, captchaToken,
          utmSource, utmMedium, utmCampaign, utmContent, utmTerm } = parsed.data;

  // Verify Turnstile CAPTCHA (skipped if TURNSTILE_SECRET_KEY is not configured)
  const captchaOk = await verifyTurnstile(captchaToken ?? "", req.ip);
  if (!captchaOk) {
    res.status(403).json({ error: "CAPTCHA verification failed. Please refresh and try again." });
    return;
  }

  const [orgAdmin] = await db
    .select({ userId: userProfilesTable.userId })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.orgId, orgId))
    .limit(1);

  if (!orgAdmin) { res.status(404).json({ error: "Organization not found" }); return; }

  const [lead] = await db.insert(leadsTable).values({
    orgId,
    ownerId: orgAdmin.userId,
    fullName,
    email,
    phone: phone ?? null,
    company: company ?? null,
    notes: message ?? null,
    source: utmSource ? `${utmSource}${utmMedium ? `/${utmMedium}` : ""}` : "public_inquiry",
    status: "active",
    assignedTo: orgAdmin.userId,
    utmSource: utmSource ?? null,
    utmMedium: utmMedium ?? null,
    utmCampaign: utmCampaign ?? null,
    utmContent: utmContent ?? null,
    utmTerm: utmTerm ?? null,
  }).returning();

  sendLeadCreatedNotification(fullName, company ?? null).catch(() => {});
  sendLeadInquiryConfirmation({ toEmail: email, leadName: fullName }).catch(() => {});

  logger.info({ leadId: lead.id, orgId, utmSource, utmCampaign }, "Public inquiry submitted");
  res.status(201).json({ ok: true, leadId: lead.id });
});

// POST /api/public/book — book an appointment (no auth)
const BookBody = z.object({
  orgId: z.string().min(1).max(100),
  leadId: z.number().int().optional(),
  leadName: z.string().min(1).max(200),
  leadEmail: z.string().email().max(254),
  title: z.string().min(1).max(300),
  startAt: z.string(),
  endAt: z.string(),
  notes: z.string().max(2000).optional(),
}).merge(UtmFields);

router.post("/public/book", bookLimiter, async (req, res): Promise<void> => {
  const parsed = BookBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { orgId, leadId, leadName, leadEmail, title, startAt, endAt, notes,
          utmSource, utmMedium, utmCampaign, utmContent, utmTerm } = parsed.data;

  const [orgAdmin] = await db
    .select({ userId: userProfilesTable.userId })
    .from(userProfilesTable)
    .where(eq(userProfilesTable.orgId, orgId))
    .limit(1);

  if (!orgAdmin) { res.status(404).json({ error: "Organization not found" }); return; }

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    res.status(400).json({ error: "Invalid date range." });
    return;
  }

  // Check for an overlapping appointment in this org's calendar
  const [conflict] = await db
    .select({ id: appointmentsTable.id })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.orgId, orgId),
        lt(appointmentsTable.startAt, endDate),
        gt(appointmentsTable.endAt, startDate),
      )
    )
    .limit(1);

  if (conflict) {
    res.status(409).json({ error: "That time slot is already booked. Please choose a different time." });
    return;
  }

  let resolvedLeadId: number = leadId ?? 0;

  if (!leadId) {
    const [existing] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, orgId), eq(leadsTable.email, leadEmail)))
      .limit(1);

    if (existing) {
      resolvedLeadId = existing.id;
    } else {
      const [newLead] = await db.insert(leadsTable).values({
        orgId,
        ownerId: orgAdmin.userId,
        fullName: leadName,
        email: leadEmail,
        source: utmSource ? `${utmSource}${utmMedium ? `/${utmMedium}` : ""}` : "public_booking",
        status: "active",
        assignedTo: orgAdmin.userId,
        utmSource: utmSource ?? null,
        utmMedium: utmMedium ?? null,
        utmCampaign: utmCampaign ?? null,
        utmContent: utmContent ?? null,
        utmTerm: utmTerm ?? null,
      }).returning();
      resolvedLeadId = newLead.id;
      sendLeadCreatedNotification(leadName, null).catch(() => {});
    }
  }

  const [appt] = await db.insert(appointmentsTable).values({
    orgId,
    ownerId: orgAdmin.userId,
    title,
    description: notes ?? null,
    leadId: resolvedLeadId,
    startAt: startDate,
    endAt: endDate,
    status: "scheduled",
  }).returning();

  sendBookingConfirmationToLead({
    toEmail: leadEmail,
    leadName,
    title,
    startAt: startDate,
    endAt: endDate,
    notes: notes ?? null,
  }).catch(() => {});

  logger.info({ apptId: appt.id, orgId, leadId: resolvedLeadId }, "Public appointment booked");
  res.status(201).json({ ok: true, appointmentId: appt.id, leadId: resolvedLeadId });
});

// POST /api/public/chat — AI chatbot for pre-sales (no auth)
const ChatBody = z.object({
  orgId: z.string().min(1).max(100),
  orgName: z.string().max(200).optional(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(1000),
  })).min(1).max(20),
});

router.post("/public/chat", chatLimiter, async (req, res): Promise<void> => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { orgName, messages } = parsed.data;

  const openai = getOpenAI();
  if (!openai) {
    res.json({ reply: "Hi! I'm here to help you get started. Fill out the form below and our team will be in touch shortly." });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `You are a friendly and professional sales assistant for ${orgName ?? "our team"}. Your job is to warmly greet visitors, answer questions about our services, and encourage them to submit their contact information or book a consultation. Be concise, helpful, and conversational. Keep responses under 3 sentences.`,
        },
        ...messages,
      ],
    });

    const reply = completion.choices[0]?.message?.content ?? "I'm here to help! Fill out the form below to get started.";
    res.json({ reply });
  } catch (err) {
    logger.warn({ err }, "Public chat AI error");
    res.json({ reply: "I'm here to help! Please fill out the form below and our team will reach out to you shortly." });
  }
});

export default router;
