/* ─── SO Declaration (Bajaj) — shared text + PDF helpers ──────────────────────────
   The SO Declaration KYC variant (see platform/docs/plans/SO-DECLARATION-KYC.md) captures
   a Sales-Officer declaration that is SO-signed at submission and ASM-signed at first-approve,
   producing a dual-signed PDF saved against the outlet.

   This module is the SINGLE source of truth for the declaration's wording + layout so the
   on-screen WYSIWYG (rep + ASM + Gifsy) and the generated PDF never drift. It is feature-gated
   to the SO_DECLARATION variant at every call site — STANDARD KYC never imports its output.

   Template source: scratchpad so-decl/SO-DECLARATION-TEMPLATE.txt (Bajaj "SO DECLARATION DRAFT").
   Bank line is worded generically ("Bajaj loyalty portal", NOT "Mobile application"); the program
   line uses the outlet's own programName.
─────────────────────────────────────────────────────────────────────────────── */

export interface SoDeclarationData {
  /** Logged-in rep (auto = submitting Sales Officer). */
  soName: string;
  /** Outlet owner / proprietor (reused from the enrollment owner name). */
  ownerName: string;
  /** New SO-declaration field: owner's father's name. */
  ownerFatherName: string;
  /** New SO-declaration field: owner's residence address. */
  ownerResidence: string;
  outletName: string;
  outletCode: string;
  /** Composed outlet street/city/state/pincode. */
  outletAddress: string;
  /** From the outlet master. */
  distributorName: string | null;
  distributorCode: string | null;
  /** Physical-verification date = submission date (ISO). */
  verificationDate: string;
  /** The outlet's programme name (e.g. "Unnati (Retailer)"). */
  programName: string | null;
  /** The first-approver's name (auto = the routed approver at approval; absent before approval). */
  asmName?: string | null;
  /** The first-approver's ACTUAL designation (sales hierarchy level name). When the ASM is vacant and
   *  an RSM approves, this reads "Regional Sales Manager" etc. Defaults to "Area Sales Manager". */
  asmDesignation?: string | null;
}

/** The default approver designation when none is captured (the standard ASM-approves case). */
export const DEFAULT_ASM_DESIGNATION = 'Area Sales Manager';

/** The approver designation to print — the real captured one, else the default. */
export function asmDesignationOf(d: Pick<SoDeclarationData, 'asmDesignation'>): string {
  return (d.asmDesignation ?? '').trim() || DEFAULT_ASM_DESIGNATION;
}

/** A run of declaration text; `v` marks a filled-in value (highlighted in the WYSIWYG). */
export type DeclSegment = { t: string; v?: boolean };

/** Addressee block (fixed BCCL registered office, per the client draft). */
export const BCCL_ADDRESS_LINES = [
  'Bajaj Consumer Care Limited (BCCL)',
  '1231, Solitaire Corporate Park,',
  '151, M. Vasanji Marg, Opp. Apple Heritage,',
  'Chakala, Andheri East, Mumbai- 400 093',
];

/** Generic name for the platform the bank details were uploaded on (owner decision). */
export const DECLARATION_BANK_APP_NAME = 'Bajaj loyalty portal';

const BLANK = '__________';
const fill = (s: string | null | undefined): string => {
  const v = (s ?? '').trim();
  return v.length ? v : BLANK;
};

