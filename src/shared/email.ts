import { z } from 'zod';

/**
 * Generic mailbox schema for trusted configuration and provider payloads.
 *
 * This is deliberately NOT the subscriber-eligibility boundary: operator and
 * sender addresses do not need to be Berkeley addresses. Subscriber-facing
 * request and domain types use {@link SubscriberEmailSchema}.
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('enter a valid email address')
  .max(254);
export type Email = z.infer<typeof EmailSchema>;

/**
 * A normalized subscriber identity.
 *
 * v1 proves control of an exact `@berkeley.edu` mailbox through double opt-in.
 * It does NOT prove current enrollment or any CalNet affiliation. Subdomains
 * and lookalike suffixes are intentionally rejected. Plus tags are rejected so
 * one mailbox cannot bypass subscriber identity, uniqueness, admission, or
 * per-email rate limits; the corresponding base address remains valid.
 */
export const SubscriberEmailSchema = EmailSchema.superRefine((email, context) => {
  const atIndex = email.lastIndexOf('@');

  if (email.slice(atIndex + 1) !== 'berkeley.edu') {
    context.addIssue({
      code: 'custom',
      message: 'use your @berkeley.edu email address',
    });
  }

  if (email.slice(0, atIndex).includes('+')) {
    context.addIssue({
      code: 'custom',
      message: 'use your base @berkeley.edu address without a + tag',
    });
  }
});
export type SubscriberEmail = z.infer<typeof SubscriberEmailSchema>;
