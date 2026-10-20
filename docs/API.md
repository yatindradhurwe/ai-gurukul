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

## School records

Teachers manage records for the classes they teach; owners and admins for every class. Students see their own classes; parents see a consented child's records (pass `studentId`).

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/dashboard` | member | Role-aware home screen: `organization`, `teaching`, `student`, `children` sections appear only when the role can see them |
| GET | `/announcements` | member | Whole-school and class notices for the caller's audience, with `read` and `unread` count |
| POST | `/announcements` | announcements.manage | `{title, body, audience: all\|staff\|students\|parents, classId?, pinned?}`. Teachers must give a class they teach. |
| POST | `/announcements/:id/read` | member | |
| DELETE | `/announcements/:id` | announcements.manage | Author or admin |
| GET | `/assignments?classId&studentId` | classes.manage / classes.attend / reports.children | Staff get submission counts; students and parents get each assignment's `state` |
| POST | `/assignments` | classes.manage | `{classId, title, description?, dueAt?, maxPoints}` |
| GET | `/assignments/:id?studentId` | as above | Staff get every enrolled student's submission |
| PATCH / DELETE | `/assignments/:id` | classes.manage | `status: published\|closed` stops new submissions |
| POST | `/assignments/:id/submit` | classes.attend | `{content, linkUrl?}`; can be resubmitted until graded |
| POST | `/assignments/:id/submissions/:submissionId/grade` | classes.manage | `{points, feedback?}` |
| GET / POST | `/attendance/classes/:classId?date` | classes.manage | Roster for a day / `{date?, records: [{studentId, status: present\|absent\|late\|excused, note?}]}` (no future dates) |
| GET | `/attendance/classes/:classId/report?from&to` | classes.manage | Rate per student. Late counts as attended; excused days are left out. |
| GET | `/attendance/students?studentId` | self / parent / staff | Summary and recent days |
| GET | `/timetable?classId` | member | Weekly periods of the caller's classes |
| POST / DELETE | `/timetable`, `/timetable/:id` | classes.manage | `{classId, dayOfWeek: 1–7, startTime, endTime, subject, room?, teacherId?}`. Overlaps for the class or teacher are refused (409). |
| GET | `/gradebook/classes/:classId?term` | classes.manage | Columns × students with percentage and grade |
| POST | `/gradebook/classes/:classId/items` | classes.manage | `{title, term, category, maxMarks, date?}` |
| PUT | `/gradebook/items/:id/scores` | classes.manage | `{scores: [{studentId, marks \| null, remarks?}]}` |
| DELETE | `/gradebook/items/:id` | classes.manage | |
| GET | `/gradebook/report-card?studentId&term` | self / parent / staff | Per-class marks with CBSE grade bands (A1–E), overall, attendance and homework |

## Fees, exams and library

Amounts are sent in rupees and returned in paise (`*_paise`). Fee staff are owners, admins, staff/HR and accountants (`fees.manage`); library staff are owners, admins, staff/HR and librarians (`library.manage`); exams are managed by owners and admins (`exams.manage`).

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/fees/summary` | fees.manage | Billed, collected, outstanding, overdue; by method; recent payments |
| GET / POST | `/fees/structures` | fees.manage | `{name, category, amount, dueDate, classId?}` bills every matching student |
| POST | `/fees/structures/:id/apply` | fees.manage | Bills students who joined later |
| DELETE | `/fees/structures/:id` | fees.manage | Refused once payments exist |
| GET | `/fees/classes`, `/fees/students` | fees.manage | Pickers for billing |
| GET | `/fees/invoices?state&studentId&structureId&search` | fees.manage | `state`: due, partial, overdue, paid, cancelled, unpaid |
| POST | `/fees/invoices` | fees.manage | One-off invoice `{studentId, title, amount, dueDate}` |
| PATCH | `/fees/invoices/:id` | fees.manage | `{discount, discountNote}` concession, or `{status: cancelled}` if unpaid |
| POST | `/fees/invoices/:id/payments` | fees.manage | `{amount, method, reference?}`; never more than the balance; issues `RCPT-YYYY-NNNNN` |
| GET | `/fees/student?studentId` | self / parent / fees.manage | Invoices, payments and totals |
| GET | `/fees/receipts/:paymentId` | self / parent / fees.manage | Printable receipt |
| GET / POST | `/exams` | member / exams.manage | Others see published exams with papers for their classes |
| GET / PATCH / DELETE | `/exams/:id` | member / exams.manage | Date sheet; `status: draft\|published\|completed` (completed = results declared) |
| POST | `/exams/:id/papers` | exams.manage | `{classId, subject, date, startTime, durationMinutes, maxMarks, passMarks?, room?}`; creates the gradebook column; overlaps refused |
| DELETE | `/exams/papers/:paperId` | exams.manage | Also removes the gradebook column |
| GET | `/exams/:id/results?classId` | exams.manage / class teacher | Marks, total, %, grade, pass/fail and rank |
| GET | `/exams/:id/student?studentId` | self / parent / staff | Students and parents only after results are declared |
| GET | `/library/books?search&category` | member | Catalogue with availability |
| POST / PATCH / DELETE | `/library/books[/:id]` | library.manage | |
| GET | `/library/summary`, `/library/members`, `/library/loans?state&userId` | library.manage | |
| POST | `/library/loans` | library.manage | `{bookId, userId, dueDate?}`; 14 days by default, at most 5 books per member |
| POST | `/library/loans/:id/return` | library.manage | `{waiveFine?, finePaid?}`; fine ₹2 per day late |
| POST | `/library/loans/:id/renew`, `/library/loans/:id/fine-paid` | library.manage | |
| GET | `/library/my?studentId` | member / parent | Own loans, or a child's |

