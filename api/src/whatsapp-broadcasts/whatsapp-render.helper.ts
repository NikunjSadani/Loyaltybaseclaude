/**
 * whatsapp-render.helper.ts — pure, unit-testable rendering primitives for WhatsApp
 * broadcasts. No Prisma / NestJS imports.
 *
 *   - variableIndexes / templateVariableCount — the {{1}}…{{n}} placeholders a body uses
 *   - deriveVariables      — FILTER mode: fill each template variable from a source field
 *                            or a constant, per the variableMapping
 *   - renderBody           — substitute ordered variables into a body's {{1}}…{{n}}
 */

/** One FILTER-mode variable mapping (var index → a source field key or a constant value). */
export interface VariableMapping {
  index: number;
  source?: string;
  value?: string;
}

/** The distinct 1-based placeholder indexes present in a template body ({{1}}, {{2}}, …). */
export function variableIndexes(bodyText: string): number[] {
  const found = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The variable count for a template: prefer the explicit variableContract length; fall
 * back to the highest {{n}} used in the body (so a template with no stored contract still
 * renders). Returns 0 when neither has variables.
 */
export function templateVariableCount(
  bodyText: string,
  variableContract?: { index: number }[] | null,
): number {
  if (Array.isArray(variableContract) && variableContract.length > 0) {
    return Math.max(...variableContract.map((v) => (Number.isInteger(v.index) ? v.index : 0)), 0);
  }
  const idx = variableIndexes(bodyText);
  return idx.length > 0 ? Math.max(...idx) : 0;
}

/**
 * FILTER mode — build the ordered variable-value array (index 1..count) for one recipient.
 * For each variable index: a mapping `value` (constant) wins; else its `source` reads the
 * recipient's `fields[source]`; else ''. Unmapped indexes are ''. The result is dense and
 * ordered so it can drop straight into renderBody / sendWhatsappTemplate's bodyValues.
 */
export function deriveVariables(
  fields: Record<string, string>,
  mappings: VariableMapping[] | undefined,
  count: number,
): string[] {
  const byIndex = new Map<number, VariableMapping>();
  for (const m of mappings ?? []) byIndex.set(m.index, m);

  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const m = byIndex.get(i);
    if (!m) {
      out.push('');
      continue;
    }
    if (m.value !== undefined && m.value !== null && m.value !== '') {
      out.push(String(m.value));
    } else if (m.source) {
      out.push(fields[m.source] ?? '');
    } else {
      out.push('');
    }
  }
  return out;
}

/**
 * Substitute ordered variables into a body's {{1}}…{{n}} placeholders. `variables[0]` fills
 * {{1}}, etc. A placeholder with no supplied value renders as '' (never left as literal
 * "{{n}}"), matching how MSG91 renders a missing body variable.
 */
export function renderBody(bodyText: string, variables: string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, d: string) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 1) return '';
    return variables[n - 1] ?? '';
  });
}
