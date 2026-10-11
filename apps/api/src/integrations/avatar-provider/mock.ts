import { randomUUID } from "node:crypto";
import type { AvatarJobStatus, AvatarProvider } from "./types.js";

/**
 * Stand-in until a licensed avatar vendor is contracted. Jobs "complete" on
 * the second status poll. Scripts containing "[[fail]]" fail, which lets tests
 * prove that avatar failures never block access to the text lesson.
 */
export class MockAvatarProvider implements AvatarProvider {
  readonly name = "mock";
  private jobs = new Map<string, { polls: number; fail: boolean }>();

  async createSession(_input: { avatarId: string; language: string; contextId: string }) {
    return {
      sessionId: `mock-session-${randomUUID()}`,
      clientToken: `mock-token-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async renderLesson(input: { script: string; avatarId: string; language: string }) {
    const jobId = `mock-job-${randomUUID()}`;
    this.jobs.set(jobId, { polls: 0, fail: input.script.includes("[[fail]]") });
    return { jobId, status: "queued" as const };
  }

  async getJobStatus(jobId: string): Promise<{ status: AvatarJobStatus; mediaKey?: string; error?: string }> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: "failed", error: "unknown job" };
    job.polls++;
    if (job.fail) return { status: "failed", error: "Avatar provider rendering failed" };
    if (job.polls < 2) return { status: "processing" };
    return { status: "completed", mediaKey: `${jobId}.mp4` };
  }
}
