// Contract Builder — builds the Leeward subcontract PDF (2026-11-19).
//
//   buildContractPdf(data, exhibits)  -> { bytes, layout }
//       the contract (wording from contract-template.ts, vendor/project data
//       filled in), then Exhibits B, C, D1, D2, E, F. Every exhibit page gets
//       "Exhibit X- Name" at the top ("Exhibit X- continued" after its first
//       page) and "Int: ___ Int: ___" at the bottom.
//   stampVendor(bytes, layout, ...)   vendor initials on every page + signature
//   stampGc(bytes, layout, ...)       Project Manager initials + signature,
//                                     and fills in the agreement date
//
// `layout` remembers where every Init: blank, signature line and date blank
// is, so signing stamps onto the exact spot. Saved with the contract row.
//
// Contract pages are numbered "Page X of N" (N = contract pages only; the
// exhibits aren't counted). Footer date = TEMPLATE_REVISION.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from "npm:pdf-lib@1.17.1";
import { CONTRACT_TEMPLATE, TEMPLATE_REVISION } from "./contract-template.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const LETTER: [number, number] = [612, 792];
const INK = rgb(0, 0, 0);
const STAMP_INK = rgb(0.03, 0.18, 0.42);

export interface Slot { p: number; x: number; y: number; w: number }
export interface ContractLayout {
  revision: string;
  contract_pages: number;
  pages: { label: string; init: Slot[] }[];     // init[0] = vendor, init[1] = Leeward
  slots: Record<string, Slot>;                   // agree_day, agree_month, agree_year, v_sig, v_name, v_date, gc_sig, gc_date
}

export interface ContractData {
  SUB_NAME: string; SUB_STREET: string; SUB_CITY: string; SUB_STATE: string; SUB_ZIP: string;
  SUB_TAXID: string; SUB_WORK_PHONE: string; SUB_MOBILE_PHONE: string; SUB_POC: string; SUB_EMAIL: string;
  PROJECT_NAME: string; PROJECT_LOCATION: string; SCOPE: string;
  SUM: string; SUM_WORDS: string; RETAINAGE: string; RETAINAGE_WORDS: string;
  SAFETY_REP: string; OWNER_ENTITY: string;
  // lien waivers
  SITE_ADDRESS: string; SITE_CITY: string; SITE_STATE_NAME: string; SITE_STATE: string; COUNTY: string; LENDER: string;
}

// One exhibit's pages. Files are PDFs (all pages, or just the first) or images.
export interface ExhibitFile { bytes: Uint8Array; kind: "pdf" | "png" | "jpg"; firstPageOnly?: boolean }
export interface Exhibit { letter: string; name: string; files?: ExhibitFile[]; generate?: "D1" | "D2"; missing?: string }

// ---------------------------------------------------------------------------
// Text helpers

// The standard PDF fonts only know WinAnsi characters.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function safe(text: unknown): string {
  return String(text ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[‐‑‒]/g, "-")
    .replace(/[   ]/g, " ")
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 256 || WIN_ANSI_EXTRA.includes(ch) ? ch : "?"))
    .join("");
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}
export function numberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "Zero";
  const scales = ["", " Thousand", " Million", " Billion"];
  const out: string[] = [];
  let i = 0;
  while (n > 0 && i < scales.length) {
    const chunk = n % 1000;
    if (chunk) out.unshift(`${under1000(chunk)}${scales[i]}`);
    n = Math.floor(n / 1000); i++;
  }
  return out.join(" ");
}
// 105000 -> "One Hundred Five Thousand Dollars and No Cents"
export function dollarWords(amount: number): string {
  const cents = Math.round(amount * 100) % 100;
  const dollars = Math.floor(Math.round(amount * 100) / 100);
  return `${numberWords(dollars)} Dollar${dollars === 1 ? "" : "s"} and ${cents ? `${numberWords(cents)} Cent${cents === 1 ? "" : "s"}` : "No Cents"}`;
}
// 5 -> "five", 2.5 -> "two and one-half"
export function percentWords(p: number): string {
  const whole = Math.floor(p), frac = Math.round((p - whole) * 100) / 100;
  const w = whole ? numberWords(whole).toLowerCase() : "zero";
  if (!frac) return w;
  const fracWords: Record<string, string> = { "0.25": "one-quarter", "0.5": "one-half", "0.75": "three-quarters" };
  return fracWords[String(frac)] ? `${w} and ${fracWords[String(frac)]}` : `${w} point ${String(frac).slice(2).split("").map((d) => (numberWords(Number(d)) || "zero").toLowerCase()).join(" ")}`;
}
export function money(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
export function stateName(value: unknown): string {
  const s = String(value || "").trim();
  return STATE_NAMES[s.toUpperCase()] || s;
}

// ---------------------------------------------------------------------------
// Paragraph engine

interface Fonts { reg: PDFFont; bold: PDFFont; ital: PDFFont }
interface Piece { text: string; b: boolean; u: boolean; slot?: string; w?: number }
type Word = Piece[];

interface Flow {
  pdf: PDFDocument;
  fonts: Fonts;
  size: number;
  lead: number;          // line height multiplier
  left: number; right: number; top: number; bottom: number;
  page: PDFPage | null;
  pageIndex: number;     // index in pdf
  y: number;
  newPage: () => void;
  slots: Record<string, Slot>;
}

function pieceWidth(f: Flow, p: Piece, size: number): number {
  if (p.slot) return p.w || 40;
  return (p.b ? f.fonts.bold : f.fonts.reg).widthOfTextAtSize(p.text, size);
}

// Runs -> words. A word can mix styles ("Lien Waivers" + ":").
function toWords(runs: Row[], data: Record<string, string>): Word[] {
  const words: Word[] = [];
  let cur: Word = [];
  const push = () => { if (cur.length) words.push(cur); cur = []; };
  for (const r of runs) {
    if (!Array.isArray(r) && r.slot) { push(); words.push([{ text: "", b: false, u: true, slot: r.slot, w: r.w }]); continue; }
    const text = Array.isArray(r) ? r[0] : (data[r.f] ?? "");
    const style = Array.isArray(r) ? r[1] : (r.s || "");
    const b = style.includes("b"), u = style.includes("u");
    const parts = safe(text).split(/( +)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^ +$/.test(part)) { push(); continue; }
      cur.push({ text: part, b, u });
    }
  }
  push();
  return words;
}

