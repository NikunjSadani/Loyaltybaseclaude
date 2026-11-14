/**
 * Engine-internal constants of the Downloads page (platform/docs/plans/DOWNLOADS-PAGE.md). The values the screens
 * also need (retention days, active cap) live in exports.contract.ts.
 */

/** The worker writes a heartbeat this often while a file is being prepared. */
export const EXPORT_HEARTBEAT_MS = 15_000;
/** A RUNNING request whose heartbeat is older than this is reclaimable (its worker died / was OOM-killed). */
export const EXPORT_STALE_HEARTBEAT_MINUTES = 5;
/** Claims per request before it is FAILED (a report that kills its worker every time must not loop forever). */
export const EXPORT_MAX_ATTEMPTS = 3;
/** A stop (deploy / scale-down) this soon after the claim does not count as an attempt. */
export const EXPORT_STOP_RESTORES_ATTEMPT_WITHIN_MS = 60_000;
/** Rows (any final status) are deleted this long after they were requested. */
export const EXPORT_ROW_PURGE_DAYS = 30;
/** A request still QUEUED after this long is FAILED (the worker never started — e.g. the job IAM grant is missing). */
export const EXPORT_QUEUED_GIVE_UP_HOURS = 24;
/** The list endpoint kicks the worker when a request has waited this long (self-heal; scheduler drain optional). */
export const EXPORT_SELF_HEAL_AFTER_MS = 2 * 60_000;
/** At most one self-heal kick per API instance per this window. */
export const EXPORT_SELF_HEAL_MIN_INTERVAL_MS = 60_000;
/**
 * A QUEUED request older than this no longer counts toward the 3-active cap and is never returned as a de-duplicated
 * "already being prepared" request (the worker never picked it up; it must not block new requests).
 */
export const EXPORT_STUCK_QUEUED_MS = 15 * 60_000;
/** The API runs the retention sweep (Downloads list) at most this often per instance. */
export const EXPORT_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
/** An instant (light) download that makes no progress for this long (stalled client) is aborted and its slot freed. */
export const EXPORT_INSTANT_IDLE_MS = 2 * 60_000;
/** Rows touched per retention sweep (bounded so a sweep is always short). */
export const EXPORT_SWEEP_LIMIT = 50;
/** Downloads page page size. */
export const EXPORT_LIST_PAGE_SIZE = 20;

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Plain-English messages (shown to people as-is).
export const EXPORT_QUEUED_MESSAGE = "We're preparing your file — it will appear under Downloads (usually 1–5 minutes).";
export const EXPORT_NOT_CONFIGURED_MESSAGE = "Downloads aren't set up on this server yet. Please contact Gifsy support.";
export const EXPORT_TOO_MANY_ACTIVE_MESSAGE =
  'You already have 3 files being prepared. Please wait for one of them to finish (see Downloads), then try again.';
export const EXPORT_FAILED_MESSAGE = "We couldn't prepare this file. Please try again; if it keeps failing, contact Gifsy support.";
export const EXPORT_GAVE_UP_MESSAGE = "We couldn't prepare this file after several tries. Please contact Gifsy support.";
export const EXPORT_ALREADY_QUEUED_MESSAGE =
  "This file is already being prepared — it will appear under Downloads (usually 1–5 minutes).";
export const EXPORT_COULD_NOT_START_MESSAGE = "Downloads couldn't start on the server. Please try again later or contact Gifsy.";
export const EXPORT_NEVER_STARTED_MESSAGE = "This file couldn't be started. Please request it again.";
export const EXPORT_UNKNOWN_KIND_MESSAGE = 'This report type is no longer available.';
