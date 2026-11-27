/**
 * One call = the whole payout-tracker pack (rows → summary → workbook + email) from a TrackerInput.
 * Used by the scheduled sender / portal download (product) and by the manual first run.
 */
import { buildRows } from './payout-tracker.rows';
import { buildSummary } from './payout-tracker.summary';
import { writeTrackerWorkbook } from './payout-tracker.excel';
import { renderTrackerEmail } from './payout-tracker.email';
import type { TrackerInput, TrackerRows, TrackerSummary } from './payout-tracker.types';

export interface TrackerPack {
  rows: TrackerRows;
  summary: TrackerSummary;
  workbook: Buffer;
  email: { subject: string; html: string; text: string };
  fileName: string;
}

export async function generateTrackerPack(input: TrackerInput, generatedAt: Date = new Date()): Promise<TrackerPack> {
  const rows = buildRows(input);
  const summary = buildSummary(rows);
  const workbook = await writeTrackerWorkbook(input, rows, summary, generatedAt);
  const email = renderTrackerEmail(input, summary);
  const safeClient = input.clientName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fileName = `${safeClient}-Payout-Tracker-${input.month}${input.provisional ? '-PROVISIONAL' : ''}.xlsx`;
  return { rows, summary, workbook, email, fileName };
}