function wordWidth(f: Flow, w: Word, size: number) { return w.reduce((s, p) => s + pieceWidth(f, p, size), 0); }

// Draws one paragraph block. Returns nothing; moves f.y down.
function drawParagraph(f: Flow, block: Row, data: Record<string, string>) {
  const size = block.size || f.size;
  if (block.pre) {
    // A caption line drawn as-is (spacing kept), e.g. "(NAME)      (TITLE)".
    f.y -= block.before || 0;
    f.y -= size * f.lead;
    f.page!.drawText(safe(block.pre), { x: f.left + (block.ind ?? 0), y: f.y + size * 0.25, size, font: f.fonts.reg, color: INK });
    f.y -= block.after ?? 4;
    return;
  }
  const lh = size * f.lead;
  const ind = block.ind ?? 0;
  const x0 = f.left + ind;
  const maxW = f.right - x0;
  const words = toWords(block.r, data);
  // A touch wider than the font's space (Times' is narrow next to bold words).
  const space = f.fonts.reg.widthOfTextAtSize(" ", size) * 1.2;

  // Break into lines (a word longer than a line is split by characters).
  const lines: Word[][] = [];
  let line: Word[] = [], lineW = 0;
  for (let w of words) {
    let ww = wordWidth(f, w, size);
    while (ww > maxW && w.length === 1 && !w[0].slot && w[0].text.length > 1) {
      // split an over-long single-style word
      let cut = w[0].text.length - 1;
      while (cut > 1 && pieceWidth(f, { ...w[0], text: w[0].text.slice(0, cut) }, size) > maxW) cut--;
      if (line.length) { lines.push(line); line = []; lineW = 0; }
      lines.push([[{ ...w[0], text: w[0].text.slice(0, cut) }]]);
      w = [{ ...w[0], text: w[0].text.slice(cut) }];
      ww = wordWidth(f, w, size);
    }
    const add = (line.length ? space : 0) + ww;
    if (line.length && lineW + add > maxW) { lines.push(line); line = [w]; lineW = ww; }
    else { line.push(w); lineW += add; }
  }
  if (line.length) lines.push(line);
  if (!lines.length) lines.push([]);

  f.y -= block.before || 0;
  // Keep a numbered heading with at least two lines of what follows.
  const needed = lh * Math.min(lines.length, 2) + (block.lab && /^\d\.$/.test(block.lab) ? lh * 3 : 0);
  if (f.y - needed < f.bottom) f.newPage();

  lines.forEach((ln, li) => {
    if (f.y - lh < f.bottom) f.newPage();
    f.y -= lh;
    const baseline = f.y + size * 0.25;
    const page = f.page!;
    if (li === 0 && block.lab) {
      const labFont = /^\d\.$/.test(block.lab) ? f.fonts.bold : f.fonts.reg;
      page.drawText(safe(block.lab), { x: f.left + (block.labx ?? 0), y: baseline, size, font: labFont, color: INK });
    }
    const natural = ln.reduce((s, w, i) => s + wordWidth(f, w, size) + (i ? space : 0), 0);
    let gap = space;
    let x = x0;
    const last = li === lines.length - 1;
    if (block.a === "c") x = x0 + (maxW - natural) / 2;
    else if (block.a === "r") x = x0 + (maxW - natural);
    else if (block.a === "j" && !last && ln.length > 1) gap = space + (maxW - natural) / (ln.length - 1);
    ln.forEach((w, wi) => {
      if (wi) {
        // underline the gap too when both sides are underlined
        const prev = ln[wi - 1][ln[wi - 1].length - 1], next = w[0];
        if (prev.u && next.u) page.drawLine({ start: { x, y: baseline - 1.6 }, end: { x: x + gap, y: baseline - 1.6 }, thickness: 0.6, color: INK });
        x += gap;
      }
      for (const p of w) {
        const pw = pieceWidth(f, p, size);
        if (p.slot) {
          f.slots[p.slot] = { p: f.pageIndex, x, y: baseline, w: pw };
        } else {
          page.drawText(p.text, { x, y: baseline, size, font: p.b ? f.fonts.bold : f.fonts.reg, color: INK });
        }
        if (p.u) page.drawLine({ start: { x, y: baseline - 1.6 }, end: { x: x + pw, y: baseline - 1.6 }, thickness: 0.6, color: INK });
        x += pw;
      }
    });
  });
  f.y -= block.after ?? 4;
}

