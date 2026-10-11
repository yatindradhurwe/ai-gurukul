# REST API reference (`/api/v1`)

**Conventions**

- **Authentication.** Send `Authorization: Bearer <accessToken>`. Access tokens live for 15 minutes. Use `POST /auth/refresh` to get a new one; each refresh token is single-use and rotates.
- **Tenant selection.** Tenant-scoped routes need `X-Tenant-Id` (or `X-Tenant-Slug`), or a verified custom domain. The server checks your membership on every request.
- **Errors.** Errors come back as `{ "error": { "code", "message", "details?" } }`:

  | Status | Meaning |
  | --- | --- |
  | 400 | Validation failed |
  | 401 | Not authenticated |
  | 402 | Quota or seat limit reached |
  | 403 | Not permitted |
  | 404 | Not found, or invisible under RLS |
  | 409 | Conflict, such as a duplicate submission |
  | 429 | Rate limited |

- **Requests.** Request bodies are validated with zod; the schemas live next to each route in `apps/api/src/modules/*/routes.ts`.

In the tables below, a route with permission "—" needs no permission check. Routes with several permissions accept any one of them.

## Auth

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | — | `{name,email,password,accountType: student\|parent}` → creates a personal or family workspace and returns tokens |
| POST | `/auth/login` | — | Returns `accessToken` and `refreshToken` |
| POST | `/auth/refresh` | — | Rotates the refresh token. Reusing an old one revokes the whole family. |
| POST | `/auth/logout` | — | Revokes the session family |
| GET | `/auth/me` | auth | Returns the user and their memberships |

## Tenants

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/tenants` | auth | Creates a school, coaching, white-label… organisation; the caller becomes its owner |
| GET | `/tenants/current` | member | Returns the tenant, your roles and permissions, and `studentProfileId` |
| PATCH | `/tenants/current` | tenant.manage | Branding: logo, primary colour, support contacts, features |
| GET | `/tenants/current/members` | members.manage, reports.class | |
| POST | `/tenants/:id/invitations` | members.manage | `{email, role}`. Inviting a student checks the seat limit. |
| POST | `/tenants/invitations/accept` | auth | `{token}`. Only the invited email can accept. |
| POST | `/tenants/:id/domains` | tenant.manage | Returns DNS TXT verification instructions |

## Curriculum and courses

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/curriculum/boards` | curriculum.read |
| GET | `/curriculum/grades` | curriculum.read |
| GET | `/curriculum/subjects` | curriculum.read |
| GET | `/curriculum/versions` | curriculum.read |
| GET | `/curriculum/chapters?curriculumVersionId&subjectId` | curriculum.read |
| GET | `/curriculum/topics?chapterId` | curriculum.read |
| GET | `/courses/lessons/:id` | curriculum.read (records lesson progress) |
| POST | `/courses/lessons/:id/complete` | assessments.take |
| GET | `/courses/continue` | self, parent or staff |

## Content

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/content/assets` | content.manage | Text upload. Indexed asynchronously, and retrievable only after approval. |
| GET | `/content/assets` | content.manage, content.review | |
| POST | `/content/assets/:id/review` | content.review, tenant.manage | `{decision: approved\|rejected}` |
| POST | `/content/lessons` | content.manage | Creates a lesson in review |
| POST | `/content/lessons/:id/publish` | content.review, tenant.manage | |

## AI tutor

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/ai/sessions` | tutor.use | `{topicId?, lessonId?, mode?}` |
| GET | `/ai/sessions` | tutor.use | |
| GET | `/ai/sessions/:id` | tutor.use | |
| POST | `/ai/sessions/:id/messages` | tutor.use | `{content}` → `{message: {content, source_refs[], safety_flags[]}}`. Rate limited to 20/min, and checked against the monthly quota. |
| POST | `/ai/messages/:id/feedback` | tutor.use | `{rating: 1\|-1}` |

## Avatar

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/avatar/lessons/:lessonId/render` | content.manage | `{idempotencyKey, avatarId?, language?}` → 202 |
| GET | `/avatar/lessons/:lessonId` | curriculum.read | `{mode: avatar\|text, videoUrl?, captions[], reason?}` |
| POST | `/avatar/sessions` | tutor.use | Live session: short-lived credentials, metered by the minute |

## Assessments

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/assessments?chapterId` | assessments.take, assessments.manage, reports.children | |
| GET | `/assessments/:id` | assessments.take, assessments.manage | Answer keys are visible to staff only |
| POST | `/assessments` | assessments.manage | Draft with questions; status `in_review` |
| POST | `/assessments/:id/publish` | assessments.manage | |
| POST | `/assessments/:id/attempts` | assessments.take (self) | Starts or resumes the single open attempt |
| POST | `/attempts/:id/submit` | assessments.take | `{answers:[{questionId, answer}]}`. Auto-scores answers and records mastery evidence. A second submit returns 409. |
| GET | `/attempts/:id` | self, linked parent or staff | |
| POST | `/attempts/:id/answers/:answerId/review` | assessments.review | `{marks}` for a descriptive answer |

