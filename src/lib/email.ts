import type { Appointment } from "@workspace/db";
import { logger } from "./logger";

type Resend = { emails: { send: (opts: Record<string, unknown>) => Promise<unknown> } };

let _resend: Resend | null = null;
async function getResend(): Promise<Resend | null> {
  if (!process.env.RESEND_API_KEY) return null;
  if (_resend) return _resend;
  try {
    const { Resend: ResendClass } = await import("resend");
    _resend = new ResendClass(process.env.RESEND_API_KEY) as unknown as Resend;
    return _resend;
  } catch {
    return null;
  }
}

const FROM = "DacsStack CRM <notifications@dacsstack.com>";
const NOTIFY = "dacallos.roland@gmail.com";

function baseStyle(body: string) {
  return `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f1117;color:#e2e8f0;padding:40px;border-radius:16px;border:1px solid #1e2130;">${body}<hr style="border:none;border-top:1px solid #1e2130;margin:28px 0"/><p style="color:#374151;font-size:11px;text-align:center;">DacsStack CRM — AI-powered sales intelligence</p></div>`;
}

export async function sendAppointmentConfirmation(appt: Appointment): Promise<void> {
  const resend = await getResend();
  if (!resend) return;

  const startFormatted = new Date(appt.startAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });

  try {
    await resend.emails.send({
      from: FROM,
      to: [NOTIFY],
      subject: `Appointment Scheduled: ${appt.title}`,
      html: baseStyle(`
        <h1 style="color:#7c3aed;font-size:22px;margin-bottom:4px;">New Appointment Scheduled</h1>
        <h2 style="font-size:17px;color:#f1f5f9;margin-top:0;">${appt.title}</h2>
        ${appt.description ? `<p style="color:#94a3b8;">${appt.description}</p>` : ""}
        <div style="background:#1e2130;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:4px 0;"><strong style="color:#7c3aed;">When:</strong> ${startFormatted}</p>
          ${appt.location ? `<p style="margin:4px 0;"><strong style="color:#7c3aed;">Where:</strong> ${appt.location}</p>` : ""}
          ${appt.meetingUrl ? `<p style="margin:4px 0;"><strong style="color:#7c3aed;">Join:</strong> <a href="${appt.meetingUrl}" style="color:#818cf8;">${appt.meetingUrl}</a></p>` : ""}
        </div>
      `),
    });
    logger.info({ apptId: appt.id }, "Appointment confirmation email sent");
  } catch (err) {
    logger.warn({ err, apptId: appt.id }, "Failed to send appointment email");
  }
}