function hline(page: PDFPage, x: number, y: number, w: number) {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.7, color: INK });
}

// The signature block (IN WITNESS WHEREOF ... page).
function drawSignatureBlock(f: Flow, data: Record<string, string>) {
  const { reg, bold } = f.fonts;
  const L = f.left;
  let y = f.y - 30;
  const page = f.page!;
  page.drawText("SUBCONTRACTOR:", { x: L, y, size: 10, font: bold });
  const firm = safe(data.SUB_NAME);
  page.drawText(firm, { x: L + 110, y: y + 1, size: 11, font: bold });
  hline(page, L + 108, y - 3, f.right - L - 108);
  page.drawText("Firm Name (Print)", { x: L + 108 + (f.right - L - 108) / 2 - 30, y: y - 13, size: 7, font: reg });
  y -= 60;
  page.drawText("BY:", { x: L, y, size: 10, font: bold });
  y -= 46;
  hline(page, L + 18, y, 210);
  f.slots.v_sig = { p: f.pageIndex, x: L + 22, y: y + 2, w: 200 };
  page.drawText("Signature", { x: L + 100, y: y - 11, size: 7, font: reg });
  hline(page, L + 270, y, 210);
  f.slots.v_name = { p: f.pageIndex, x: L + 274, y: y + 3, w: 200 };
  page.drawText("Printed Name & Title", { x: L + 340, y: y - 11, size: 7, font: reg });
  y -= 42;
  hline(page, L + 290, y, 160);
  f.slots.v_date = { p: f.pageIndex, x: L + 294, y: y + 3, w: 150 };
  page.drawText("Date", { x: L + 362, y: y - 11, size: 8, font: reg });
  y -= 70;
  page.drawText("Leeward Construction, LLC", { x: L + 24, y, size: 11, font: bold });
  y -= 44;
  page.drawText("BY:", { x: L, y, size: 10, font: bold });
  y -= 16;
  hline(page, L + 24, y, 230);
  f.slots.gc_sig = { p: f.pageIndex, x: L + 28, y: y + 2, w: 220 };
  hline(page, L + 300, y, 150);
  f.slots.gc_date = { p: f.pageIndex, x: L + 304, y: y + 3, w: 140 };
  page.drawText("Date", { x: L + 366, y: y - 11, size: 8, font: reg });
  f.y = y - 40;
}

// ---------------------------------------------------------------------------
// Exhibit page decoration