## Academic planner

Every route here accepts an optional `studentId` for a parent or staff caller. Students always act on their own record.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/academic/dashboard?date` | Today's tasks, overdue tasks, next exam with readiness, top recommendations |
| GET | `/academic/syllabus-progress` | Per-chapter coverage and mastery |
| PATCH | `/academic/preferences` | `{dailyStudyMinutes, weekdayMinutes, language}` |
| POST/GET | `/academic/exams` | `{subjectId,title,examDate,maxMarks,chapterIds?,allStudents?}` |
| POST | `/academic/marks` | Subject marks, recorded as *estimated* topic mastery |
| POST | `/academic/coverage` | Topics taught, missed or self-studied |
| POST | `/academic/mastery-estimates` | Teacher or self estimates |
| POST | `/academic/disruptions` | `{startDate,endDate,reasonCategory,availableMinutesPerDay,missedTopicIds?,asOfDate?}`. Recalculates active plans into new versions. |
| POST | `/academic/study-plans/generate` | `{examScheduleIds?, startDate?, weights?}` → plan, summary, unscheduled, alternatives |
| POST | `/academic/study-plans/:id/recalculate` | `{trigger, reason?, startDate?, weights?}`. Supersedes the old version. |
| GET | `/academic/study-plans` | |
| GET | `/academic/study-plans/:id` | Plan with its tasks, versions and adjustment reasons |
| PATCH | `/academic/tasks/:id` | Student only: `{status}` |
| GET | `/academic/recommendations` | Built from evidence only |

## Live classes

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/classes` | classes.manage, classes.attend | Teacher: their classes (admins: all). Student: enrolled classes with upcoming or live sessions. |
| POST | `/classes` | classes.manage | `{name, subjectId?, curriculumVersionId?, teacherId?}` |
| GET | `/classes/:id` | teacher or enrolled student | |
| POST | `/classes/:id/enrollments` | class teacher or admin | `{studentIds: [studentProfileId]}` |
| POST | `/classes/:id/sessions` | class teacher or admin | `{lessonId, title?, scheduledAt?, language?, avatarId?}` |
| GET | `/live/sessions/:id` | teacher or enrolled student | State, script, current part, doubts and `lastEventId`. Records attendance. |
| POST | `/live/sessions/:id/start` | class teacher | Builds the script from the approved lesson |
| POST | `/live/sessions/:id/advance` | participant | `{expectedSegment, manual?}`. Compare-and-set with server pacing; `manual` works for the teacher only. |
| POST | `/live/sessions/:id/pause` | class teacher | |
| POST | `/live/sessions/:id/resume` | class teacher | |
| POST | `/live/sessions/:id/say` | class teacher | `{text}`: the avatar says it to the class |
| POST | `/live/sessions/:id/questions` | enrolled student | `{content, inputMode: text\|voice}` → `answered`, `escalated` or `private`. Rate limited to 6/min. |
| POST | `/live/sessions/:id/questions/:qid/resolve` | class teacher | `{answer}` for an escalated doubt |
| POST | `/live/sessions/:id/end` | class teacher | Records attendance and `live_class_minutes` |
| GET | `/live/sessions/:id/attendance` | class teacher | |
| GET | `/live/sessions/:id/stream?after=` | participant | Server-sent events (`event: live`). Honours `Last-Event-ID`. |
| GET | `/live/sessions/:id/events?after=` | participant | Polling fallback |

**Event types:**

| Event | Sent to |
| --- | --- |
| `session.started` | everyone |
| `segment` | everyone |
| `doubt.answered` | everyone |
| `doubt.escalated` | everyone |
| `doubt.resolved` | everyone |
| `teacher.message` | everyone |
| `session.paused` | everyone |
| `session.resumed` | everyone |
| `lesson.completed` | everyone |
| `session.ended` | everyone |
| `doubt.private` | the asking student only |
| `safety.alert` | staff only |

## Parents

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/parents/children` | reports.children | |
| POST | `/parents/children` | reports.children | Creates the child's student account with a guardian consent link |
| POST | `/parents/children/:studentId/consent` | reports.children | `{status: granted\|revoked}` |
| GET | `/parents/children/:studentId/report?date` | reports.children | Weekly report. Requires a consented link. |

## Billing and usage

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/billing/plans` | — | |
| GET | `/billing/subscription` | member | Resolved entitlements and subscriptions |
| POST | `/billing/checkout` | tenant.billing | `{planCode, seats?, idempotencyKey}` |
| POST | `/billing/subscription/:id/cancel` | tenant.billing | Cancels at the end of the period |
| POST | `/billing/webhooks/:provider` | HMAC `X-Signature` | Raw body; deduplicated by event id |
| GET | `/usage/summary` | member | Quotas vs usage. The tenant breakdown requires usage.read. |

## Platform admin (super-admin only; every call is audited)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/tenants` | |
| PATCH | `/admin/tenants/:id` | `{status, reason}` |
| GET | `/admin/audit-logs?tenantId` | |
| GET | `/admin/usage-costs` | |
