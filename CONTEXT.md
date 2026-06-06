# Context — Berkeley Seat Sniper

Ubiquitous language for the project. This is a **glossary**, not a spec — definitions
only, no implementation detail. When a term here conflicts with how the code or a
conversation uses a word, the conflict gets resolved here first.

## Glossary

- **Subscriber** — a person who has asked to be alerted, identified solely by an email
  address. There is no password and no account; the email *is* the identity.

- **Pending Subscriber** — a Subscriber who has not yet proven control of their email.
  Receives no Alerts.

- **Confirmed Subscriber** — a Subscriber who has proven control of their email by
  following a Confirmation link. Only Confirmed Subscribers receive Alerts.

- **Confirmation** — the one-time act of proving control of an email address by
  following an out-of-band link sent to it. Turns a Pending Subscriber into a
  Confirmed Subscriber. (See ADR 0001.)

- **Section** — the unit that is watched: one specific Berkeley class section
  (a term + subject + course + section number + component such as lecture or
  discussion). A Section is **not** a Course — watching "CS 189" means watching a
  particular section of it.

- **Term** — a Berkeley enrollment period (e.g. Fall 2026). Every Section belongs to
  exactly one Term, named in the Section itself.

- **Enrollment window** — the span during which a Term's Sections can still change
  availability. While it is open, Openings can occur; once it closes, they cannot.

- **Watch** — a Subscriber's standing interest in exactly one Section. A Subscriber
  may hold many Watches; a Section may be watched by many Subscribers. A Watch is
  **live** while its Section's Term has an open Enrollment window, and **retired** once
  that window closes (a retired Watch is no longer polled and triggers no Alerts).

- **Opening** — the umbrella event that triggers an Alert: a watched Section becoming
  reachable in a way it was not a moment ago. There are two distinct kinds, and an Alert
  always names which one:

  - **Seat Opening** — a Section transitioning from "no seat available" to "at least one
    enrollable seat available." Seats are first-come-first-served and do **not** cascade
    down the waitlist, so a Seat Opening is a race. This is the primary event.

  - **Waitlist Opening** — a Section whose waitlist was full transitioning to having room
    on the waitlist. It does not grant a seat — only the ability to join the line — but
    when the waitlist itself is capped in a hot Section, getting in line fast is its own
    win. Secondary to a Seat Opening, and never described as a seat.

- **Alert** — a single outbound notification to one Confirmed Subscriber that a Section
  they Watch has had an Opening. The Alert states which kind of Opening (Seat or Waitlist)
  so a Subscriber is never misled into thinking a Waitlist Opening is an enrollable seat.

- **Manage link** — the no-password, signed, expiring bearer link a Subscriber uses to
  view, add, or remove Watches, or to unsubscribe. Possession of the link is authority;
  it is delivered out-of-band to the Subscriber's email.

- **Operator alert** — an internal notification (to the system's operators, never to
  Subscribers) that the system can no longer read a watched page. Distinct from an Alert
  and never counted as "zero seats."
