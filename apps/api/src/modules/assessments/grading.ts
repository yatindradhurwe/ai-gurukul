export type QuestionType = "mcq" | "numeric" | "short_answer" | "descriptive";

export interface GradableQuestion {
  id: string;
  type: QuestionType;
  marks: number;
  answer_key: unknown;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, " ").trim();

/** Objective questions are auto-scored; descriptive answers wait for a teacher (null). */
export function gradeAnswer(q: GradableQuestion, answer: unknown): number | null {
  const key = (q.answer_key ?? {}) as Record<string, unknown>;
  const a = (answer ?? {}) as Record<string, unknown>;
  switch (q.type) {
    case "mcq":
      return Number.isInteger(a.choice) && a.choice === key.correct ? q.marks : 0;
    case "numeric": {
      const value = Number(a.value);
      const expected = Number(key.value);
      const tolerance = Number(key.tolerance ?? 0);
      return Number.isFinite(value) && Math.abs(value - expected) <= tolerance ? q.marks : 0;
    }
    case "short_answer": {
      const accepted = Array.isArray(key.accepted) ? (key.accepted as string[]).map(normalize) : [];
      return typeof a.text === "string" && accepted.includes(normalize(a.text)) ? q.marks : 0;
    }
    case "descriptive":
      return null;
  }
}

/** Blend new assessment evidence with the previous measured mastery (recent evidence weighs more). */
export function blendMastery(previous: number | null, observed: number): number {
  const v = previous == null ? observed : 0.6 * observed + 0.4 * previous;
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}
