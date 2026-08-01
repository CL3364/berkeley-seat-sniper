# Scraper Fixtures

These saved fixtures exercise Berkeley Seat Sniper without network access. The
class-page fixtures are **sanitized, reduced reproductions of the public DOM
shape verified on 2026-07-23** at `classes.berkeley.edu`; they are not complete
copies of Berkeley pages and contain no user data. Counts and nonessential
content are synthetic.

CI must use these files and injected `fetch` responses. A separately approved
release canary validates the current live shape; it is never part of normal CI.

## Class-page files

| File                               | Expected behavior                                               |
| ---------------------------------- | --------------------------------------------------------------- |
| `zero-seats.html`                  | `0` open, full waitlist → `closed`                              |
| `open-seats.html`                  | `3` open → `open`                                               |
| `waitlist-open.html`               | `0` open, `39 < 40` waitlisted → `waitlist`                     |
| `negative-seats.html`              | `-57` normalizes to `0` with telemetry                          |
| `changed-shape.html`               | correct identity but missing enrollment region → `parser-broke` |
| `duplicate-enrollment-fields.html` | duplicate required label → `parser-broke`                       |
| `contradictory-waitlist.html`      | waitlisted count exceeds maximum → `parser-broke`               |
| `identity-mismatch.html`           | canonical link identifies another section → `parser-broke`      |
| `class-not-found.html`             | recognizable HTTP-200 soft 404 → `class-gone`                   |

## Bound public-page shape

`parseClassPage` requires exactly one:

- `link[rel~=canonical]` whose HTTPS origin and `/content/<ClassKey>` path match
  the requested class;
- `section.current-enrollment` with a `Current Enrollment` heading;
- `Total Open Seats`, `Waitlisted`, and `Waitlist Max` `<strong>` label inside
  that region.

The values paired with those labels must be whole plain integers. Open seats may
be signed; nonpositive values normalize to zero and negative values emit only a
safe numeric telemetry event. Waitlisted and Waitlist Max must be nonnegative,
and Waitlisted cannot exceed Waitlist Max. The waitlist is open exactly when its
maximum is positive and its current count is below that maximum.

Missing, duplicated, malformed, or contradictory values are always
`parser-broke`. The parser never falls back to zero.

## Soft 404s

`fetchClassObservation` returns `class-gone` for HTTP 404 or a recognizable
soft-not-found document. `isNotFoundPage` accepts a structural not-found marker
or a matching title/top heading only when `section.current-enrollment` is
absent. A live enrollment region therefore wins over stray “not found” prose.

## robots.txt files

| File                          | Expected behavior                         |
| ----------------------------- | ----------------------------------------- |
| `robots-allow-all.txt`        | permits the class path                    |
| `robots-disallow-content.txt` | denies `/content/`                        |
| `robots-comment-midgroup.txt` | comments do not end a group               |
| `robots-multi-agent.txt`      | consecutive user-agent fields share rules |

The implementation also tests status behavior through injected responses:

- an explicit matching `Disallow` is a persistent `robots-disallow` safety stop;
- 401/403 fail closed as persistent `source-forbidden` safety stops;
- 404 and remaining RFC-unavailable 4xx responses mean no rules apply;
- 429 fails closed as a persistent `source-rate-limited` safety stop and
  preserves a bounded `Retry-After` value when supplied;
- 5xx, network failure, invalid redirect, or unreadable body fail closed only
  for the current cycle as transient failures;
- `Allow`/`Disallow` use longest-match precedence, with Allow winning ties;
- `*` and terminal `$` are matched by a bounded deterministic glob matcher,
  never a regular expression built from source content.

Both robots and class requests follow at most three redirects, only to the exact
HTTPS `classes.berkeley.edu` origin. Response bodies and total request time are
bounded across all redirect hops.

## Cache-aware fetch contract

Injected class responses may provide `Cache-Control`, `Age`, `ETag`, and
`Last-Modified`. The scraper returns parsed freshness metadata and reuses
conditional validators. A 304 produces `kind: 'not-modified'`, refreshes cache
scheduling metadata, and deliberately does not produce a SeatState.
