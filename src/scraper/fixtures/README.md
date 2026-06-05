# Scraper Fixtures

These are SYNTHETIC HTML fixtures modeled on the Berkeley public class page structure
(`classes.berkeley.edu/content/<classKey>`). They are used by the test-engineer to
drive `parseClassPage` in unit tests without hitting the live site.

**Important:** These fixtures were authored from documented page structure and visual
inspection. They are NOT downloaded live HTML. Before relying on them for production
confidence, validate the selectors against a real live sample from
`https://classes.berkeley.edu/content/2026-fall-compsci-189-001-lec-001` (or any
current term class). If selectors no longer match, update `parse.ts` and these
fixtures together, and ensure `changed-shape.html` still triggers parser-broke.

## Files

| File | Scenario |
|------|----------|
| `zero-seats.html` | 0 open seats, waitlist closed → status `closed` |
| `open-seats.html` | >0 open seats → status `open` |
| `waitlist-open.html` | 0 open seats, waitlist open → status `waitlist` |
| `changed-shape.html` | Page whose enrollment nodes are absent → must yield `parser-broke` |

## Selectors relied on (see `parse.ts`)

The parser targets:
- `.enroll-numbers .available .count` — integer open seat count
- `.waitlist-status` — present element containing text "open" when waitlist is open

When either required node is absent or the seat count is non-numeric, the parser
returns `{ kind: 'parser-broke' }`. Update this list whenever selectors change.
