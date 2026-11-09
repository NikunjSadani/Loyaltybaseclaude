/**
 * Streaming RFC-4180 CSV reader (plan §7.1 step 6 / task I-3). No dependency.
 *
 * - quotes, `""` escapes, delimiters and newlines inside quotes; CRLF, LF or lone CR line ends;
 * - a leading UTF-8 BOM is dropped; multi-byte UTF-8 split across chunks is decoded correctly;
 * - the delimiter is auto-detected (`,` `;` `\t`, most frequent outside quotes in the first 256 KiB)
 *   unless given;
 * - blank lines are skipped; `rowNo` is the 1-based physical line where the record starts.
 * Lenient on malformed quoting (a stray quote inside an unquoted field is kept literally).
 */
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SourceRow } from './header';

const SNIFF_CHARS = 256 * 1024;
const CANDIDATES = [',', ';', '\t'] as const;

/** Count candidate delimiters outside quotes. Ties / none → ','. */
export function sniffDelimiter(sample: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const c of CANDIDATES) if (counts[c] > counts[best]) best = c;
  return best;
}

export async function* csvRows(stream: Readable | AsyncIterable<Buffer | string>, delimiter?: string): AsyncGenerator<SourceRow> {
  const decoder = new StringDecoder('utf8');
  let delim = delimiter;
  let pending = ''; // text not yet parsed (sniff buffer before the delimiter is known)
  let first = true;

  // Parser state carried across chunks.
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quoteClosed = false; // just saw the closing quote of a quoted field
  let afterCR = false;     // previous char was a CR outside quotes (swallow a following LF)
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;
  let pendingQuote = false; // a closing-quote candidate was the last char of the previous chunk

  const out: SourceRow[] = [];

  const endRecord = () => {
    record.push(field);
    const blank = record.length === 1 && record[0] === '' && !fieldStarted;
    if (!blank) out.push({ rowNo: recordLine, cells: record });
    record = [];
    field = '';
    fieldStarted = false;
    quoteClosed = false;
  };

  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (afterCR) {
        afterCR = false;
        if (ch === '\n') continue; // CRLF: the record already ended at the CR
      }
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else if (i + 1 === text.length) {
            // Can't see the next char yet: decide on the next feed via a sentinel.
            inQuotes = false;
            quoteClosed = true;
            pendingQuote = true;
          } else {
            inQuotes = false;
            quoteClosed = true;
          }
        } else {
          if (ch === '\n') line++;
          else if (ch === '\r' && text[i + 1] !== '\n') line++;
          field += ch;
        }
        continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          // It was an escaped quote split across chunks: reopen.
          field += '"';
          inQuotes = true;
          quoteClosed = false;
          continue;
        }
      }
      if (ch === delim) {
        record.push(field);
        field = '';
        fieldStarted = true;
        quoteClosed = false;
      } else if (ch === '\n' || ch === '\r') {
        endRecord();
        line++;
        recordLine = line;
        if (ch === '\r') afterCR = true;
      } else if (ch === '"' && field === '' && !quoteClosed) {
        inQuotes = true;
        fieldStarted = true;
      } else {
        field += ch;
        fieldStarted = true;
      }
    }
  };

  const consume = (text: string) => {
    if (first) {
      text = text.replace(/^﻿/, '');
      if (text === '') return;
      first = false;
    }
    if (delim === undefined) {
      pending += text;
      if (pending.length < SNIFF_CHARS) return;
      delim = sniffDelimiter(pending);
      text = pending;
      pending = '';
    }
    feed(text);
  };

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    for (const r of out.splice(0)) yield r;
  }
  consume(decoder.end());
  if (delim === undefined) {
    delim = sniffDelimiter(pending);
    const text = pending;
    pending = '';
    feed(text);
  }
  pendingQuote = false;
  if (field !== '' || record.length > 0 || fieldStarted) endRecord();
  for (const r of out.splice(0)) yield r;
}
