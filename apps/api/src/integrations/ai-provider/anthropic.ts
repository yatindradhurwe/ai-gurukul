import type { AIProvider, GenerateInput, GenerateOutput } from "./types.js";

/** Adapter for the Anthropic Messages API. Keys stay server-side only. */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";

  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl = "https://api.anthropic.com",
  ) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: input.maxTokens ?? 1024,
        system: input.system,
        messages: input.messages,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };
    return {
      text: body.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
      usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens },
      provider: this.name,
      model: body.model,
    };
  }
}
