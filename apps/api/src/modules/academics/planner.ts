/**
 * Syllabus coverage planner: spreads a subject's chapters over the real
 * teaching days of the year, term by term. Pure functions — no database —
 * so the schedule is easy to test and explain.
 */

export interface Term {
  seq: number;
  name: string;
  start: string; // YYYY-MM-DD
  end: string;
  examStart: string | null;
  examEnd: string | null;
}

export interface TeachingDay {
  date: string;
  capacity: number; // periods of this subject on that day
  termSeq: number | null;
}

export interface PlanUnit {
  id: string;
  est: number; // estimated periods
  termSeq: number | null; // fixed term, or null to let the planner choose
}

export interface Allocation {
  unitId: string;
  termSeq: number | null;
  start: string | null;
  end: string | null;
  periods: number;
}

const DAY = 86400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** ISO weekday, Monday = 1 … Sunday = 7. */
export const isoDow = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * Teaching days between from and to (inclusive): Monday–Saturday, not a holiday,
 * not inside an exam window. When terms are given, only days in a term before its
 * exams count, and each day is tagged with its term.
 */
export function teachingDays(opts: {
  from: string;
  to: string;
  holidays: Set<string>;
  terms: Term[];
  capacityFor: (isoDow: number) => number;
}): TeachingDay[] {
  const days: TeachingDay[] = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    const dow = isoDow(d);
    if (dow === 7 || opts.holidays.has(d)) continue;
    let termSeq: number | null = null;
    if (opts.terms.length) {
      const t = opts.terms.find((x) => d >= x.start && d <= x.end);
      if (!t) continue;
      if (t.examStart && d >= t.examStart) continue; // exam days and the rest of the term after exams
      termSeq = t.seq;
    }
    const capacity = opts.capacityFor(dow);
    if (capacity > 0) days.push({ date: d, capacity, termSeq });
  }
  return days;
}

/**
 * Give every unit a term: fixed ones keep theirs; the rest follow syllabus order,
 * placed where their share of the syllabus falls within the terms' share of teaching time.
 */
export function assignTerms(units: PlanUnit[], terms: Term[], days: TeachingDay[]): (number | null)[] {
  if (!terms.length) return units.map(() => null);
  const seqs = [...terms].sort((a, b) => a.seq - b.seq).map((t) => t.seq);
  const cap = seqs.map((s) => days.filter((d) => d.termSeq === s).reduce((t, d) => t + d.capacity, 0));
  const total = cap.reduce((t, c) => t + c, 0);
  const totalEst = units.reduce((t, u) => t + u.est, 0) || 1;
  const cumCap = cap.map((_, i) => cap.slice(0, i + 1).reduce((t, c) => t + c, 0) / (total || 1));
  let running = 0;
  let floor = seqs[0];
  return units.map((u) => {
    const mid = (running + u.est / 2) / totalEst;
    running += u.est;
    let seq = u.termSeq ?? seqs[Math.max(0, cumCap.findIndex((c) => c >= mid - 1e-9))] ?? seqs[seqs.length - 1];
    if (u.termSeq == null && seq < floor) seq = floor; // never go back to an earlier term
    floor = Math.max(floor, seq);
    return seq;
  });
}

/** Lay units out over teaching days in order; compress proportionally if a window is too short. */
export function planUnits(units: PlanUnit[], terms: Term[], days: TeachingDay[]): { allocations: Allocation[]; warnings: string[] } {
  const termOf = assignTerms(units, terms, days);
  const windows = terms.length ? [...terms].sort((a, b) => a.seq - b.seq).map((t) => ({ seq: t.seq as number | null, name: t.name })) : [{ seq: null, name: "The year" }];
  const allocations: Allocation[] = [];
  const warnings: string[] = [];
  for (const w of windows) {
    const mine = units.map((u, i) => ({ u, i })).filter((x) => termOf[x.i] === w.seq);
    if (!mine.length) continue;
    const wd = days.filter((d) => d.termSeq === w.seq);
    const capacity = wd.reduce((t, d) => t + d.capacity, 0);
    const need = mine.reduce((t, x) => t + x.u.est, 0);
    if (capacity <= 0) {
      warnings.push(`${w.name}: no teaching days left for ${mine.length} chapter(s)`);
      for (const x of mine) allocations[x.i] = { unitId: x.u.id, termSeq: w.seq, start: null, end: null, periods: 0 };
      continue;
    }
    const scale = need > capacity ? capacity / need : 1;
    if (scale < 1) warnings.push(`${w.name}: the syllabus needs ${need} periods but only ${Math.round(capacity)} are available — chapters are compressed`);
    let i = 0;
    let rem = wd[0].capacity;
    for (const x of mine) {
      let left = x.u.est * scale;
      while (rem <= 1e-9 && i < wd.length - 1) rem = wd[++i].capacity;
      const start = wd[i].date;
      while (left > 1e-9) {
        const take = Math.min(left, rem);
        left -= take;
        rem -= take;
        if (left > 1e-9) {
          if (i >= wd.length - 1) break;
          rem = wd[++i].capacity;
        }
      }
      allocations[x.i] = { unitId: x.u.id, termSeq: w.seq, start, end: wd[i].date, periods: Math.round(x.u.est * scale * 10) / 10 };
    }
  }
  return { allocations, warnings };
}
