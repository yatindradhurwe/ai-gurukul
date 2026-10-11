// The avatar teaches only approved lesson content: the script is built
// deterministically from the published lesson, never invented by a model.

export interface ScriptSegment {
  title: string;
  text: string;
}

const WORDS_PER_MINUTE = 150; // typical classroom narration pace

export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round((words / WORDS_PER_MINUTE) * 60));
}

/** Split a lesson into short spoken segments (2–3 sentences) with an intro and a doubt-time close. */
export function buildTeachingScript(lesson: { title: string; topic: string; content: string }, maxSentences = 3): ScriptSegment[] {
  const segments: ScriptSegment[] = [
    {
      title: "Introduction",
      text: `Namaste, class! Today we are going to learn about ${lesson.topic}. If anything is unclear, ask me your doubt at any time — just tap the microphone or type it.`,
    },
  ];
  const paragraphs = lesson.content
    .replace(/[#*_`>]/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let part = 1;
  for (const p of paragraphs) {
    const sentences = p.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (let i = 0; i < sentences.length; i += maxSentences) {
      segments.push({ title: `${lesson.title} — part ${part++}`, text: sentences.slice(i, i + maxSentences).join(" ") });
    }
  }
  segments.push({
    title: "Doubt time",
    text: `That's the end of today's lesson on ${lesson.topic}. Now it's doubt time — ask me anything you didn't understand.`,
  });
  return segments;
}