function exhibitHeader(page: PDFPage, fonts: Fonts, text: string) {
  const { width, height } = page.getSize();
  const size = 11;
  const w = fonts.bold.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (width - w) / 2, y: height - 28, size, font: fonts.bold, color: INK });
}
// "Int: ______ Int: ______" bottom right; returns the two blanks.
function initFooter(page: PDFPage, fonts: Fonts, pageIndex: number): Slot[] {
  const { width } = page.getSize();
  const size = 10, blank = 54, y = 24;
  const label = "Int:";
  const lw = fonts.bold.widthOfTextAtSize(label, size);
  const total = (lw + 3 + blank) * 2 + 12;
  let x = width - 36 - total;
  const slots: Slot[] = [];
  for (let i = 0; i < 2; i++) {
    page.drawText(label, { x, y, size, font: fonts.bold, color: INK });
    x += lw + 3;
    hline(page, x, y - 1.5, blank);
    slots.push({ p: pageIndex, x: x + 4, y, w: blank - 8 });
    x += blank + 12;
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Lien waivers (Exhibits D1 and D2), wording from Leeward's example contract.

function waiverD1(d: ContractData): Row[][] {
  const P = d.PROJECT_NAME, O = d.OWNER_ENTITY;
  const loc = `${d.SITE_ADDRESS}, in ${d.COUNTY} County, in ${d.SITE_CITY}, ${d.SITE_STATE_NAME}`;
  const page1: Row[] = [
    { k: "p", r: [[`Project Name: ${P}`, "b"]], a: "c", size: 12, before: 18, after: 18 },
    { k: "p", r: [["DOWN DATE WAIVER AND SUBORDINATION", "b"]], a: "c", size: 12, after: 0 },
    { k: "p", r: [["OF MECHANIC'S LIEN CLAIMS", "bu"]], a: "c", size: 12, after: 18 },
    { k: "p", r: [["STATE ", ""], [d.SITE_STATE_NAME, "b"], [",", ""]], after: 12 },
    { k: "p", r: [["COUNTY: ", ""], [String(d.COUNTY || "").toUpperCase(), "b"]], after: 14 },
    { k: "p", r: [["The undersigned is an original contractor or subcontractor who has furnished labor and/or material (“Work”) in the construction of improvements upon real property owned by ", ""], [O, ""], [" (", ""], ["Owner", "bu"], [") and pursuant to a contract with Leeward Construction, LLC ", ""], ["(“General Contractor”)", "b"], [" and together with owner, (the ", ""], ["“Interested Parties”)", "bu"], [" Located at ", ""], [d.SITE_ADDRESS, "u"], [`, in ${d.COUNTY} County, in ${d.SITE_CITY}, ${d.SITE_STATE_NAME}. (the “`, ""], ["Property", "b"], ["”).", ""]], a: "j", ind: 18, size: 11.5, after: 16 },
    { k: "p", r: [["For Work in connection with the Property, the undersigned:", ""]], a: "c", size: 11.5, after: 12 },
    { k: "p", r: [["Received (Cumulative amount) $____________through___________", ""], ["(Prior Down Date),", "bu"]], lab: "X", labx: 40, ind: 70, size: 11, after: 10 },
    { k: "p", r: [["Is owed (less retainage) $________________through_______________, (", ""], ["Down Date", "bu"], ["),", ""]], lab: "X", labx: 40, ind: 70, size: 11, after: 10 },
    { k: "p", r: [["Except for $___________(cumulative amt. withheld) of retainage, not yet due and payable.", ""]], lab: "X", labx: 40, ind: 70, size: 11, after: 14 },
    { k: "p", r: [["Except for such retainage amount, the undersigned (a) through the Prior Down Date, and (b) additionally, upon receipt of the amount owed, through the Down Date:", ""]], ind: 0, size: 11, after: 10 },
    { k: "p", r: [["Has been paid in full for all sums owed for Work concerning the Property;", ""]], lab: "1.", labx: 36, ind: 54, size: 11.5, after: 10 },
    { k: "p", r: [["Acknowledges complete satisfaction of, and forever waives and releases, all claims of every kind against Owner or the Property, including but not limited to all liens and claims of liens, which the undersigned may have as a result of or in connection with the Work;", ""]], lab: "2.", labx: 36, ind: 54, size: 11.5, after: 10 },
    { k: "p", r: [["Has represented and warranted and does hereby represent and warrant that all persons or entities who have furnished labor and/or material to the undersigned in connection with the Work have been paid all amounts they are owed, except agreed retainage not yet due and payable which in total does not exceed the retainage amount set forth above;", ""]], lab: "3.", labx: 36, ind: 54, size: 11.5, after: 22 },
    { k: "p", r: [["Initial ________", ""]], a: "r", size: 11.5, after: 0 },
  ];
  const page2: Row[] = [
    { k: "p", r: [["Agrees unconditionally to indemnify Owner and hold Owner harmless against all liability, loss, cost or expense (including but not limited to attorneys fees) now or hereafter incurred, paid or suffered by or asserted against Owner or the Property because of any claim or action by the undersigned, or by any person or entity claiming by, through or under the undersigned, with respect to the claims, liens and rights herein waived and released or arising out of any breach or untruth of any representation herein made.", ""]], lab: "4.", labx: 36, ind: 54, size: 11, before: 6, after: 9 },
    { k: "p", r: [["In consideration of its funding of loan proceeds to be used to pay for Work furnished by the undersigned, the undersigned hereby agrees and acknowledges for the benefit of ", ""], [d.LENDER, "b"], [" (“", ""], ["Lender", "bu"], ["”) that all mechanic's liens or rights to the same now or hereafter owned or held by the undersigned are and shall be subordinate and inferior to the lien of the deed of trust held by Lender on the Property.", ""]], a: "j", size: 11, after: 9 },
    { k: "p", r: [["The person signing this document represents that he or she is duly authorized to do so on behalf of the undersigned original contractor or subcontractor.", ""]], a: "j", size: 11, after: 9 },
    { k: "p", r: [["All of the provisions of this document shall bind the undersigned original contractor or subcontractor and the undersigned's heirs, legal representatives, successors and assigns and shall inure to the benefit of Owner and Owner's legal representatives, successors, assigns and sureties.", ""]], a: "j", size: 11, after: 10 },
    { k: "p", r: [["Executed this_______________day of________________,", ""]], size: 11, after: 10 },
    { k: "p", r: [["Company:", ""]], ind: 250, size: 11, after: 9 },
    { k: "p", r: [["By: ______________________________", ""]], ind: 250, size: 11, after: 9 },
    { k: "p", r: [["Name:_____________________________", ""]], ind: 250, size: 11, after: 9 },
    { k: "p", r: [["Title:______________________________", ""]], ind: 250, size: 11, after: 10 },
    { k: "p", r: [["STATE OF_____________________,", ""]], size: 11, after: 9 },
    { k: "p", r: [["COUNTY OF__________________,", ""]], size: 11, after: 9 },
    { k: "p", r: [["This instrument was acknowledged before me on_________________, ________________", ""]], size: 11, after: 0 },
    { k: "p", pre: "(MONTH , DATE)                                    (YEAR)", ind: 240, size: 6.5, after: 12 },
    { k: "p", r: [["By_______________________________, _________________of and on behalf of", ""]], size: 11, after: 0 },
    { k: "p", pre: "(NAME)                                                       (TITLE)", ind: 50, size: 6.5, after: 14 },
    { k: "p", r: [["_______________________________________, a ________________________", ""]], size: 11, after: 0 },
    { k: "p", pre: "(COMPANY NAME)                                                         (STATE AND BUSINESS STRUCTURE)", ind: 26, size: 6.5, after: 14 },
    { k: "p", r: [["Notary Public: ___________________________", ""]], ind: 220, size: 11, after: 9 },
    { k: "p", r: [["State Of: ________________________________", ""]], ind: 220, size: 11, after: 9 },
    { k: "p", r: [["My Commission Expires: __________________", ""]], ind: 220, size: 11, after: 0 },
  ];
  return [page1, page2];
}

function waiverD2(d: ContractData): Row[][] {
  const P = d.PROJECT_NAME, O = d.OWNER_ENTITY;
  const page1: Row[] = [
    { k: "p", r: [[`Project Name: ${P}`, ""]], a: "c", size: 12.5, before: 18, after: 30 },
    { k: "p", r: [["MECHANIC AND/OR MATERIALMAN FINAL, UNCONDITIONAL LIEN RELEASE", ""]], a: "c", size: 11, after: 4 },
    { k: "p", r: [["AND RELEASE UPON FINAL PAYMENT", ""]], a: "c", size: 11, after: 22 },
    { k: "p", r: [["STATE OF _______________", ""]], size: 11, after: 12 },
    { k: "p", r: [["COUNTY OF _____________", ""]], size: 11, after: 26 },
    { k: "p", r: [["The undersigned, __________________________(“Mechanic and/or Materialman”), has been engaged under contract with Leeward Construction, LLC (“General Contractor”) to furnish certain materials, equipment, services and/or labor for the construction of improvements known as ", ""], [P, ""], [" (“Project”), together with all improvements and appurtenances attendant thereto, which is located at ", ""], [d.SITE_ADDRESS, "u"], [`, in ${d.COUNTY} County, ${d.SITE_CITY}, ${d.SITE_STATE}, (the “`, ""], ["Property", "b"], ["”) and is owned by ", ""], [O, ""], [" (“Owner”) :", ""]], a: "j", size: 11, after: 24 },
    { k: "p", r: [["Upon receipt of the ", ""], ["entire contract", "b"], [" sum of $______________ ($_____________ of which is the for the entire release of retention/final payment) for services/labor, equipment or materials furnished for Location /Mechanic and/or materialman has been completely paid in full for all work performed on this location, and waives and releases any and all liens or claims of liens or any right against any labor and/or material bond it has upon the foregoing described building/property.", ""]], a: "j", size: 11, after: 60 },
    { k: "p", r: [["Initial ______________________", ""]], ind: 300, size: 11, after: 14 },
    { k: "p", r: [["Date ______________________", ""]], ind: 300, size: 11, after: 0 },
  ];
  const page2: Row[] = [
    { k: "p", r: [["Building # _________________________", ""]], size: 11, before: 10, after: 24 },
    { k: "p", r: [["FOR MECHANIC AND/OR MATERIALMAN:", ""]], a: "c", size: 11, after: 22 },
    { k: "p", r: [["EXECUTED this ___________ day of _____________, ___________", ""]], size: 11, after: 24 },
    { k: "p", r: [["COMPANY: _______________________________", ""]], ind: 270, size: 11, after: 14 },
    { k: "p", r: [["BY: ______________________________________", ""]], ind: 270, size: 11, after: 14 },
    { k: "p", r: [["NAME: ___________________________________", ""]], ind: 270, size: 11, after: 14 },
    { k: "p", r: [["TITLE: ____________________________________", ""]], ind: 270, size: 11, after: 22 },
    { k: "p", r: [["STATE OF _______________________ ‘", ""]], size: 11, after: 14 },
    { k: "p", r: [["COUNTY OF _____________________’", ""]], size: 11, after: 22 },
    { k: "p", r: [["AFFIDAVIT", ""]], a: "c", size: 11, after: 14 },
    { k: "p", r: [["This instrument was acknowledged before me on ________________________, _______,", ""]], ind: 36, size: 11, after: 0 },
    { k: "p", pre: "(MONTH, DATE)                       (YEAR)", ind: 290, size: 7, after: 10 },
    { k: "p", r: [["by _____________________, _____________________ of and on behalf of", ""]], size: 11, after: 0 },
    { k: "p", pre: "(NAME)                              (TITLE)", ind: 34, size: 7, after: 10 },
    { k: "p", r: [["__________________________________, a _________________________________.", ""]], size: 11, after: 0 },
    { k: "p", pre: "(COMPANY NAME)                                               (STATE AND BUSINESS STRUCTURE)", ind: 34, size: 7, after: 20 },
    { k: "p", r: [["Notary Public________________________", ""]], ind: 300, size: 11, after: 14 },
    { k: "p", r: [["State of ____________________________", ""]], ind: 300, size: 11, after: 14 },
    { k: "p", r: [["My Commission Expires: _______________", ""]], ind: 300, size: 11, after: 0 },
  ];
  return [page1, page2];
}

// ---------------------------------------------------------------------------
// Build

export async function buildContractPdf(data: ContractData, exhibits: Exhibit[]): Promise<{ bytes: Uint8Array; layout: ContractLayout; problems: string[] }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Subcontractor Agreement - ${safe(data.SUB_NAME)} - ${safe(data.PROJECT_NAME)}`);
  pdf.setAuthor("Leeward Construction, LLC");
  const helv: Fonts = {
    reg: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    ital: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const times: Fonts = {
    reg: await pdf.embedFont(StandardFonts.TimesRoman),
    bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    ital: await pdf.embedFont(StandardFonts.TimesRomanItalic),
  };
  const values = data as unknown as Record<string, string>;
  const problems: string[] = [];

  // 1. The contract.
  const f: Flow = {
    pdf, fonts: helv, size: 9.5, lead: 1.32, left: 54, right: 558, top: 738, bottom: 78,
    page: null, pageIndex: -1, y: 0, slots: {},
    newPage() { this.page = pdf.addPage(LETTER); this.pageIndex = pdf.getPageCount() - 1; this.y = this.top; },
  };
  f.newPage();
  for (const block of CONTRACT_TEMPLATE) {
    if (block.k === "break") { f.newPage(); continue; }
    if (block.k === "sig") { drawSignatureBlock(f, values); continue; }
    drawParagraph(f, block, values);
  }
  const contractPages = pdf.getPageCount();
  const pages: ContractLayout["pages"] = [];
  for (let i = 0; i < contractPages; i++) {
    const page = pdf.getPage(i);
    page.drawText(`${TEMPLATE_REVISION},`, { x: 54, y: 40, size: 8, font: helv.ital });
    page.drawText("Subcontractor Agreement", { x: 54, y: 30, size: 8, font: helv.ital });
    const label = `Page ${i + 1} of ${contractPages}`;
    page.drawText(label, { x: 306 - helv.reg.widthOfTextAtSize(label, 9) / 2, y: 40, size: 9, font: helv.reg });
    // "Init: ____  Init: ____" like the original, bottom right.
    const slots: Slot[] = [];
    let x = 400;
    for (let k = 0; k < 2; k++) {
      page.drawText("Init:", { x, y: 30, size: 8, font: helv.ital });
      hline(page, x + 18, 29, 52);
      slots.push({ p: i, x: x + 22, y: 31, w: 44 });
      x += 82;
    }
    pages.push({ label: `Page ${i + 1}`, init: slots });
  }

  // 2. Exhibits.
  for (const ex of exhibits) {
    const title = `Exhibit ${ex.letter}- ${ex.name}`;
    const startCount = pdf.getPageCount();
    const addPage = (size: [number, number]) => {
      const page = pdf.addPage(size);
      const n = pdf.getPageCount() - startCount;
      exhibitHeader(page, times, n === 1 ? title : `Exhibit ${ex.letter}- continued`);
      const init = initFooter(page, times, pdf.getPageCount() - 1);
      pages.push({ label: n === 1 ? `Exhibit ${ex.letter}` : `Exhibit ${ex.letter} (page ${n})`, init });
      return page;
    };

    if (ex.missing) {
      const page = addPage(LETTER);
      const msg = safe(`MISSING — ${ex.missing}`);
      page.drawText(msg, { x: 306 - helv.bold.widthOfTextAtSize(msg, 14) / 2, y: 420, size: 14, font: helv.bold, color: rgb(0.7, 0.1, 0.1) });
      problems.push(`Exhibit ${ex.letter}: ${ex.missing}`);
      continue;
    }

    if (ex.generate) {
      const pagesBlocks = ex.generate === "D1" ? waiverD1(data) : waiverD2(data);
      pagesBlocks.forEach((blocks, idx) => {
        const page = addPage(LETTER);
        const wf: Flow = {
          pdf, fonts: times, size: 11.5, lead: idx === 0 ? 1.45 : 1.3, left: 72, right: 540, top: 740, bottom: 60,
          page, pageIndex: pdf.getPageCount() - 1, y: 740, slots: {},
          newPage() { /* each waiver page is laid out to fit one page */ this.y = this.bottom + 1; },
        };
        for (const b of blocks) drawParagraph(wf, b, values);
        const num = String(idx + 1);
        page.drawText(num, { x: 306 - times.reg.widthOfTextAtSize(num, 10) / 2, y: 46, size: 10, font: times.reg });
      });
      continue;
    }

    for (const file of ex.files || []) {
      if (file.kind === "png" || file.kind === "jpg") {
        const img = file.kind === "png" ? await pdf.embedPng(file.bytes) : await pdf.embedJpg(file.bytes);
        const landscape = img.width > img.height;
        const page = addPage(landscape ? [792, 612] : LETTER);
        placeInFrame(page, img.width, img.height, (x, y, w, h) => page.drawImage(img, { x, y, width: w, height: h }));
        continue;
      }
      let src: PDFDocument;
      try { src = await PDFDocument.load(file.bytes, { ignoreEncryption: true }); }
      catch { problems.push(`Exhibit ${ex.letter}: the PDF couldn't be opened`); continue; }
      const count = file.firstPageOnly ? Math.min(1, src.getPageCount()) : src.getPageCount();
      const indices = Array.from({ length: count }, (_, i) => i);
      let embedded;
      try { embedded = await pdf.embedPages(indices.map((i) => src.getPage(i))); }
      catch { problems.push(`Exhibit ${ex.letter}: the PDF couldn't be read`); continue; }
      embedded.forEach((emb, k) => {
        // Honor the source page's /Rotate (scanned plans are often rotated).
        const rot = ((src.getPage(indices[k]).getRotation().angle % 360) + 360) % 360;
        const sideways = rot === 90 || rot === 270;
        const shownW = sideways ? emb.height : emb.width, shownH = sideways ? emb.width : emb.height;
        const page = addPage(shownW > shownH ? [792, 612] : LETTER);
        placeInFrame(page, shownW, shownH, (x, y, w, h) => {
          const s2 = w / shownW;
          const cw = emb.width * s2, ch = emb.height * s2;
          if (rot === 90) page.drawPage(emb, { x, y: y + cw, width: cw, height: ch, rotate: degrees(-90) });
          else if (rot === 270) page.drawPage(emb, { x: x + ch, y, width: cw, height: ch, rotate: degrees(90) });
          else if (rot === 180) page.drawPage(emb, { x: x + cw, y: y + ch, width: cw, height: ch, rotate: degrees(180) });
          else page.drawPage(emb, { x, y, width: cw, height: ch });
        });
      });
    }
  }

  const bytes = await pdf.save();
  return {
    bytes,
    layout: { revision: TEMPLATE_REVISION, contract_pages: contractPages, pages, slots: f.slots },
    problems,
  };
}

