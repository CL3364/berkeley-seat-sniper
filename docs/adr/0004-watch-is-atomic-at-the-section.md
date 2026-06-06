# 4. A Watch is atomic at the Section; Course-level watching is deferred

Date: 2026-06-05
Status: Accepted

## Context

A `ClassKey` — and therefore a Watch — identifies one specific Section
(`<term>-<subject>-<course>-<section>-<component>`). But the dominant real student
intent is course-level: "get me into CS 189 — any open discussion will do." Under the
Section model, that student must add every section as a separate Watch and may receive a
separate Alert per section.

The upstream source reinforces the Section grain: there is one public page per Section,
and availability is a per-Section fact.

## Decision

Keep the Watch atomic at the **Section** for v1. Do not introduce a Course-level Watch
now. Record course-level "any section" watching as the **leading next feature**, not a
bug in the model.

## Consequences

- **+** The model matches the source (one page per Section) and the built contract/schema;
  no rework.
- **+** Precise: a Subscriber is told exactly which Section opened.
- **−** Course-level intent is served only by the Subscriber adding sections manually,
  with possible multi-Alert and no "stop after the first section opens" semantics.
- **Deferred design (v-next):** a first-class Course Watch implies per-Course section
  enumeration, cross-section dedupe (Alert once when *any* section opens), and new
  contract/schema/worker fan-out. It is the most likely next increment and should be
  designed deliberately, not bolted on.

## Alternatives considered

- *First-class Course Watch now* — matches intent best, but reshapes the core model before
  there is usage data to justify the complexity. Deferred.
- *UI-only "watch all sections" sugar* — expands one click into N Section Watches. Cheap,
  but ungrouped and multi-Alert; a UI convenience, not a model answer. Available as a
  stopgap if course-level demand appears before the real feature.
