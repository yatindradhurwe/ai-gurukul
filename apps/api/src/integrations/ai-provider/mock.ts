import type { AIProvider, GenerateInput, GenerateOutput } from "./types.js";

/**
 * Offline, deterministic provider for development and tests. It answers only
 * from the sources included in the prompt (extractive), so it exercises the
 * grounding + citation pipeline without network access or API cost.
 */
export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const question = input.messages.at(-1)?.content ?? "";
    const sources = [...input.system.matchAll(/<source id="(S\d+)"[^>]*>\n?([\s\S]*?)<\/source>/g)].map((m) => ({
      id: m[1],
      text: m[2].trim(),
    }));
    let text: string;
    if (sources.length === 0) {
      text =
        "I couldn't find this in your approved course material, so I'm not certain. " +
        "Please check your textbook or ask your teacher, and I can help you work through it step by step.";
    } else {
      const words = new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      const ranked = sources
        .flatMap((s) => s.text.split(/(?<=[.!?])\s+/).map((sentence) => ({ id: s.id, sentence })))
        .map((x) => ({ ...x, hits: (x.sentence.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 3);
      text =
        "Here's what your course material says:\n\n" +
        ranked.map((r) => `- ${r.sentence} [${r.id}]`).join("\n") +
        "\n\nTry this: explain the idea in your own words, then I'll give you a practice question.";
    }
    const tokens = (s: string) => Math.ceil(s.length / 4);
    return {
      text,
      usage: { inputTokens: tokens(input.system + question), outputTokens: tokens(text) },
      provider: this.name,
      model: "mock-extractive",
    };
  }
}
