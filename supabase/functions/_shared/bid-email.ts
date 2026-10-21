// Every email the Vendor Portal / Bid Invites send, in English and Spanish.
// The design is Coleby's "Bid Letter.html" (blue banner, logo, numbered
// details block, dark call-to-action box, footer), with every style inlined
// because most email clients drop <style> blocks.
//
// Bid emails have one button -- "View Invite & Bid" -- which signs the
// vendor straight into the Vendor Portal (see vendor-auth: invite_login).

import { COMPANY_NAME, escapeHtml, formatMoney } from "./bid-common.ts";
import { type Lang, PORTAL_URL } from "./vendor-common.ts";

const LOGO_URL = Deno.env.get("BID_EMAIL_LOGO_URL")
  || "https://mcusercontent.com/4aafb810487cfbd8b27c5065f/images/c495ee80-60b2-0cc2-671e-629ebcb808de.png";

const BLUE = "#2a7fc1";
const BLUE_DARK = "#1a5f96";
const INK = "#111314";
const BODY = "#3a3a3a";
const FONT = "'Inter', Arial, Helvetica, sans-serif";
const SERIF = "'Playfair Display', Georgia, serif";
const TZ = "America/New_York";

export interface BidPackageForEmail {
  name: string;
  scope: string | null;
  location: string | null;
  due_at: string;
  walkthrough_at: string | null;
  walkthrough_location: string | null;
  questions_due_at: string | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  project_name: string;
}

export interface InviteForEmail {
  token: string;
  company_name: string;
  contact_name: string | null;
  bid_amount?: number | string | null;
}

export type BidEmailKind = "invite" | "reminder_no_response" | "reminder_due" | "awarded" | "not_selected" | "coi_request";

export interface Rendered { subject: string; html: string; text: string }

// ---------------------------------------------------------------------------
// Dates in the reader's language, Eastern time.
// ---------------------------------------------------------------------------

