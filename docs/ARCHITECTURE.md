# Architecture

## Shape: a modular monolith with separate workers

```
React web ──┐
Flutter*  ──┼─► Express API (/api/v1) ──► PostgreSQL (RLS, FTS, optional pgvector)
White-label ┘     │  auth · tenant context · RBAC · entitlements
                  │  modules: tenants, curriculum, content, ai-tutor, avatar,
                  │           assessments, academic-planner, parents, billing, usage, admin
                  └─► outbox_events ──► worker (document indexing, avatar rendering)
                                         │
                  integrations/ (replaceable adapters)
                  ai-provider · avatar-provider · payment-provider · object-storage
```
\* planned

Curriculum, student records, assessments, the planner and billing all live in one backend with explicit module boundaries under `apps/api/src/modules/*`. Each module owns its routes, validation and business logic. Long-running work (document indexing, avatar renders) runs outside the request path, through a **transactional outbox**: the job row is written in the same transaction as the domain change. Workers claim jobs with `FOR UPDATE SKIP LOCKED` and retry with exponential backoff. A handler that throws `RetryLater` keeps the progress it has saved, such as a provider job id.

## Multi-tenancy

- Every organisation is a row in `tenants`. Self-signup users get a `personal` workspace; a parent gets a family workspace.
- Every tenant-owned table carries `tenant_id` and has a PostgreSQL **RLS** policy `tenant_id = current_tenant_id()`.
- Tenant handlers run inside `withTenant()`, which opens a transaction, sets `app.tenant_id`, and runs `SET LOCAL ROLE gurukul_app`. That role has no BYPASSRLS, so isolation holds even when the database connection is a superuser.
- Trusted system code (auth, tenant resolution, payment webhooks, workers) uses `withSystem()` and must carry and re-check tenant context explicitly. For example, the indexing job verifies that the asset still belongs to the tenant recorded on the event.
- Tenant resolution (`middleware/tenant-context.ts`): the client may *select* a tenant with `X-Tenant-Id` or `X-Tenant-Slug`, or the tenant is derived from a verified custom domain. **An active membership is always checked on the server.** Sending another tenant's id returns 403.
- Shared content tables (`lessons`, `content_assets`, `document_chunks`, `assessments`) let every tenant read platform rows (`tenant_id IS NULL`), but tenants can write only their own rows.

## Authorization

Roles map to permission sets in `lib/permissions.ts`; the roles are tenant owner, admin, teacher, content reviewer, parent and student. Routes declare their requirements with `requirePermission()`.

Access to a student's records goes through one rule, `lib/student-access.ts`:

| Caller | Access |
| --- | --- |
| Student | Their own profile |
| Parent | Only children linked to them with `consent_status = 'granted'` |
| Teacher / admin | Students in their tenant |

Some actions narrow this further. Only the student can take a test or tick off a task, and parents cannot generate plans.

Platform super-admin endpoints are narrow, and every access writes an audit log entry.

## Academic planning engine (`modules/academic-planner/engine.ts`)

The engine is pure and deterministic. It involves no LLM and makes no claims it has no evidence for.

**Priority:** `P = w1·W + w2·G + w3·R + w4·D`. The weights are configurable and normalised so they sum to 1.

| Factor | Meaning |
| --- | --- |
| W | Verified exam weightage, rescaled to 0..1. When it is unknown, the engine uses a neutral 0.5 and flags the priority as *estimated*. |
| G | Learning gap, `1 − mastery`. Measured mastery comes from assessments; estimated mastery comes from teacher or self estimates and subject marks, and is used only when no measured evidence exists. |
| R | Prerequisite importance: transitive dependents ÷ the maximum. |
| D | Urgency relative to the plan horizon. |

**Scheduling:**

1. Reserve a mock test the day before each exam.
2. Order topics topologically, so prerequisites come first. Among topics that are ready, earlier exams go first, then higher *effective* priority. A prerequisite inherits the priority of anything that depends on it, so a high-priority topic pulls its foundations forward instead of skipping them.
3. Fill each day's real capacity, computed from the default minutes, weekday overrides and disruption overrides, and capped by a daily maximum. Learning is split into sessions; practice follows learning; spaced revision comes about two days later.
4. Never half-schedule a topic. If a topic doesn't fit before its exam, roll it back and report it with a reason. Dependents of an unscheduled prerequisite are reported too, rather than scheduled.
5. Report the required, available and scheduled minutes and the gap. When the plan doesn't fit, offer alternatives: the smallest daily time that covers everything (found by binary search over real re-plans), and a lighter plan.

**Versions and disruptions:**

- A recalculation never edits a plan in place. The old version becomes `superseded`, its past pending tasks are marked `missed`, and a new version is written along with a `plan_adjustments` row recording the trigger and reason.
- Learning completed in earlier versions is credited.
- A school holiday is **not** treated as lost time. Only a reported disruption reduces the student's availability.

## AI tutor

The tutor uses retrieval-augmented generation:

1. Full-text retrieval covers only material that is both `approved` and `indexed`, and RLS-scoped to the tenant plus platform content. The schema has room for hybrid search with pgvector.
2. The system prompt wraps passages as `<source id="S1">` and tells the model to treat them as reference material, not instructions; this is the main defence against prompt injection.
3. After generation, citations are validated: any `[S#]` that doesn't match a supplied source is removed.
4. When nothing relevant is retrieved, the answer is flagged `ungrounded` and the tutor acknowledges uncertainty.