/** Format an ISO date as en-IN "02 Oct 2026"; falls back to the raw string. */
export function formatDeclarationDate(iso: string | null | undefined): string {
  if (!iso) return BLANK;
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * The declaration body as an array of paragraphs, each a list of segments. Filled values
 * (`v: true`) are highlighted in the WYSIWYG and inlined as plain text in the PDF.
 */
export function declarationSegments(d: SoDeclarationData): DeclSegment[][] {
  const date = formatDeclarationDate(d.verificationDate);
  const outletNameAddress = [fill(d.outletName), d.outletAddress?.trim()].filter(Boolean).join(', ');
  return [
    [
      { t: 'I, ' },
      { t: fill(d.soName), v: true },
      { t: ', Sales Officer, Bajaj Consumer Care Limited, declare and certify that:' },
    ],
    [
      { t: 'Mr. ' },
      { t: fill(d.ownerName), v: true },
      { t: ' s/o Mr. ' },
      { t: fill(d.ownerFatherName), v: true },
      { t: ', resident of ' },
      { t: fill(d.ownerResidence), v: true },
      { t: ', is the registered owner / proprietor / partner of M/s ' },
      { t: outletNameAddress || BLANK, v: true },
      { t: ' (the "Eligible Outlet") bearing outlet code ' },
      { t: fill(d.outletCode), v: true },
      { t: '.' },
    ],
    [
      { t: 'The Eligible Outlet is serviced by M/s ' },
      { t: fill(d.distributorName), v: true },
      { t: ' bearing Distributor Code ' },
      { t: fill(d.distributorCode), v: true },
      { t: '. The outlet was found active during physical verification done by me on ' },
      { t: date, v: true },
      { t: '.' },
    ],
    [
      { t: 'Consent has been received from the registered owner / proprietor / partner to get enrolled under the ' },
      { t: fill(d.programName), v: true },
      { t: ' incentive program. Mr. ' },
      { t: fill(d.asmName), v: true },
      { t: ', ' },
      { t: asmDesignationOf(d), v: true },
      { t: ', BCCL has approved the aforesaid enrollment of the outlet.' },
    ],
    [
      {
        t:
          'The owner / proprietor / partner of the Eligible Outlet is not willing to provide KYC documents. ' +
          'Hence, please consider this declaration as a certificate of the existence and serviceability of the ' +
          'Outlet, and as proof of evidence for all future purposes and audit related queries.',
      },
    ],
    [
      { t: 'The bank account details uploaded on the ' },
      { t: DECLARATION_BANK_APP_NAME, v: true },
      {
        t:
          ' belong to the Eligible Outlet or its owner / proprietor / partner and are true to the best of my ' +
          'knowledge and belief.',
      },
    ],
  ];
}

/** Flatten paragraphs to plain strings (for the PDF body). */
export function declarationPlainText(d: SoDeclarationData): string[] {
  return declarationSegments(d).map((p) => p.map((s) => s.t).join(''));
}

/**
 * Render the declaration to a PDF Blob via jsPDF (already a platform dep). Embeds the ASM
 * signature image when provided (the live ink at approval) and shows both the Sales-Officer
 * and ASM names + dates. The SO's drawn signature is retained server-side as audit evidence
 * (soSignatureKey); when its image is available it is embedded too.
 */
export async function renderSoDeclarationPdf(
  d: SoDeclarationData,
  sigs: { soSignatureDataUrl?: string | null; asmSignatureDataUrl?: string | null } = {},
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PW = 210;
  const PH = 297; // A4 height (mm)
  const M = 20;
  const CW = PW - M * 2; // 170mm
  const BOTTOM = PH - M; // last usable y before the bottom margin
  let y = 20;
  /** Start a fresh page when the next block (≈ `need` mm) would overflow the bottom margin.
   *  Guards against very long owner / residence / address values pushing content — and the
   *  signature block — off the page. */
  const ensureSpace = (need: number) => {
    if (y + need > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };

  // ── Title ──
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(26, 26, 46);
  doc.text('SO DECLARATION', PW / 2, y, { align: 'center' });
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  doc.text('Bajaj Consumer Care Limited · Outlet Enrollment Declaration', PW / 2, y, { align: 'center' });
  y += 5;
  doc.setDrawColor(210, 210, 210);
  doc.line(M, y, PW - M, y);
  y += 9;

  // ── Addressee ──
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text('To,', M, y);
  y += 4.5;
  for (const line of BCCL_ADDRESS_LINES) {
    doc.text(line, M, y);
    y += 4.5;
  }
  y += 6;

  // ── Body paragraphs ──
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  for (const para of declarationPlainText(d)) {
    const lines = doc.splitTextToSize(para, CW) as string[];
    // Break to a new page when this paragraph would run past the bottom margin.
    ensureSpace(lines.length * 5.6 + 4);
    doc.text(lines, M, y);
    y += lines.length * 5.6 + 4;
  }
  y += 6;

  // ── Signature block (two columns) ──
  // Keep the whole signature block (images + ruled lines + names + two date lines ≈ 40mm)
  // together on one page — never let it spill off the bottom or split across pages.
  ensureSpace(40);
  const colW = (CW - 14) / 2;
  const soX = M;
  const asmX = M + colW + 14;
  const sigTop = y;
  const sigImgH = 18;
  const dateStr = formatDeclarationDate(d.verificationDate);

  // Signature images (if available) sit just above the ruled line.
  const lineY = sigTop + sigImgH + 2;
  const addSig = (dataUrl: string | null | undefined, x: number) => {
    if (!dataUrl) return;
    try {
      doc.addImage(dataUrl, 'PNG', x, sigTop, colW, sigImgH, undefined, 'FAST');
    } catch {
      /* ignore an unrenderable signature image — the name + line still print */
    }
  };
  addSig(sigs.soSignatureDataUrl, soX);
  addSig(sigs.asmSignatureDataUrl, asmX);

  doc.setDrawColor(80, 80, 80);
  doc.line(soX, lineY, soX + colW, lineY);
  doc.line(asmX, lineY, asmX + colW, lineY);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(26, 26, 46);
  doc.text(fill(d.soName), soX, lineY + 5);
  doc.text(fill(d.asmName), asmX, lineY + 5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  doc.text('Initiated by (Sales Officer)', soX, lineY + 10);
  // (ASM label below uses the actual approver designation.)
  doc.text(`Date: ${dateStr}`, soX, lineY + 14.5);
  doc.text(`Approved by (${asmDesignationOf(d)})`, asmX, lineY + 10);
  doc.text(`Date: ${dateStr}`, asmX, lineY + 14.5);

  return doc.output('blob');
}
