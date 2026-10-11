export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateInput {
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
}

export interface GenerateOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
}

/** Internal contract every language-model vendor adapter implements. */
export interface AIProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}
