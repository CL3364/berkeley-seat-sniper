# Spec: <feature / app name>

> The architect fills this in and keeps it current. It is the source of truth.
> When reality diverges, update this file first, then let code follow.
> Version this file; note the date and what changed at the top of each revision.

## 1. Problem & users

- What problem, for whom, and why now.

## 2. Scope

- In scope:
- Explicit non-goals (just as important):

## 3. Functional requirements

Numbered and testable. Example:

- FR-1: A signed-in user can create a project with a name (1–80 chars).
- FR-2: ...

## 4. API contract

- Location: `src/shared/**` (types + Zod schemas). This section summarizes; the code is authoritative.
- Endpoints (method, path, request, response, errors): ...

## 5. Data model

- Tables, columns, relations, indexes (Drizzle/Postgres). Must reconcile with §4.

## 6. Non-functional requirements

- Performance budget (e.g. p95 API < 200ms; initial JS < 200KB gzip):
- Security/authz model (who can do what; how it's enforced):
- Accessibility bar (e.g. WCAG 2.1 AA on core flows):
- Observability (logs/metrics/traces needed):

## 7. Acceptance criteria (the verifier runs these against the finished app)

Each must be objectively pass/fail. Example:

- AC-1: Creating a project returns 201 and the project appears in the list view.
- AC-2: Submitting an empty name shows an inline validation error and no request is sent.
- AC-3: An unauthenticated request to a protected route returns 401.
- AC-4: ...

## 8. Task breakdown (with dependencies & owners)

| #   | Task                                   | Owner role        | Depends on           |
| --- | -------------------------------------- | ----------------- | -------------------- |
| 1   | Define API contract in `src/shared/**` | architect         | —                    |
| 2   | Schema + migrations                    | database-engineer | 1                    |
| 3   | Endpoints                              | backend-engineer  | 1, 2                 |
| 4   | UI + API client                        | frontend-engineer | 1                    |
| 5   | Unit + integration tests               | test-engineer     | 2, 3, 4              |
| 6   | E2E journeys                           | e2e-qa-engineer   | 5                    |
| 7   | Containerize + CI                      | devops-engineer   | 1 (refine after 3,4) |
| 8   | Security review                        | security-reviewer | 3, 4                 |
| 9   | Code review                            | code-reviewer     | 3, 4                 |

## 9. File-ownership map (no path owned twice)

- `specs/**`, `src/shared/**` → architect (contract read-only to all others)
- `src/db/**`, `drizzle/**` → database-engineer
- `src/server/**`, `src/api/**` → backend-engineer
- `src/client/**`, `src/components/**` → frontend-engineer
- `tests/**` → test-engineer
- `e2e/**` → e2e-qa-engineer
- `Dockerfile`, `docker-compose*`, `Caddyfile`, `.github/**` → devops-engineer
- Monitor apps add (disjoint from all of the above):
  - `src/scraper/**` → scraper-engineer (external fetch + HTML parse + fixtures)
  - `src/worker/**` → worker-engineer (poller, change detection, fan-out)
  - `src/notify/**` → notifier-engineer (email / web-push dispatch)
- No path may be owned twice.