// Fits a source page/image between the exhibit header and the Int: footer.
function placeInFrame(page: PDFPage, w: number, h: number, draw: (x: number, y: number, w: number, h: number) => void) {
  const { width, height } = page.getSize();
  const box = { x: 30, y: 44, w: width - 60, h: height - 44 - 40 };
  const s = Math.min(box.w / w, box.h / h);
  const dw = w * s, dh = h * s;
  draw(box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
}

// ---------------------------------------------------------------------------
// Signing

function fitText(font: PDFFont, text: string, max: number, size: number): number {
  let s = size;
  while (s > 6 && font.widthOfTextAtSize(text, s) > max) s -= 0.5;
  return s;
}

function drawInSlot(pdf: PDFDocument, font: PDFFont, slot: Slot | undefined, text: string, size = 10) {
  if (!slot) return;
  const page = pdf.getPage(slot.p);
  const t = safe(text);
  const s = fitText(font, t, slot.w, size);
  page.drawText(t, { x: slot.x, y: slot.y + 1, size: s, font, color: STAMP_INK });
}

async function drawSignature(pdf: PDFDocument, slot: Slot | undefined, png: Uint8Array) {
  if (!slot) return;
  const img = await pdf.embedPng(png);
  const maxW = slot.w, maxH = 34;
  const s = Math.min(maxW / img.width, maxH / img.height);
  const page = pdf.getPage(slot.p);
  page.drawImage(img, { x: slot.x, y: slot.y, width: img.width * s, height: img.height * s });
}

export function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
}

