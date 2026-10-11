import { MockAvatarProvider } from "./mock.js";
import type { AvatarProvider } from "./types.js";

let instance: AvatarProvider | undefined;

export function getAvatarProvider(): AvatarProvider {
  instance ??= new MockAvatarProvider();
  return instance;
}

export function setAvatarProvider(p: AvatarProvider) {
  instance = p;
}

export type { AvatarProvider } from "./types.js";