## Transport, hostels and rewards

Transport is managed by owners, admins, staff/HR and transport managers (`transport.manage`); hostels by owners, admins, staff/HR and wardens (`hostel.manage`).

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET / POST / PATCH | `/transport/vehicles[/:id]` | transport.manage | `{registrationNo, label, capacity, driverName, driverPhone, attendantName?, attendantPhone?, status}` |
| GET / POST / PATCH / DELETE | `/transport/routes[/:id]` | transport.manage | Routes with vehicle, riders and ordered stops; a route with riders can't be deleted |
| POST | `/transport/routes/:id/stops` | transport.manage | `{name, landmark?, pickupTime, dropTime, sequence?}`; inserting mid-route shifts later stops |
| DELETE | `/transport/stops/:id` | transport.manage | Refused while students board there |
| GET | `/transport/riders?routeId` | transport.manage | Every student with their route and stop |
| PUT / DELETE | `/transport/riders/:studentId` | transport.manage | `{stopId, direction: both\|pickup\|drop}`; refused when the bus is full |
| GET | `/transport/my?studentId` | self / parent / staff | Route, vehicle, driver contacts, all stops and the student's stop |
| GET / POST / PATCH / DELETE | `/hostels[/:id]` | hostel.manage | Hostels with occupancy and rooms with residents |
| POST | `/hostels/:id/rooms` | hostel.manage | `{roomNo, floor, capacity, roomType}` |
| PATCH / DELETE | `/hostels/rooms/:roomId` | hostel.manage | Capacity can't drop below current residents |
| GET | `/hostels/students`, `/hostels/wardens` | hostel.manage | Pickers |
| POST | `/hostels/rooms/:roomId/allocations` | hostel.manage | `{studentId, startDate?}`; moving closes the old allocation; refused when the room is full |
| POST | `/hostels/allocations/:id/vacate` | hostel.manage | Keeps the history |
| GET | `/hostels/my?studentId` | self / parent / staff | Room, roommates and warden |
| GET | `/engagement/me?studentId` | self / parent / staff | XP, level, streak, daily goals, badges, weekly XP, recent activity and the class leaderboard (first names only) |

XP comes from what students already do: lesson 20, quiz 15 + up to 15 for the score, assignment 25, study task 10, attendance 10, live class 15, library return 15, AI-teacher question or class doubt 5 (at most 10 a day). Level *n* needs 50·(n−1)² XP.

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