// The vendor's initials go on the first Init: blank of every page (contract
// and exhibits); their signature, printed name/title and date on the
// signature page.
export async function stampVendor(bytes: Uint8Array, layout: ContractLayout, s: { initials: string; signaturePng: Uint8Array; name: string; title: string | null; when: Date }): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of layout.pages) drawInSlot(pdf, font, page.init[0], s.initials, 9);
  await drawSignature(pdf, layout.slots.v_sig, s.signaturePng);
  drawInSlot(pdf, reg, layout.slots.v_name, `${s.name}${s.title ? `, ${s.title}` : ""}`, 10);
  drawInSlot(pdf, reg, layout.slots.v_date, shortDate(s.when), 10);
  return pdf;
}

// The Project Manager signs for Leeward: second Init: blank of every page,
// the Leeward signature line and date, and the agreement date on page 1.
export async function stampGc(bytes: Uint8Array, layout: ContractLayout, s: { initials: string; signaturePng: Uint8Array; name: string; when: Date }): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of layout.pages) drawInSlot(pdf, font, page.init[1], s.initials, 9);
  await drawSignature(pdf, layout.slots.gc_sig, s.signaturePng);
  const sig = layout.slots.gc_sig;
  if (sig) drawInSlot(pdf, reg, { ...sig, y: sig.y - 13 }, s.name, 7);
  drawInSlot(pdf, reg, layout.slots.gc_date, shortDate(s.when), 10);
  // "this ___ day of ___, 20__"
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric", month: "long", year: "numeric" }).formatToParts(s.when);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = Number(get("day"));
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const center = (slot: Slot | undefined, text: string) => {
    if (!slot) return;
    const sz = fitText(reg, text, slot.w, 9.5);
    const w = reg.widthOfTextAtSize(text, sz);
    pdf.getPage(slot.p).drawText(text, { x: slot.x + Math.max(0, (slot.w - w) / 2), y: slot.y + 1, size: sz, font: reg, color: STAMP_INK });
  };
  center(layout.slots.agree_day, `${day}${suffix}`);
  center(layout.slots.agree_month, get("month"));
  center(layout.slots.agree_year, get("year").slice(2));
  return pdf;
}

