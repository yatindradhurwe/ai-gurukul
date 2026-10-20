/**
 * Holidays a school can load into its calendar in one step.
 *
 * Fixed national holidays are generated for any year. Festival dates that follow
 * the lunar calendar change every year and differ between states, so they are
 * provided only for the 2026-27 session, marked approximate, and every school
 * should check them against its state's official list and edit as needed.
 */

export interface Holiday {
  date: string;
  name: string;
  approximate: boolean;
}

const FIXED: [string, string][] = [
  ["01-26", "Republic Day"],
  ["04-14", "Dr. B. R. Ambedkar Jayanti"],
  ["08-15", "Independence Day"],
  ["10-02", "Gandhi Jayanti"],
  ["12-25", "Christmas"],
];

const FESTIVALS_2026_27: [string, string][] = [
  ["2026-04-03", "Good Friday"],
  ["2026-05-01", "Buddha Purnima"],
  ["2026-05-27", "Id-ul-Zuha (Bakrid)"],
  ["2026-06-26", "Muharram"],
  ["2026-08-26", "Milad-un-Nabi"],
  ["2026-08-28", "Raksha Bandhan"],
  ["2026-09-04", "Janmashtami"],
  ["2026-09-14", "Ganesh Chaturthi"],
  ["2026-10-20", "Dussehra"],
  ["2026-11-08", "Diwali"],
  ["2026-11-24", "Guru Nanak Jayanti"],
  ["2027-01-14", "Makar Sankranti / Pongal"],
  ["2027-03-06", "Maha Shivaratri"],
  ["2027-03-10", "Id-ul-Fitr"],
  ["2027-03-22", "Holi"],
];

/** Holidays falling between from and to (inclusive), sorted by date. */
export function holidaysBetween(from: string, to: string): Holiday[] {
  const out: Holiday[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const [md, name] of FIXED) out.push({ date: `${y}-${md}`, name, approximate: false });
  }
  for (const [date, name] of FESTIVALS_2026_27) out.push({ date, name, approximate: true });
  return out.filter((h) => h.date >= from && h.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
