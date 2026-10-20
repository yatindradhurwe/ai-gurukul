/**
 * Built-in book lists by board, grade and subject, for schools to import and edit.
 *
 * - CBSE: NCERT textbooks (the new NCF-2023 books for Class 1–8, the current
 *   books for Class 9–12). NCERT revises titles; schools should check the list
 *   against the current NCERT catalogue each session.
 * - ICSE / ISC: CISCE does not prescribe publishers for most subjects, so these
 *   are widely used titles that a school confirms or replaces.
 * - State Board: every state publishes its own textbooks, so these are one
 *   textbook per subject published by the state board the school names.
 */
export const BOARDS = [
  { id: "CBSE", label: "CBSE (NCERT books)" },
  { id: "ICSE", label: "ICSE / ISC (CISCE)" },
  { id: "State Board", label: "State Board" },
] as const;
export type BoardId = (typeof BOARDS)[number]["id"];

export interface CatalogueBook {
  subject: string;
  title: string;
  kind: "textbook" | "workbook" | "reference" | "lab_manual" | "other";
  author: string;
  publisher: string;
  note: string;
}

/** The subjects a new section starts with, by board and grade. */
export function defaultSubjects(grade: number, board: string = "CBSE"): string[] {
  const icse = board.toUpperCase().startsWith("IC") || board.toUpperCase() === "ISC";
  if (grade <= 2) return ["English", "Hindi", "Mathematics"];
  if (grade <= 5) return ["English", "Hindi", "Mathematics", "EVS"];
  if (icse && grade <= 10) return ["English", "Hindi", "Mathematics", "Physics", "Chemistry", "Biology", "History & Civics", "Geography"];
  if (grade <= 8) return ["English", "Hindi", "Sanskrit", "Mathematics", "Science", "Social Science"];
  if (grade <= 10) return ["English", "Hindi", "Mathematics", "Science", "Social Science"];
  return ["English", "Physics", "Chemistry", "Mathematics", "Biology"];
}

const NCERT = "NCERT";
const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const book = (subject: string, title: string, publisher: string, note = "", kind: CatalogueBook["kind"] = "textbook", author = ""): CatalogueBook => ({ subject, title, kind, author, publisher, note });

function ncert(g: number): CatalogueBook[] {
  const c = `Class ${roman[g]}`;
  if (g <= 2)
    return [book("English", `Mridang — ${c}`, NCERT), book("Hindi", `Sarangi (सारंगी) — ${c}`, NCERT), book("Mathematics", `Joyful Mathematics — ${c}`, NCERT)];
  if (g <= 5)
    return [
      book("English", `Santoor — ${c}`, NCERT),
      book("Hindi", `Veena (वीणा) — ${c}`, NCERT),
      book("Mathematics", `Maths Mela — ${c}`, NCERT),
      book("EVS", `Our Wondrous World — ${c}`, NCERT, "The World Around Us"),
    ];
  if (g <= 8)
    return [
      book("English", `Poorvi — ${c}`, NCERT),
      book("Hindi", `Malhar (मल्हार) — ${c}`, NCERT),
      book("Sanskrit", `Deepakam (दीपकम्) — ${c}`, NCERT),
      book("Mathematics", `Ganita Prakash — ${c}`, NCERT),
      book("Science", `Curiosity — ${c}`, NCERT),
      book("Social Science", `Exploring Society: India and Beyond — ${c}`, NCERT),
    ];
  if (g <= 10) {
    const n = g === 9 ? "" : " – 2";
    const part = g === 9 ? "I" : "II";
    return [
      book("English", g === 9 ? "Beehive — Class IX" : "First Flight — Class X", NCERT),
      book("English", g === 9 ? "Moments — Supplementary Reader, Class IX" : "Footprints without Feet — Supplementary Reader, Class X", NCERT, "", "reference"),
      book("Hindi", `Kshitij (क्षितिज)${n} — ${c}`, NCERT, "Hindi Course A"),
      book("Hindi", `Kritika (कृतिका)${n} — ${c}`, NCERT, "Hindi Course A supplementary", "reference"),
      book("Sanskrit", `Shemushi (शेमुषी)${n} — ${c}`, NCERT),
      book("Mathematics", `Mathematics — ${c}`, NCERT),
      book("Science", `Science — ${c}`, NCERT),
      book("Social Science", `India and the Contemporary World – ${part} (History) — ${c}`, NCERT),
      book("Social Science", `Contemporary India – ${part} (Geography) — ${c}`, NCERT),
      book("Social Science", `Democratic Politics – ${part} (Political Science) — ${c}`, NCERT),
      book("Social Science", g === 9 ? "Economics — Class IX" : "Understanding Economic Development — Class X", NCERT),
    ];
  }
  return [
    book("English", g === 11 ? "Hornbill — Class XI" : "Flamingo — Class XII", NCERT),
    book("English", g === 11 ? "Snapshots — Supplementary Reader, Class XI" : "Vistas — Supplementary Reader, Class XII", NCERT, "", "reference"),
    book("Hindi", g === 11 ? "Aroh (आरोह) — Class XI" : "Aroh (आरोह) — Class XII", NCERT, "Hindi Core"),
    book("Hindi", g === 11 ? "Vitan (वितान) — Class XI" : "Vitan (वितान) — Class XII", NCERT, "Hindi Core supplementary", "reference"),
    book("Physics", `Physics Part I — ${c}`, NCERT),
    book("Physics", `Physics Part II — ${c}`, NCERT),
    book("Chemistry", `Chemistry Part I — ${c}`, NCERT),
    book("Chemistry", `Chemistry Part II — ${c}`, NCERT),
    ...(g === 11 ? [book("Mathematics", "Mathematics — Class XI", NCERT)] : [book("Mathematics", "Mathematics Part I — Class XII", NCERT), book("Mathematics", "Mathematics Part II — Class XII", NCERT)]),
    book("Biology", `Biology — ${c}`, NCERT),
  ];
}