// A record page at the end (who signed, when, from where).
export async function addAuditPage(pdf: PDFDocument, heading: string, intro: string, rows: [string, string][], signaturePng?: Uint8Array) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage(LETTER);
  const ink = rgb(0.08, 0.15, 0.23), soft = rgb(0.37, 0.43, 0.49);
  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const words = safe(text).split(/\s+/); const lines: string[] = []; let line = "";
    for (const w of words) { const next = line ? `${line} ${w}` : w; if (f.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next; }
    if (line) lines.push(line); return lines;
  };
  let y = 730;
  page.drawText(safe(heading), { x: 56, y, size: 20, font: bold, color: ink }); y -= 28;
  for (const line of wrap(intro, font, 11, 500)) { page.drawText(line, { x: 56, y, size: 11, font, color: soft }); y -= 16; }
  y -= 12;
  if (signaturePng) {
    const sig = await pdf.embedPng(signaturePng);
    const w = Math.min(260, sig.width), h = w * (sig.height / sig.width);
    page.drawImage(sig, { x: 56, y: y - h, width: w, height: h }); y -= h + 16;
  }
  for (const [label, value] of rows) {
    page.drawText(safe(label), { x: 56, y, size: 9, font: bold, color: soft }); y -= 13;
    for (const line of wrap(value, font, 10, 500)) { page.drawText(line, { x: 56, y, size: 10, font, color: ink }); y -= 14; }
    y -= 6;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
