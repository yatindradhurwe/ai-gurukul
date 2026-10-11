// Internal contract; each vendor adapter maps it onto the vendor's real API.
export type AvatarJobStatus = "queued" | "processing" | "completed" | "failed";

export interface AvatarProvider {
  readonly name: string;

  createSession(input: { avatarId: string; language: string; contextId: string }): Promise<{
    sessionId: string;
    clientToken?: string;
    expiresAt?: string;
  }>;

  renderLesson(input: { script: string; avatarId: string; language: string }): Promise<{
    jobId: string;
    status: "queued" | "processing";
  }>;

  getJobStatus(jobId: string): Promise<{ status: AvatarJobStatus; mediaKey?: string; error?: string }>;
}