const CONFIRM = "Commonly used; confirm against your school's book list";
function icse(g: number): CatalogueBook[] {
  const c = `Class ${g}`;
  if (g <= 5) return []; // No board-prescribed books; schools choose their own series.
  if (g <= 8)
    return [
      book("Physics", `Concise Physics Middle School — ${c}`, "Selina Publishers", CONFIRM),
      book("Chemistry", `Concise Chemistry Middle School — ${c}`, "Selina Publishers", CONFIRM),
      book("Biology", `Concise Biology Middle School — ${c}`, "Selina Publishers", CONFIRM),
      book("Mathematics", `Concise Mathematics Middle School — ${c}`, "Selina Publishers", CONFIRM),
      book("History & Civics", `Total History & Civics — ${c}`, "Morning Star", CONFIRM),
      book("Geography", `Total Geography — ${c}`, "Morning Star", CONFIRM),
      book("English", `Total English — ${c}`, "Morning Star", CONFIRM),
    ];
  if (g <= 10)
    return [
      book("English", `Total English — ${c}`, "Morning Star", "English Language. " + CONFIRM),
      book("English", "Treasure Trove — A Collection of ICSE Poems and Short Stories", "Evergreen Publications", "English Literature anthology prescribed by CISCE; check the current year's prescribed texts"),
      book("Hindi", "Sahitya Sagar (साहित्य सागर)", "Evergreen Publications", "Hindi prose and poetry; check the current year's prescribed texts"),
      book("Hindi", "Ekanki Sanchay (एकांकी संचय)", "Evergreen Publications", "Hindi one-act plays; check the current year's prescribed texts", "reference"),
      book("Mathematics", `Concise Mathematics — ${c}`, "Selina Publishers", CONFIRM),
      book("Mathematics", `Understanding ICSE Mathematics — ${c}`, "Avichal Publishing", CONFIRM, "reference", "M. L. Aggarwal"),
      book("Physics", `Concise Physics — ${c}`, "Selina Publishers", CONFIRM),
      book("Chemistry", `Concise Chemistry — ${c}`, "Selina Publishers", CONFIRM),
      book("Biology", `Concise Biology — ${c}`, "Selina Publishers", CONFIRM),
      book("History & Civics", `Total History & Civics — ${c}`, "Morning Star", CONFIRM),
      book("Geography", `Total Geography — ${c}`, "Morning Star", CONFIRM),
    ];
  return [
    book("English", `ISC English — prescribed texts, ${c}`, "CISCE", "See CISCE regulations for this year's prescribed literature texts", "other"),
    book("Physics", `Nootan ISC Physics — ${c}`, "Nageen Prakashan", CONFIRM),
    book("Chemistry", `Nootan ISC Chemistry — ${c}`, "Nageen Prakashan", CONFIRM),
    book("Mathematics", `ISC Mathematics — ${c}`, "S. Chand", CONFIRM, "textbook", "O. P. Malhotra, S. K. Gupta, A. Gangwal"),
    book("Biology", `ISC Biology — ${c}`, "Avichal Publishing", CONFIRM, "textbook", "Sarita Aggarwal"),
  ];
}

function stateBoard(g: number, publisher: string): CatalogueBook[] {
  const note = "State textbook; set the exact title from your state's book list";
  return defaultSubjects(g, "State Board").map((s) => book(s, `${s} — Class ${g}`, publisher, note));
}

/** The built-in list for a board and grade (1–12). */
export function catalogue(board: string, grade: number, statePublisher = "State Textbook Board"): CatalogueBook[] {
  const b = board.toUpperCase();
  if (b === "CBSE" || b === "NCERT") return ncert(grade);
  if (b === "ICSE" || b === "ISC") return icse(grade);
  return stateBoard(grade, statePublisher.trim() || "State Textbook Board");
}