export function formatWhen(iso: string | null | undefined, lng: Lang = "en"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const locale = lng === "es" ? "es-US" : "en-US";
  const date = d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: TZ });
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone: TZ });
  return lng === "es" ? `${date}, ${time}` : `${date} at ${time}`;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const S = {
  en: {
    footerBid: "You're receiving this because The Leeward Group invited your company to bid.",
    footerPortal: "You're receiving this because of your company's Leeward Vendor Portal account.",
    rights: "All Rights Reserved.",
    tagline: "Construction &amp; Development",
    bannerInvite: "Invitation to Bid",
    bannerReminder: "Reminder · Invitation to Bid",
    bannerAward: "Bid Award",
    bannerResults: "Bid Results",
    subjInvite: (p: string, n: string) => `Invitation to Bid – ${p} – ${n}`,
    subjRemindDue: (when: string, p: string, n: string) => `Reminder: Bids due ${when} – ${p} – ${n}`,
    subjRemindNo: (p: string, n: string) => `Reminder: Invitation to Bid – ${p} – ${n}`,
    subjAward: (p: string, n: string) => `Bid Award – ${p} – ${n}`,
    subjResults: (p: string, n: string) => `Bid Results – ${p} – ${n}`,
    introInvite: (c: string, n: string, p: string) => `We are pleased to invite <b>${c}</b> to submit a bid for <b>${n}</b> on <b>${p}</b>.`,
    introDue: (n: string, p: string, when: string) => `A friendly reminder that bids for <b>${n}</b> on <b>${p}</b> are due <b>${when}</b>.`,
    introNo: (c: string, n: string, p: string) => `Just following up on our invitation for <b>${c}</b> to bid on <b>${n}</b> for <b>${p}</b>. Please let us know if you plan to bid.`,
    scope: "Scope of work:",
    review: "Please review the details below:",
    detailsHead: "Project scope, plans, and specifications",
    dueLabel: "Bid Due Date:",
    walkLabel: "Pre-Bid Site Walkthrough:",
    locLabel: "Location:",
    contactLabel: "Contact Person:",
    name: "Name", email: "Email", phone: "Phone",
    plansNote: (count: number) => count === 1 ? "1 plan/spec file is attached to this invite in the Vendor Portal." : `${count} plan/spec files are attached to this invite in the Vendor Portal.`,
    ctaLabelInvite: "Ready to bid?",
    ctaLabelRemind: "Are you bidding?",
    ctaButton: "View Invite &amp; Bid",
    ctaNote: (when: string) => `Signs you in to the Leeward Vendor Portal — no password needed. Download the plans, tell us if you're bidding, and upload your proposal there by <b>${when}</b>.`,
    questionsBy: (who: string, when: string) => `Should you have any questions or require clarification, please send all inquiries to ${who} no later than <b>${when}</b>.`,
    questionsReply: (who: string) => `Questions? Just reply to this email and ${who} will get back to you.`,
    appreciate: "We appreciate your interest in working with us and look forward to reviewing your proposal.",
    awardBody: (c: string, n: string, p: string, amount: string) => `Congratulations — we're pleased to let you know that <b>${c}</b> has been selected for <b>${n}</b> on <b>${p}</b>${amount ? ` at your bid of <b>${amount}</b>` : ""}.`,
    awardNext: (who: string) => `${who} will be in touch shortly with next steps. If you have any questions in the meantime, just reply to this email.`,
    bannerCoi: "COI Needed",
    subjCoi: (p: string, n: string) => `COI needed – ${p} – ${n}`,
    coiIntro: (c: string, n: string, p: string) => `Before work starts on <b>${n}</b> at <b>${p}</b>, we need a current Certificate of Insurance (COI) for <b>${c}</b>.`,
    coiAsk: "Please upload your COI as a PDF in this project's folder in the Leeward Vendor Portal. It must be current and list the coverage required for this project.",
    coiLabel: "Upload your COI",
    coiButton: "Upload COI",
    coiNote: "Signs you in to the Leeward Vendor Portal — no password needed. Questions about coverage? Just reply to this email.",
    textCoi: "Upload your COI:",
    resultsBody: (n: string, p: string) => `Thank you for submitting a bid for <b>${n}</b> on <b>${p}</b>. After careful review, we've selected another company for this scope.`,
    resultsThanks: "We appreciate the time you put into your proposal and hope to work with you on a future project.",
    textButton: "View the invite and bid:",
    // portal emails
    bannerSignIn: "Vendor Portal Sign-In",
    subjSignIn: "Your Leeward Vendor Portal sign-in link",
    signInBody: "Use the button below to sign in to the Leeward Vendor Portal. No password needed.",
    signInButton: "Sign In",
    signInNote: (m: number) => `This link works once and expires in ${m} minutes. If you didn't ask to sign in, you can ignore this email.`,
    bannerReceived: "Request Received",
    subjReceived: "We received your Vendor Portal access request",
    receivedBody: (c: string) => `Thank you — we received the Vendor Portal access request for <b>${c}</b>. The Leeward Group reviews every request; please allow 24–48 hours. We'll email you as soon as you're approved.`,
    receivedButtonNote: "You can sign in any time to check on your request:",
    bannerApproved: "You're Approved",
    subjApproved: "You're approved — welcome to the Leeward Vendor Portal",
    approvedBody: (c: string) => `Good news — <b>${c}</b> has been approved as a Leeward Group vendor. You can now sign in to the Vendor Portal to see bid invites, submit bids, keep your company information current, and add your team.`,
    approvedNote: (h: number) => `This sign-in link works once and expires in ${h} hours. After that, sign in any time at the Vendor Portal with this email address.`,
    bannerRejected: "Request Update",
    subjRejected: "Your Vendor Portal access request",
    rejectedBody: (c: string) => `Thank you for your interest in working with The Leeward Group. We aren't able to approve the Vendor Portal access request for <b>${c}</b> at this time.`,
    rejectedReason: "Note from our team:",
    rejectedContact: "If you have questions, please contact The Leeward Group at 910-524-5130 or Info@theleewardgroup.us.",
    bannerTeam: "You've Been Added",
    subjTeam: (c: string) => `You've been added to ${c} on the Leeward Vendor Portal`,
    teamBody: (who: string, c: string) => `${who} added you to <b>${c}</b>'s account on the Leeward Vendor Portal, where you can see bid invites from The Leeward Group and submit bids.`,
    hello: (n: string) => `${n},`,
  },
  es: {
    footerBid: "Recibe este correo porque The Leeward Group invitó a su empresa a presentar una oferta.",
    footerPortal: "Recibe este correo por la cuenta de su empresa en el Portal de Proveedores de Leeward.",
    rights: "Todos los derechos reservados.",
    tagline: "Construcción y Desarrollo",
    bannerInvite: "Invitación a Ofertar",
    bannerReminder: "Recordatorio · Invitación a Ofertar",
    bannerAward: "Adjudicación de Oferta",
    bannerResults: "Resultado de la Oferta",
    subjInvite: (p: string, n: string) => `Invitación a Ofertar – ${p} – ${n}`,
    subjRemindDue: (when: string, p: string, n: string) => `Recordatorio: las ofertas vencen ${when} – ${p} – ${n}`,
    subjRemindNo: (p: string, n: string) => `Recordatorio: Invitación a Ofertar – ${p} – ${n}`,
    subjAward: (p: string, n: string) => `Adjudicación de Oferta – ${p} – ${n}`,
    subjResults: (p: string, n: string) => `Resultado de la Oferta – ${p} – ${n}`,
    introInvite: (c: string, n: string, p: string) => `Nos complace invitar a <b>${c}</b> a presentar una oferta para <b>${n}</b> en <b>${p}</b>.`,
    introDue: (n: string, p: string, when: string) => `Le recordamos que las ofertas para <b>${n}</b> en <b>${p}</b> vencen el <b>${when}</b>.`,
    introNo: (c: string, n: string, p: string) => `Damos seguimiento a nuestra invitación para que <b>${c}</b> presente una oferta para <b>${n}</b> en <b>${p}</b>. Por favor, avísenos si piensa ofertar.`,
    scope: "Alcance del trabajo:",
    review: "Por favor, revise los detalles a continuación:",
    detailsHead: "Alcance, planos y especificaciones del proyecto",
    dueLabel: "Fecha límite de la oferta:",
    walkLabel: "Visita al sitio previa a la oferta:",
    locLabel: "Ubicación:",
    contactLabel: "Persona de contacto:",
    name: "Nombre", email: "Correo", phone: "Teléfono",
    plansNote: (count: number) => count === 1 ? "Hay 1 archivo de planos/especificaciones en esta invitación en el Portal de Proveedores." : `Hay ${count} archivos de planos/especificaciones en esta invitación en el Portal de Proveedores.`,
    ctaLabelInvite: "¿Listo para ofertar?",
    ctaLabelRemind: "¿Va a ofertar?",
    ctaButton: "Ver Invitación y Ofertar",
    ctaNote: (when: string) => `Inicia su sesión en el Portal de Proveedores de Leeward, sin contraseña. Descargue los planos, indíquenos si va a ofertar y suba su propuesta allí antes del <b>${when}</b>.`,
    questionsBy: (who: string, when: string) => `Si tiene preguntas o necesita aclaraciones, envíelas a ${who} a más tardar el <b>${when}</b>.`,
    questionsReply: (who: string) => `¿Preguntas? Responda a este correo y ${who} se comunicará con usted.`,
    appreciate: "Agradecemos su interés en trabajar con nosotros y esperamos revisar su propuesta.",
    awardBody: (c: string, n: string, p: string, amount: string) => `¡Felicidades! Nos complace informarle que <b>${c}</b> fue seleccionada para <b>${n}</b> en <b>${p}</b>${amount ? ` con su oferta de <b>${amount}</b>` : ""}.`,
    awardNext: (who: string) => `${who} se comunicará pronto con los siguientes pasos. Si tiene preguntas mientras tanto, responda a este correo.`,
    bannerCoi: "Se Necesita su COI",
    subjCoi: (p: string, n: string) => `Se necesita su COI – ${p} – ${n}`,
    coiIntro: (c: string, n: string, p: string) => `Antes de comenzar el trabajo de <b>${n}</b> en <b>${p}</b>, necesitamos un Certificado de Seguro (COI) vigente de <b>${c}</b>.`,
    coiAsk: "Suba su COI en formato PDF en la carpeta de este proyecto en el Portal de Proveedores de Leeward. Debe estar vigente e incluir la cobertura requerida para este proyecto.",
    coiLabel: "Suba su COI",
    coiButton: "Subir COI",
    coiNote: "Inicia su sesión en el Portal de Proveedores de Leeward; no necesita contraseña. ¿Preguntas sobre la cobertura? Responda a este correo.",
    textCoi: "Suba su COI:",
    resultsBody: (n: string, p: string) => `Gracias por presentar una oferta para <b>${n}</b> en <b>${p}</b>. Después de una revisión cuidadosa, seleccionamos a otra empresa para este alcance.`,
    resultsThanks: "Agradecemos el tiempo dedicado a su propuesta y esperamos trabajar con usted en un proyecto futuro.",
    textButton: "Ver la invitación y ofertar:",
    bannerSignIn: "Inicio de Sesión del Portal",
    subjSignIn: "Su enlace para iniciar sesión en el Portal de Proveedores de Leeward",
    signInBody: "Use el botón de abajo para iniciar sesión en el Portal de Proveedores de Leeward. No necesita contraseña.",
    signInButton: "Iniciar Sesión",
    signInNote: (m: number) => `Este enlace funciona una sola vez y vence en ${m} minutos. Si usted no pidió iniciar sesión, puede ignorar este correo.`,
    bannerReceived: "Solicitud Recibida",
    subjReceived: "Recibimos su solicitud de acceso al Portal de Proveedores",
    receivedBody: (c: string) => `Gracias, recibimos la solicitud de acceso al Portal de Proveedores para <b>${c}</b>. The Leeward Group revisa cada solicitud; por favor espere de 24 a 48 horas. Le enviaremos un correo en cuanto sea aprobada.`,
    receivedButtonNote: "Puede iniciar sesión en cualquier momento para ver el estado de su solicitud:",
    bannerApproved: "Solicitud Aprobada",
    subjApproved: "Su solicitud fue aprobada: bienvenido al Portal de Proveedores de Leeward",
    approvedBody: (c: string) => `Buenas noticias: <b>${c}</b> fue aprobada como proveedor de The Leeward Group. Ya puede iniciar sesión en el Portal de Proveedores para ver invitaciones a ofertar, presentar ofertas, mantener al día la información de su empresa y agregar a su equipo.`,
    approvedNote: (h: number) => `Este enlace funciona una sola vez y vence en ${h} horas. Después, puede iniciar sesión en cualquier momento en el Portal de Proveedores con este correo.`,
    bannerRejected: "Actualización de su Solicitud",
    subjRejected: "Su solicitud de acceso al Portal de Proveedores",
    rejectedBody: (c: string) => `Gracias por su interés en trabajar con The Leeward Group. Por ahora no podemos aprobar la solicitud de acceso al Portal de Proveedores para <b>${c}</b>.`,
    rejectedReason: "Nota de nuestro equipo:",
    rejectedContact: "Si tiene preguntas, comuníquese con The Leeward Group al 910-524-5130 o Info@theleewardgroup.us.",
    bannerTeam: "Fue Agregado al Portal",
    subjTeam: (c: string) => `Fue agregado a ${c} en el Portal de Proveedores de Leeward`,
    teamBody: (who: string, c: string) => `${who} lo agregó a la cuenta de <b>${c}</b> en el Portal de Proveedores de Leeward, donde puede ver las invitaciones a ofertar de The Leeward Group y presentar ofertas.`,
    hello: (n: string) => `${n}:`,
  },
};