**Safety screening** runs before any model call. Self-harm, abuse disclosures and requests for personal information get a fixed, caring response with Indian helplines (Tele-MANAS 14416, CHILDLINE 1098, 112). Risk cases are audit-logged for human follow-up.

**Metering:** every question records `ai_question` and `ai_tokens` usage events, and quotas are checked on the server inside the same transaction.

## Avatar

`AvatarProvider` is an internal contract with three operations: `createSession`, `renderLesson` and `getJobStatus`.

- **Pre-rendered lessons** are queued through the outbox and polled by the worker.
- **Playback** always succeeds while the lesson exists. If the render is missing, has failed, or the quota is used up, the response uses `mode: "text"` and includes captions.
- **Live sessions** mint short-lived client credentials on the server.
- Live minutes, lesson views and renders are metered separately.

## Live AI classrooms (`modules/live`)

```
Teacher browser ─┐                                   ┌─► SSE stream ─► every student's browser
Student browsers ─┼─► REST (start, advance, doubts) ─► live_session_events ─ pg_notify ─┤
                  │                                   └─► polling fallback
                  └─ AvatarFace (SVG visemes) + Web Speech API (TTS out, STT in)
```

**Classes and sessions.** `classes` and `class_enrollments` model batches. A `live_session` teaches one published lesson. When the session starts, the server builds the script from the lesson's approved text (`buildTeachingScript`): an intro, short two-to-three-sentence parts, and a closing "doubt time". The avatar never improvises lesson content.

**Real-time.** Every change is appended to `live_session_events` and announced with `pg_notify`. Because the notification is transactional, it fans out across all API instances.

- Each SSE connection replays from `Last-Event-ID` and then pushes new events. Clients reconnect automatically and fall back to polling `/events`.
- Each event has an audience: `all`, `staff`, or a single `user` (private replies). The audience is filtered per viewer.

**Server-authoritative pacing.**

- Clients nudge `advance` when their avatar finishes a part. The call is a compare-and-set on the expected index, so thirty students nudging at once advance the lesson exactly once.
- No one can advance before half of the part's estimated speaking time has passed, unless the teacher presses **Next part**.
- An answer or teacher message holds pacing for its own speaking time, and clients then replay the current part.

**Doubts.**

1. The student asks by voice or text.
2. Safety screening runs. Sensitive messages get a private reply, a `safety.alert` to staff only, and an audit entry.
3. The quota is checked.
4. The same grounded pipeline as 1:1 tutoring answers it (`generateGroundedAnswer`), retrieving from the lesson's topic and validating citations, in short spoken form.
5. If nothing relevant is retrieved, the doubt is **escalated** instead of guessed. The teacher answers it, and the avatar reads the answer out.
6. Classmates see only first names.

**The avatar.**

- **Default renderer:** browser-based, with no per-minute cost. It uses an SVG face, a viseme track from word-boundary events, blinking, and state glows for speaking, listening and thinking.
- **Robustness:** speech is spoken sentence by sentence. If the engine never starts, errors, or "finishes" impossibly fast, the client falls back to timed silent playback with captions, so pacing never stalls.
- **Voice input:** the Web Speech API's speech recognition.
- **Photorealistic upgrade path:** a streaming-avatar vendor adapter would implement `AvatarProvider.createSession` (short-lived client token, already metered per minute) and replace `AvatarFace` and `AvatarVoice` on the client. The event and pacing protocol stays the same.

**Metering:** doubts count toward AI quotas; `live_class_minutes` and attendance are recorded when the class ends.

## Billing

- Plan entitlements are stored as structured JSON and resolved on the server (`modules/billing/entitlements.ts`). A personal subscription takes precedence over an institution one. Once a subscription expires, the free plan applies.
- Money is stored in integer **paise**.
- Checkout is idempotent per key.
- Webhooks are verified with HMAC over the raw body and stored once per `(provider, event_id)`. Captures are applied only to `created` payments, so duplicates and replays cannot activate or extend a subscription twice. Amount mismatches are audit-logged.
- Institution licences are seat-based; seats are enforced when students are invited or children are added.

## Security checklist (implemented → planned)

| Area | Status |
| --- | --- |
| Password hashing | Implemented: scrypt. |
| Session tokens | Implemented: short-lived JWT access tokens, plus rotating refresh tokens stored hashed with reuse detection. |
| Tenant isolation | Implemented: backend authorization on every route, tenant isolation with RLS, and automated cross-tenant tests. |
| Request handling | Implemented: rate limits, zod request validation, Helmet and an explicit CORS allowlist. |
| Auditing | Implemented: audit logs for privileged and sensitive actions. |
| Files | Implemented: signed, expiring, tenant-prefixed object URLs. **Planned:** file scanning. |
| Authentication hardening | **Planned:** MFA for admins and an httpOnly refresh cookie for the web app. |
| Platform | **Planned:** a Redis limiter, a secrets manager, backup-restore drills and data-retention/deletion jobs. |
| Compliance and verification | **Planned:** a DPDP Act and child-consent legal review, plus OWASP ASVS verification before collecting children's data at scale. |

## Scaling path

| Stage | Approach |
| --- | --- |
| MVP | One API, one worker, managed PostgreSQL. |
| Initial growth | Several API instances with a Redis limiter and cache, dedicated AI and media workers, a CDN and connection pooling. |
| Larger institutions | Read replicas where justified, and per-tenant controls. |

Avatar minutes and AI tokens, not page views, dominate cost. Meter everything (`usage_events.cost_micros`) and set quotas before offering plans that look unlimited.