export async function sendTeamInvite(opts: {
  toEmail: string;
  invitedByName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
}): Promise<void> {
  const resend = await getResend();
  if (!resend) {
    logger.warn({}, "Resend not configured — invite email not sent");
    return;
  }

  const roleLabel = opts.role === "admin" ? "Admin" : "Agent";

  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: `You're invited to join DacsStack CRM`,
      html: baseStyle(`
        <div style="text-align:center;margin-bottom:28px;">
          <div style="display:inline-block;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);border-radius:12px;padding:10px 20px;">
            <span style="color:#7c3aed;font-weight:700;font-size:17px;">DacsStack CRM</span>
          </div>
        </div>
        <h1 style="color:#f1f5f9;font-size:22px;margin-bottom:8px;text-align:center;">You've been invited!</h1>
        <p style="color:#94a3b8;text-align:center;margin-bottom:24px;">
          <strong style="color:#e2e8f0;">${opts.invitedByName}</strong> has invited you to join their team as a <strong style="color:#818cf8;">${roleLabel}</strong>.
        </p>
        <div style="background:#1e2130;border-radius:12px;padding:20px;margin-bottom:28px;border:1px solid #2d3148;">
          <p style="margin:0 0 6px 0;color:#94a3b8;font-size:13px;">You're joining as:</p>
          <p style="margin:0;color:#e2e8f0;font-size:15px;font-weight:600;">${roleLabel} <span style="color:#64748b;font-weight:400;">· ${opts.toEmail}</span></p>
        </div>
        <div style="text-align:center;margin-bottom:24px;">
          <a href="${opts.inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-weight:600;font-size:15px;">Accept Invitation</a>
        </div>
        <p style="color:#475569;font-size:12px;text-align:center;">This invite expires in 7 days. If you didn't expect this, you can safely ignore it.</p>
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Team invite email sent");
  } catch (err) {
    logger.warn({ err, toEmail: opts.toEmail }, "Failed to send invite email");
  }
}

export async function sendLeadCreatedNotification(
  leadName: string,
  company: string | null,
  toEmail?: string | null,
): Promise<void> {
  const resend = await getResend();
  if (!resend) return;

  const recipient = toEmail ?? NOTIFY;

  try {
    await resend.emails.send({
      from: FROM,
      to: [recipient],
      subject: `New Lead: ${leadName}${company ? ` from ${company}` : ""}`,
      html: baseStyle(`
        <h1 style="color:#7c3aed;font-size:22px;margin-bottom:4px;">New Lead Added</h1>
        <h2 style="font-size:17px;color:#f1f5f9;margin-top:0;">${leadName}</h2>
        ${company ? `<p style="color:#94a3b8;">Company: ${company}</p>` : ""}
        <p style="color:#475569;font-size:13px;margin-top:16px;">This notification was sent to you because an automation rule is active on your account.</p>
      `),
    });
    logger.info({ leadName, recipient }, "Lead created email sent");
  } catch (err) {
    logger.warn({ err, leadName }, "Failed to send lead email");
  }
}

export async function sendLeadInquiryConfirmation(opts: {
  toEmail: string;
  leadName: string;
}): Promise<void> {
  const resend = await getResend();
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: `We received your inquiry — we'll be in touch soon!`,
      html: baseStyle(`
        <h1 style="color:#7c3aed;font-size:22px;margin-bottom:4px;">Thanks for reaching out, ${opts.leadName}!</h1>
        <p style="color:#94a3b8;line-height:1.6;">We've received your inquiry and a member of our team will be in touch with you shortly.</p>
        <div style="background:#1e2130;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #2d3148;">
          <p style="margin:0;color:#e2e8f0;font-size:14px;">In the meantime, feel free to book a consultation slot directly using our booking page.</p>
        </div>
        <p style="color:#64748b;font-size:13px;">If you have any urgent questions, you can reply directly to this email.</p>
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Lead inquiry confirmation sent");
  } catch (err) {
    logger.warn({ err }, "Failed to send inquiry confirmation");
  }
}

export async function sendBookingConfirmationToLead(opts: {
  toEmail: string;
  leadName: string;
  title: string;
  startAt: Date;
  endAt: Date;
  notes: string | null;
}): Promise<void> {
  const resend = await getResend();
  if (!resend) return;

  const startFormatted = opts.startAt.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
  const endFormatted = opts.endAt.toLocaleString("en-US", { timeStyle: "short" });

  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: `Appointment Confirmed: ${opts.title}`,
      html: baseStyle(`
        <h1 style="color:#7c3aed;font-size:22px;margin-bottom:4px;">Your appointment is confirmed!</h1>
        <p style="color:#94a3b8;">Hi ${opts.leadName}, here are your appointment details:</p>
        <div style="background:#1e2130;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #2d3148;">
          <h2 style="color:#f1f5f9;font-size:17px;margin:0 0 12px 0;">${opts.title}</h2>
          <p style="margin:4px 0;color:#e2e8f0;"><strong style="color:#7c3aed;">When:</strong> ${startFormatted} – ${endFormatted}</p>
          ${opts.notes ? `<p style="margin:10px 0 0 0;color:#94a3b8;font-size:13px;">${opts.notes}</p>` : ""}
        </div>
        <p style="color:#64748b;font-size:13px;">Need to reschedule? Reply to this email and we'll sort it out.</p>
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Booking confirmation sent to lead");
  } catch (err) {
    logger.warn({ err }, "Failed to send booking confirmation");
  }
}

export async function sendDealWonEmail(opts: { toEmail: string; leadName: string }): Promise<void> {
  const resend = await getResend();
  if (!resend) return;
  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: `Congratulations — Welcome aboard, ${opts.leadName}!`,
      html: baseStyle(`
        <div style="text-align:center;margin-bottom:28px;">
          <div style="font-size:48px;margin-bottom:12px;">🎉</div>
          <h1 style="color:#22c55e;font-size:24px;margin-bottom:8px;">Welcome aboard, ${opts.leadName}!</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;">We're thrilled to have you as a client. Your journey with us starts now.</p>
        </div>
        <div style="background:#1e2130;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #2d3148;">
          <p style="margin:0 0 8px 0;color:#e2e8f0;font-size:14px;">Your dedicated team will be reaching out shortly to get you onboarded and set up for success.</p>
          <p style="margin:0;color:#94a3b8;font-size:13px;">If you have any immediate questions, reply directly to this email.</p>
        </div>
        <p style="color:#64748b;font-size:12px;text-align:center;">We look forward to working together!</p>
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Deal won email sent");
  } catch (err) {
    logger.warn({ err }, "Failed to send deal won email");
  }
}

export async function sendDealLostEmail(opts: { toEmail: string; leadName: string }): Promise<void> {
  const resend = await getResend();
  if (!resend) return;
  try {
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: `Thank you for considering us, ${opts.leadName}`,
      html: baseStyle(`
        <h1 style="color:#f1f5f9;font-size:22px;margin-bottom:8px;">Thank you, ${opts.leadName}</h1>
        <p style="color:#94a3b8;line-height:1.6;">We appreciate the time you took to explore working with us. While it wasn't the right fit at this moment, we'd love to stay connected.</p>
        <div style="background:#1e2130;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #2d3148;">
          <p style="margin:0;color:#e2e8f0;font-size:14px;">If your needs change in the future, don't hesitate to reach out — we'll be here.</p>
        </div>
        <p style="color:#64748b;font-size:12px;text-align:center;">Wishing you all the best.</p>
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Deal lost email sent");
  } catch (err) {
    logger.warn({ err }, "Failed to send deal lost email");
  }
}

export async function sendEmailToLead(opts: {
  toEmail: string;
  leadName: string;
  subject: string;
  body: string;
  agentName?: string | null;
}): Promise<void> {
  const resend = await getResend();
  if (!resend) return;
  try {
    const bodyHtml = opts.body.replace(/\n/g, "<br/>");
    await resend.emails.send({
      from: FROM,
      to: [opts.toEmail],
      subject: opts.subject,
      html: baseStyle(`
        <p style="color:#94a3b8;font-size:13px;margin-bottom:20px;">Hi ${opts.leadName},</p>
        <div style="color:#e2e8f0;font-size:15px;line-height:1.7;">${bodyHtml}</div>
        ${opts.agentName ? `<p style="color:#94a3b8;font-size:13px;margin-top:24px;">Best regards,<br/><strong style="color:#e2e8f0;">${opts.agentName}</strong><br/>DacsStack CRM</p>` : ""}
      `),
    });
    logger.info({ toEmail: opts.toEmail }, "Direct email sent to lead");
  } catch (err) {
    logger.warn({ err }, "Failed to send email to lead");
  }
}
