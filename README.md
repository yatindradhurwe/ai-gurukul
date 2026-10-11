# AI Gurukul

AI Gurukul is a multi-tenant education SaaS for India. One platform serves individual students and families, schools, coaching institutes and white-label partners. Each organisation is isolated from the others.

It combines four things:

- **An AI teacher grounded in approved material.** Answers are built from retrieved course passages, cite their sources, and say plainly when the material doesn't cover a question.
- **A rules-driven academic planner.** It works from the syllabus, marks, mastery evidence, exam dates and the time a student actually has. It shows when there isn't enough time, and it creates a new version of the plan after a disruption.
- **Talking avatar lessons behind a provider-neutral interface.** A text lesson with captions is always available as a fallback.
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

### AI provider

`AI_PROVIDER=mock` (the default) is an offline, deterministic, extractive tutor. It needs no API key, so you can develop and run CI against it. For real tutoring, set `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. Keys stay on the server and never reach a client bundle.

## Tests

```bash
createdb gurukul_test   # integration tests reset this database
npm test                # TEST_DATABASE_URL overrides the default connection string
```

There are 45 tests: unit tests for the planning engine, plus integration tests against a real PostgreSQL database. Together they cover the MVP acceptance criteria:

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

## Deployment

- `apps/api/Dockerfile` builds a single image for both the API and the worker; the worker uses `node apps/api/dist/jobs/worker.js` as its command. Run migrations with `node apps/api/dist/database/migrate.js` before rolling out.
- Serve `apps/web` (`npm run build -w apps/web` → `apps/web/dist`) from a CDN and proxy `/api` to the API.
- Use managed PostgreSQL with point-in-time recovery, and private object storage for media. Keep dev, staging and production as separate environments. See `docs/ARCHITECTURE.md` for the scaling path.

## What's next

- Flutter mobile apps generated from an OpenAPI spec, and vendor adapters for a licensed avatar provider and an Indian payment gateway.
- An AI-drafted quiz generator that feeds the existing teacher review and publish flow.
- PDF ingestion through signed uploads.
- Hybrid semantic retrieval with pgvector, once an embedding model is chosen.
- A Redis-backed rate limiter for running more than one API instance.
- Verified exam blueprints so the planner can use real weightage.