export function strings(lng: Lang) {
  return S[lng] || S.en;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function p(html: string, extra = ""): string {
  return `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.8;color:${BODY};${extra}">${html.replace(/<b>/g, `<strong style="color:${INK};">`).replace(/<\/b>/g, "</strong>")}</p>`;
}

function numberedRow(n: number, title: string, bodyHtml: string, last: boolean): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:${last ? 0 : 20}px;">
    <tr>
      <td width="30" valign="top" style="padding-right:16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="30" bgcolor="${BLUE_DARK}" style="background-color:${BLUE_DARK};border-radius:2px;">
          <tr><td align="center" valign="middle" height="30" style="color:#ffffff;font-family:${FONT};font-size:11px;font-weight:700;">${String(n).padStart(2, "0")}</td></tr>
        </table>
      </td>
      <td valign="top">
        <p style="margin:0 0 3px;font-family:${FONT};font-size:14px;font-weight:600;color:${INK};">${title}</p>
        <p style="margin:0;font-family:${FONT};font-size:12.5px;line-height:1.55;color:#555555;">${bodyHtml}</p>
      </td>
    </tr>
  </table>`;
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;background-color:${BLUE};border:2px solid ${BLUE};color:#ffffff;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;padding:13px 30px;border-radius:20px;margin:4px 6px;">${label}</a>`;
}

