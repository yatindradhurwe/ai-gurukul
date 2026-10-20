# AI Gurukul

AI Gurukul is a multi-tenant education SaaS for India. One platform serves individual students and families, schools, coaching institutes and white-label partners. Each organisation is isolated from the others.

It combines four things:

- **An AI teacher grounded in approved material.** Answers are built from retrieved course passages, cite their sources, and say plainly when the material doesn't cover a question.
- **A rules-driven academic planner.** It works from the syllabus, marks, mastery evidence, exam dates and the time a student actually has. It shows when there isn't enough time, and it creates a new version of the plan after a disruption.
- **Live AI classrooms.** A talking avatar teacher teaches a class in real time, and students ask doubts by voice or text. The avatar answers each doubt aloud for the whole class from approved material, and doubts outside the material go to the human teacher. See [Live classrooms](#live-ai-classrooms).
- **Talking avatar lessons behind a provider-neutral interface.** A text lesson with captions is always available as a fallback.
- **School records.** Announcements, assignments with submissions and grading, daily attendance, a weekly timetable, a gradebook and printable report cards, plus a role-aware dashboard for owners, teachers, students and parents.
- **Subscriptions and usage metering, enforced on the server.**

This repository holds the **MVP vertical slice**: one family, one student, one CBSE Class 8 Science curriculum, one exam. Everything runs end to end, and an automated test drives the whole flow.

> Status: early MVP. The demo curriculum content is original summary text and still needs review by a subject expert. Exam weightage is deliberately left empty because it has not been verified. Real AI, avatar and payment vendors plug into the adapter interfaces described below.

## Repository layout

```
apps/
  api/   Node.js + Express + TypeScript backend (modular monolith) + background worker
  web/   React + Vite + TypeScript + Tailwind web app (student, parent, staff)
docs/
  ARCHITECTURE.md   design decisions, tenancy, planner logic, security
  API.md            REST endpoint reference (/api/v1)
```

## Quick start

Prerequisites: Node 22 and PostgreSQL 16. You can start PostgreSQL with `docker compose up -d db`; the image ships with pgvector.

```bash
cp .env.example .env                 # then edit secrets
npm install
export $(grep -v '^#' .env | xargs)  # or use your preferred env loader
npm run db:seed                      # runs migrations + seeds roles, plans, demo curriculum
npm run dev:api                      # http://localhost:4000
npm run worker                       # background jobs (indexing, avatar renders)
npm run dev:web                      # http://localhost:5173
```

Open the web app and create a **Student** account. Then:

1. On the **Results** page, take the diagnostic quiz.
2. On **Study Plan**, add an exam and generate a plan. Then report some busy days and watch version 2 appear.
3. Ask the **AI Teacher** a question, such as "Why do knives have sharp edges?"

To try the parent flow, create a **Parent** account and add a child from the **Children** page.

Optional: set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before seeding to create a platform super-admin.

### Demo logins

The app has no built-in default accounts. To create a ready-to-use demo school, run this on the server after `npm run build`:

```bash
npm run setup:demo                              # random passwords, printed once
DEMO_PASSWORD='YourStrongPass#1' npm run setup:demo   # or choose one password for all demo users
npm run setup:demo -- --reset-passwords         # issue new passwords for existing demo users
```

It creates the organization "Demo School" with these logins:

| Email | Role | What they see |
| --- | --- | --- |
| `superadmin@demo.aigurukul.test` | Platform super-admin | **Platform admin** console: all organisations (suspend or reactivate), audit log, usage. Also owner of Demo School. |
| `principal@demo.aigurukul.test` | School owner | Everything in the school, including billing |
| `admin@demo.aigurukul.test` | School admin | People, classes, content, reports |
| `teacher@demo.aigurukul.test` | Teacher | Live Classes (8-A Science, with a live AI lesson ready), content, tests |
| `staff@demo.aigurukul.test` | Staff / HR | **People** directory and invitations, organisation reports. No access to students' academic records. |
| `student1@…` and `student2@…` | Students | Home, AI Teacher, Live Classes, Study Plan, Results |
| `parent@demo.aigurukul.test` | Parent of student1 | Children, weekly report, billing |

Environment variables:

| Variable | Effect |
| --- | --- |
| `DEMO_PASSWORD` | One password for every demo account |
| `SUPERADMIN_PASSWORD` | A separate password for the super-admin (recommended) |
| `SUPERADMIN_EMAIL` | Use your own email for the super-admin |
| `DEMO_EMAIL_DOMAIN` | Change the email domain for all demo accounts |

Demo School also gets sample records the first time: a weekly timetable, announcements, two assignments (one graded), five days of attendance and two marked assessments, so every screen has data.

The script is safe to run again: existing accounts keep their passwords unless you pass `--reset-passwords`. Change or remove demo accounts before real users join.

### Live AI classrooms

1. As a school owner or teacher, open **Live Classes**. Create a class, add students, and schedule a live lesson.
2. Open the session and press **Start live class**.
3. Students open **Live Classes → Join live** and press **Join class**. Browsers only allow audio after a click.

What happens in the room:

- The avatar teaches the lesson part by part, with a lip-synced talking face, its voice, captions, and the current part shown "on the board".
- Students tap 🎤 to ask by voice, or type a doubt. The avatar pauses, says "Ravi asked …", answers from the lesson's approved material with citations, then repeats the current part.
- If a doubt isn't covered by the material, the avatar says so and sends it to the teacher. The teacher's typed answer is read out by the avatar.
- The teacher can pause and resume, skip to the next part, speak through the avatar, see attendance, and end the class.
- Sensitive messages (self-harm, abuse) get a private reply with helplines, are never shown to the class, and alert the teacher.

How the voice and face work:

- The default avatar runs entirely in the browser at no per-minute cost. It uses an SVG face with viseme lip-sync and the Web Speech API for speaking and listening.
- Voice input needs a browser with speech recognition, such as Chrome or Edge; others fall back to typing.
- The quality of Indian-language voices depends on the device.
- A licensed photorealistic streaming-avatar vendor can be added behind the `AvatarProvider` interface; see `docs/ARCHITECTURE.md`.

### AI provider

`AI_PROVIDER=mock` (the default) is an offline, deterministic, extractive tutor. It needs no API key, so you can develop and run CI against it. For real tutoring, set `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. Keys stay on the server and never reach a client bundle.

## Tests

```bash
createdb gurukul_test   # integration tests reset this database
npm test                # TEST_DATABASE_URL overrides the default connection string
```

There are 57 tests: unit tests for the planning engine, plus integration tests against a real PostgreSQL database. Together they cover the MVP acceptance criteria:

| Acceptance criterion | Test |
| --- | --- |
| A student cannot access another student's records | `isolation.test.ts` |
| A school cannot access another school's records | `isolation.test.ts` |
| RLS blocks cross-tenant reads/writes even if a query forgets its filter | `isolation.test.ts` |
| Uploaded material is retrievable only after indexing **and** approval | `billing-content.test.ts` |
| AI answers cite material where available and acknowledge uncertainty otherwise | `vertical-slice.test.ts` |
| A disruption creates a new plan version without deleting the old one | `vertical-slice.test.ts` |
| New assessment results update topic-level recommendations | `vertical-slice.test.ts` |
| An expired subscription enforces free limits | `billing-content.test.ts` |
| Duplicate payment webhooks cannot activate or extend a subscription twice | `billing-content.test.ts` |
| Avatar-provider failures don't block text lessons | `vertical-slice.test.ts` |
| A parent sees only children they are linked to, and only while consent is granted | `vertical-slice.test.ts`, `isolation.test.ts` |
| Reusing a refresh token revokes the whole session family | `isolation.test.ts` |
| Live class: only enrolled students join; pacing is server-controlled; doubts are answered for the whole class with citations; off-syllabus doubts go to the teacher; sensitive messages stay private; events stream in real time | `live-class.test.ts` |

## Deployment

### One-app deploy (simplest)

The repository root is a deployable Node app, so hosting platforms that look for a root `package.json` work out of the box:

```bash
npm install          # installs both workspaces; keep devDependencies, the build needs them
npm run build        # builds the API and the web app
npm start            # runs migrations + idempotent seed, then serves API + website on $PORT
```

Any ordinary PostgreSQL user that owns its database works. The app doesn't need superuser, `CREATEROLE` or extension privileges.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | A PostgreSQL 14+ database |
| `JWT_SECRET` | Use a long random value |
| `PORT` | The port the app listens on |

Set `RUN_WORKER_IN_PROCESS=true` if you don't run a separate worker process. The web app is served from the same origin, so no CORS setup is needed.

> **Uploading a ZIP?** Upload the repository root, the folder that contains `package.json`, `apps/` and `docs/`. A ZIP of the `main` branch only has these files once the pull request is merged. Until then, download the ZIP of the `claude/stoic-fermat-h3z5qu` branch.

### Containers

- `apps/api/Dockerfile` builds a single image for both the API and the worker; the worker uses `node apps/api/dist/jobs/worker.js` as its command.
- Run migrations with `node apps/api/dist/database/migrate.js` before rolling out.
- Use managed PostgreSQL with point-in-time recovery, and private object storage for media. Keep dev, staging and production as separate environments. See `docs/ARCHITECTURE.md` for the scaling path.
- If a reverse proxy sits in front of the API, disable response buffering for `/api/v1/live/*/stream` (server-sent events). Clients fall back to polling automatically.

## What's next

- Flutter mobile apps generated from an OpenAPI spec, and vendor adapters for a licensed avatar provider and an Indian payment gateway.
- An AI-drafted quiz generator that feeds the existing teacher review and publish flow.
- PDF ingestion through signed uploads.
- Hybrid semantic retrieval with pgvector, once an embedding model is chosen.
- A Redis-backed rate limiter for running more than one API instance.
- Verified exam blueprints so the planner can use real weightage.
