// Calendar-date helpers on 'YYYY-MM-DD' strings, computed in UTC so plans
// never shift by a day because of the server's timezone.
const DAY_MS = 86_400_000;

const toUtc = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date: ${d}`);
  return Date.parse(`${d}T00:00:00Z`);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * DAY_MS);
export const diffDays = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
export const weekday = (d: string) => new Date(toUtc(d)).getUTCDay();

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Today's date in the given IANA timezone (default India). */
export function todayIn(timeZone = "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
