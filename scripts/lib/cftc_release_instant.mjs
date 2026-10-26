/**
 * The CFTC releases the Commitments of Traders at 3:30 p.m. Eastern time
 * (Release Schedule; see docs/XAU_V2_DATA_REAL.md § 5). A declaration that
 * names an official publication basis must give that instant, to the
 * second: anything else contradicts the rule it cites (an earlier instant
 * would serve CFTC values before they were published). The schedule says
 * nothing about the date, which stays the operator's declaration.
 */

const EXPLICIT_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** True when `iso` is an explicit-zone instant at 15:30:00.000 America/New_York (EST or EDT). */
export function isCftcReleaseInstant(iso) {
  if (typeof iso !== 'string' || !EXPLICIT_ZONE.test(iso)) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms % 1000 !== 0) return false;
  return EASTERN.format(new Date(ms)) === '15:30:00';
}
