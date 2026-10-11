import { env } from "../../config/env.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockAIProvider } from "./mock.js";
import type { AIProvider } from "./types.js";

let instance: AIProvider | undefined;

export function getAIProvider(): AIProvider {
  instance ??= env.AI_PROVIDER === "anthropic" ? new AnthropicProvider(env.ANTHROPIC_API_KEY ?? "", env.ANTHROPIC_MODEL) : new MockAIProvider();
  return instance;
}

export function setAIProvider(p: AIProvider) {
  instance = p;
}

export type { AIProvider } from "./types.js";
