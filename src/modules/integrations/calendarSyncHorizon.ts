/**
 * Rolling window for Google Calendar push/pull/retry.
 * Keep aligned with planner materialization (~3 months) so future weeks
 * appear in Google, not only on Personal OS web.
 */
export const GOOGLE_SYNC_HORIZON_DAYS = 92;
