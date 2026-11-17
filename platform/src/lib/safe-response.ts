/* ─── Tolerant body reading for raw fetch() call sites (uploads / money screens) ───
   Companion to `lib/api-client.ts` (whose `api.*` request() is already tolerant) for the
   call sites that must use raw fetch() — multipart uploads, binary downloads.

   Proxied request bodies above the Next proxy's size cap are truncated before they
   reach the API, and the caller eventually gets a plain-text "Internal Server Error"
   (or an HTML 413 from the edge). A bare `await res.json()` then throws
   `SyntaxError: Unexpected token 'I'…` — which either leaks to the operator verbatim
   or, with no try/catch, leaves a spinner running forever. These helpers never throw.

   Kept in its own module (not api-client.ts) on purpose: many component tests mock
   `@/lib/api-client` with a closed factory, and a page importing new names from it
   would crash inside those tests. */

/** Parse a Response body as JSON; returns null for an empty / non-JSON body. Never throws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonSafe<T = any>(res: Response): Promise<T | null> {
  if (res.status === 204) return null;
  try {
    // res.json() rejects on an empty or non-JSON body (e.g. a plain-text "Internal Server Error")
    // — swallowed here so the caller decides the message.
    const body = (await res.json()) as T | null | undefined;
    return body ?? null;
  } catch {
    return null;
  }
}

/** Standard HTTP reason phrases. Nest's default exception body is `{ statusCode, message, error: 'Bad Request' }`
 *  — there `error` is just the phrase and the useful text is in `message`. */
const GENERIC_HTTP_PHRASES = new Set(
  [
    'Bad Request', 'Unauthorized', 'Payment Required', 'Forbidden', 'Not Found', 'Method Not Allowed',
    'Not Acceptable', 'Request Timeout', 'Conflict', 'Gone', 'Length Required', 'Precondition Failed',
    'Payload Too Large', 'Request Entity Too Large', 'Unsupported Media Type', 'Unprocessable Entity',
    'Unprocessable Content', 'Too Many Requests', 'Internal Server Error', 'Not Implemented', 'Bad Gateway',
    'Service Unavailable', 'Gateway Timeout',
  ].map((p) => p.toLowerCase()),
);

function messageText(message: unknown): string | null {
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string' && m.trim() !== '');
    return parts.length ? parts.join('; ') : null;
  }
  if (typeof message === 'string' && message.trim()) return message;
  return null;
}

/** The server's own error text from a `{ success:false, error }` (or Nest `{ message }`) body, if any.
 *  `error` wins, unless it is only a generic HTTP phrase ("Bad Request") and `message` says more. */
export function serverErrorText(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { error?: unknown; message?: unknown };
  const msg = messageText(j.message);
  if (typeof j.error === 'string' && j.error.trim()) {
    const generic = GENERIC_HTTP_PHRASES.has(j.error.trim().toLowerCase());
    if (generic && msg && msg.trim().toLowerCase() !== j.error.trim().toLowerCase()) return msg;
    return j.error;
  }
  return msg;
}

export const FILE_TOO_LARGE_MESSAGE =
  'The file is too large to upload. Try a smaller file (or split it into smaller files).';

/** Appended to a "server didn't respond properly" message when the request only previewed / read. */
export const NOTHING_SAVED_NOTE = 'Nothing was saved — please try again.';
/** Appended when the request could have written data before the response was lost. */
export const MAYBE_SAVED_NOTE =
  'Some or all of it may have been saved — refresh and check before trying again.';
/** Appended for an in-form PHOTO / media upload: the photo only counts once the form is submitted with
 *  its key, so a lost upload attaches nothing and loses nothing else — the user just retries that photo.
 *  (Never tell a rep to "refresh" — that would throw away the captured photos / GPS in the form.) */
export const PHOTO_UPLOAD_RETRY_NOTE =
  "The photo wasn't uploaded — try that photo again. Nothing else in the form is lost.";

/**
 * A readable, honest message for a failed (or unreadable) upload / money response.
 * - The server's own `error` text wins when the body is JSON.
 * - 413 → the file is too large.
 * - Anything else non-JSON → "the server didn't respond properly" + `savedNote`
 *   (say whether anything may have been saved — the caller knows if the request writes).
 */
export function responseErrorMessage(
  res: { status: number },
  json: unknown,
  savedNote: string = MAYBE_SAVED_NOTE,
): string {
  const server = serverErrorText(json);
  if (server) return server;
  if (res.status === 413) return FILE_TOO_LARGE_MESSAGE;
  return `The server didn't respond properly (HTTP ${res.status}). ${savedNote}`.trim();
}

/** Message for a fetch() that threw (network drop / aborted) — the outcome is unknown. */
export function networkErrorMessage(savedNote: string = MAYBE_SAVED_NOTE): string {
  return `Couldn't reach the server (network error). ${savedNote}`.trim();
}