function darkBox(label: string, inner: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0;">
    <tr><td align="center" bgcolor="${INK}" style="background-color:${INK};padding:28px 24px;border-radius:15px 0 15px 0;">
      ${label ? `<p style="margin:0 0 14px;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${BLUE};">${label}</p>` : ""}
      ${inner}
    </td></tr>
  </table>`;
}

function shell(lng: Lang, bannerText: string, inner: string, footerNote: string): string {
  const s = strings(lng);
  return `<!DOCTYPE html>
<html lang="${lng}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(bannerText)} – ${COMPANY_NAME}</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#ffffff;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;">
  <tr><td align="center" bgcolor="${BLUE_DARK}" style="background-color:${BLUE_DARK};padding:16px 24px;">
    <p style="margin:0;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#ffffff;">&#9670;&nbsp;&nbsp; ${escapeHtml(bannerText)} &nbsp;&nbsp;&#9670;</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <img src="${LOGO_URL}" alt="${COMPANY_NAME}" width="540" style="max-width:100%;height:auto;display:block;border:0;">
  </td></tr>
  <tr><td style="padding:32px 40px 28px;">
${inner}
    <p style="margin:28px 0 3px;font-family:${SERIF};font-size:18px;color:${INK};">The Leeward Group LLC</p>
    <p style="margin:0;font-family:${FONT};font-size:11px;color:${BLUE};letter-spacing:0.1em;text-transform:uppercase;font-weight:600;">${s.tagline}</p>
  </td></tr>
  <tr><td align="center" style="padding:24px 40px;border-top:3px solid ${BLUE};">
    <p style="margin:0 0 12px;font-family:${FONT};font-size:12px;line-height:2;color:#637d8f;">
      PO Box 3579, Wilmington, NC 28406<br>
      <a href="tel:9105245130" style="color:${BLUE};text-decoration:none;">910-524-5130</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="mailto:Info@theleewardgroup.us" style="color:${BLUE};text-decoration:none;">Info@theleewardgroup.us</a><br>
      <a href="https://www.theleewardgroup.us" target="_blank" style="color:${BLUE};text-decoration:none;">www.theleewardgroup.us</a>
    </p>
    <p style="margin:0;font-family:${FONT};font-size:10px;line-height:1.7;color:#364a57;">&copy; ${new Date().getFullYear()} The Leeward Group LLC. ${s.rights}<br>${footerNote}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function greeting(name: string, lng: Lang): string {
  return `<p style="margin:0 0 18px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${BLUE};">${escapeHtml(strings(lng).hello(name))}</p>`;
}

const divider = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" height="3" bgcolor="${BLUE}" style="background-color:${BLUE};font-size:0;line-height:0;border-radius:2px;">&nbsp;</td></tr></table><div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>`;

function stripTags(html: string): string {
  return html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Bid emails
// ---------------------------------------------------------------------------

export function inviteLink(token: string): string {
  return `${PORTAL_URL}/i.html?t=${encodeURIComponent(token)}`;
}

function detailsBlock(pkg: BidPackageForEmail, fileCount: number, lng: Lang): string {
  const s = strings(lng);
  const rows: { title: string; body: string }[] = [];
  rows.push({ title: s.dueLabel, body: escapeHtml(formatWhen(pkg.due_at, lng)) });
  if (pkg.walkthrough_at) {
    rows.push({
      title: s.walkLabel,
      body: escapeHtml(formatWhen(pkg.walkthrough_at, lng)) + (pkg.walkthrough_location ? `<br>${escapeHtml(pkg.walkthrough_location)}` : ""),
    });
  }
  if (pkg.location) rows.push({ title: s.locLabel, body: escapeHtml(pkg.location) });
  rows.push({
    title: s.contactLabel,
    body: `${s.name}: ${escapeHtml(pkg.contact_name)}<br>${s.email}: <a href="mailto:${escapeHtml(pkg.contact_email)}" style="color:${BLUE};text-decoration:none;">${escapeHtml(pkg.contact_email)}</a>`
      + (pkg.contact_phone ? `<br>${s.phone}: ${escapeHtml(pkg.contact_phone)}` : ""),
  });
  const files = fileCount
    ? `<p style="margin:22px 0 0;font-family:${FONT};font-size:12.5px;color:#555555;">${escapeHtml(s.plansNote(fileCount))}</p>`
    : "";
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0;">
    <tr><td bgcolor="#f4f8fd" style="background-color:#f4f8fd;border-left:4px solid ${BLUE};padding:26px 28px;border-radius:0 10px 10px 0;">
      <p style="margin:0 0 22px;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${BLUE_DARK};">${s.detailsHead}</p>
      ${rows.map((r, i) => numberedRow(i + 1, r.title, r.body, i === rows.length - 1)).join("")}
      ${files}
    </td></tr>
  </table>`;
}

export function renderBidEmail(
  kind: BidEmailKind,
  pkg: BidPackageForEmail,
  invite: InviteForEmail,
  options: { lang?: Lang; fileCount?: number; coiRequest?: boolean } = {},
): Rendered {
  const lng: Lang = options.lang || "en";
  const s = strings(lng);
  const project = escapeHtml(pkg.project_name);
  const pkgName = escapeHtml(pkg.name);
  const company = escapeHtml(invite.company_name);
  const who = (invite.contact_name || "").trim() || invite.company_name;
  const link = inviteLink(invite.token);
  const due = formatWhen(pkg.due_at, lng);

  // The COI PDF is only asked for once a vendor gets the job -- on its own,
  // or as part of the award email.
  const coiBox = darkBox(s.coiLabel, button(link, s.coiButton)
    + `<p style="margin:18px 0 0;font-family:${FONT};font-size:13.5px;line-height:1.65;color:#ffffff;">${s.coiNote}</p>`);
  if (kind === "coi_request") {
    const bodyHtml = p(s.coiIntro(company, pkgName, project)) + p(s.coiAsk);
    const html = shell(lng, s.bannerCoi, greeting(who, lng) + bodyHtml + coiBox, s.footerBid);
    const text = [s.hello(who), "", stripTags(bodyHtml.replace(/<\/p>/g, "\n\n")).trim(), "", s.textCoi, link, "", "The Leeward Group LLC"].join("\n");
    return { subject: s.subjCoi(pkg.project_name, pkg.name), html, text };
  }

  if (kind === "awarded" || kind === "not_selected") {
    const awarded = kind === "awarded";
    const amount = invite.bid_amount != null && invite.bid_amount !== "" ? formatMoney(invite.bid_amount) : "";
    const subject = awarded ? s.subjAward(pkg.project_name, pkg.name) : s.subjResults(pkg.project_name, pkg.name);
    const bodyHtml = awarded
      ? p(s.awardBody(company, pkgName, project, escapeHtml(amount))) + p(s.awardNext(escapeHtml(pkg.contact_name)))
      : p(s.resultsBody(pkgName, project)) + p(s.resultsThanks);
    const withCoi = awarded && options.coiRequest;
    const fullBody = withCoi ? bodyHtml + p(s.coiAsk) : bodyHtml;
    const html = shell(lng, awarded ? s.bannerAward : s.bannerResults, greeting(who, lng) + fullBody + (withCoi ? coiBox : ""), s.footerBid);
    const text = [s.hello(who), "", stripTags(fullBody.replace(/<\/p>/g, "\n\n")).trim(), ...(withCoi ? ["", s.textCoi, link] : []), "", "The Leeward Group LLC"].join("\n");
    return { subject, html, text };
  }

  const isReminder = kind !== "invite";
  const subject = kind === "invite"
    ? s.subjInvite(pkg.project_name, pkg.name)
    : kind === "reminder_due" ? s.subjRemindDue(due, pkg.project_name, pkg.name) : s.subjRemindNo(pkg.project_name, pkg.name);
  const intro = kind === "invite"
    ? s.introInvite(company, pkgName, project)
    : kind === "reminder_due" ? s.introDue(pkgName, project, escapeHtml(due)) : s.introNo(company, pkgName, project);

  const scope = pkg.scope
    ? `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.8;color:${BODY};white-space:pre-line;"><strong style="color:${INK};">${s.scope}</strong> ${escapeHtml(pkg.scope)}</p>`
    : "";

  const cta = darkBox(isReminder ? s.ctaLabelRemind : s.ctaLabelInvite,
    button(link, s.ctaButton)
    + `<p style="margin:18px 0 0;font-family:${FONT};font-size:13.5px;line-height:1.65;color:#ffffff;">${s.ctaNote(escapeHtml(due)).replace(/<b>/g, "<strong>").replace(/<\/b>/g, "</strong>")}</p>`);

  const closing = (pkg.questions_due_at
    ? p(s.questionsBy(escapeHtml(pkg.contact_name), escapeHtml(formatWhen(pkg.questions_due_at, lng))))
    : p(s.questionsReply(escapeHtml(pkg.contact_name)))) + p(s.appreciate);

  const inner = greeting(who, lng) + p(intro) + divider + scope + p(s.review)
    + detailsBlock(pkg, options.fileCount || 0, lng) + cta + closing;

  const html = shell(lng, isReminder ? s.bannerReminder : s.bannerInvite, inner, s.footerBid);

  const lines = [
    s.hello(who), "",
    stripTags(intro), "",
    `${stripTags(s.dueLabel)} ${due}`,
  ];
  if (pkg.walkthrough_at) lines.push(`${stripTags(s.walkLabel)} ${formatWhen(pkg.walkthrough_at, lng)}${pkg.walkthrough_location ? ` — ${pkg.walkthrough_location}` : ""}`);
  if (pkg.location) lines.push(`${s.locLabel} ${pkg.location}`);
  lines.push(`${s.contactLabel} ${pkg.contact_name} — ${pkg.contact_email}${pkg.contact_phone ? ` — ${pkg.contact_phone}` : ""}`);
  if (pkg.scope) lines.push("", `${s.scope} ${pkg.scope}`);
  lines.push("", s.textButton, link, "", stripTags(s.ctaNote(due)), "", "The Leeward Group LLC",
    "PO Box 3579, Wilmington, NC 28406 · 910-524-5130 · Info@theleewardgroup.us");

  return { subject, html, text: lines.join("\n") };
}

// deno-lint-ignore no-explicit-any
export function packageForEmail(pkg: any, project: any): BidPackageForEmail {
  const siteAddress = project
    ? [project.site_address, [project.site_city, project.site_state].filter(Boolean).join(", "), project.site_zip].filter(Boolean).join(" ").trim()
    : "";
  return {
    name: pkg.name,
    scope: pkg.scope || null,
    location: pkg.location || siteAddress || null,
    due_at: pkg.due_at,
    walkthrough_at: pkg.walkthrough_at || null,
    walkthrough_location: pkg.walkthrough_location || null,
    questions_due_at: pkg.questions_due_at || null,
    contact_name: pkg.contact_name,
    contact_email: pkg.contact_email,
    contact_phone: pkg.contact_phone || null,
    project_name: project?.name || "Project",
  };
}

// ---------------------------------------------------------------------------
// Vendor Portal account emails
// ---------------------------------------------------------------------------

function simpleEmail(lng: Lang, banner: string, name: string, paragraphs: string[], buttonHref: string | null, buttonLabel: string | null, note: string | null): string {
  const inner = greeting(name, lng)
    + paragraphs.map((t) => p(t)).join("")
    + (buttonHref && buttonLabel
      ? darkBox("", button(buttonHref, buttonLabel) + (note ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:#b0bec5;">${escapeHtml(note)}</p>` : ""))
      : "");
  return shell(lng, banner, inner, strings(lng).footerPortal);
}

function textOf(name: string, lng: Lang, paragraphs: string[], link: string | null, note: string | null): string {
  return [strings(lng).hello(name), "", ...paragraphs.map((t) => stripTags(t) + "\n"), ...(link ? [link, ""] : []), ...(note ? [note, ""] : []), "The Leeward Group LLC"].join("\n");
}

export function renderSignInEmail(lng: Lang, name: string, link: string, minutes: number): Rendered {
  const s = strings(lng);
  const note = s.signInNote(minutes);
  return { subject: s.subjSignIn, html: simpleEmail(lng, s.bannerSignIn, name, [s.signInBody], link, s.signInButton, note), text: textOf(name, lng, [s.signInBody], link, note) };
}

export function renderApplicationReceivedEmail(lng: Lang, name: string, companyName: string, link: string): Rendered {
  const s = strings(lng);
  const paras = [s.receivedBody(escapeHtml(companyName)), s.receivedButtonNote];
  return { subject: s.subjReceived, html: simpleEmail(lng, s.bannerReceived, name, paras, link, s.signInButton, s.signInNote(60)), text: textOf(name, lng, paras, link, null) };
}

export function renderApprovedEmail(lng: Lang, name: string, companyName: string, link: string, hours: number): Rendered {
  const s = strings(lng);
  const paras = [s.approvedBody(escapeHtml(companyName))];
  const note = s.approvedNote(hours);
  return { subject: s.subjApproved, html: simpleEmail(lng, s.bannerApproved, name, paras, link, s.signInButton, note), text: textOf(name, lng, paras, link, note) };
}

export function renderRejectedEmail(lng: Lang, name: string, companyName: string, reason: string | null): Rendered {
  const s = strings(lng);
  const paras = [s.rejectedBody(escapeHtml(companyName))];
  if (reason) paras.push(`<b>${s.rejectedReason}</b> ${escapeHtml(reason)}`);
  paras.push(s.rejectedContact);
  return { subject: s.subjRejected, html: simpleEmail(lng, s.bannerRejected, name, paras, null, null, null), text: textOf(name, lng, paras, null, null) };
}

export function renderTeamInviteEmail(lng: Lang, name: string, inviterName: string, companyName: string, link: string, hours: number): Rendered {
  const s = strings(lng);
  const paras = [s.teamBody(escapeHtml(inviterName), escapeHtml(companyName))];
  const note = s.approvedNote(hours);
  return { subject: s.subjTeam(companyName), html: simpleEmail(lng, s.bannerTeam, name, paras, link, s.signInButton, note), text: textOf(name, lng, paras, link, note) };
}
