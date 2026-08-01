/**
 * Public barrel for the db lane. Consumers import from '../db' (or '../../db').
 * Re-exports the schema types, client helpers, and all repo functions.
 */

// Schema table references (for advanced queries in tests)
export {
  alertDeliveries,
  classState,
  deadLetterIncidents,
  DEAD_LETTER_INCIDENT_STATES,
  mailOutbox,
  MAIL_OUTBOX_KINDS,
  MAIL_OUTBOX_STATUSES,
  MAIL_OUTBOX_TERMINAL_REASONS,
  parserHealth,
  PARSER_HEALTH_STATUSES,
  pushSubscriptions,
  subscribers,
  suppressions,
  watchVisibilityOrder,
  watches,
} from './schema';
export type {
  AlertDelivery,
  ClassStateRow,
  DeadLetterIncident,
  DeadLetterIncidentState,
  MailOutboxKind,
  MailOutboxRow,
  MailOutboxStatus,
  MailOutboxTerminalReason,
  NewAlertDelivery,
  NewClassStateRow,
  NewDeadLetterIncident,
  NewMailOutboxRow,
  NewPushSubscription,
  NewParserHealth,
  NewSubscriber,
  NewSuppression,
  NewWatch,
  PushSubscription,
  ParserHealth,
  Subscriber,
  Suppression,
  Watch,
} from './schema';

// DB client and test helpers
export { closeDb, getDb, makeTestDb, runMigrations, tryAcquireWorkerAdvisoryLease } from './client';
export type { Db, WorkerAdvisoryLease } from './client';

// Typed error sentinels
export {
  DuplicateSubscriberError,
  DuplicateWatchError,
  MAX_WATCHES_PER_SUBSCRIBER,
  PushSubscriptionLimitError,
  SubscriberCapacityError,
  SubscriberNotFoundError,
  UniqueSectionCapacityError,
  WatchLimitError,
} from './repo';

// Subscription / watch repo functions
export {
  addWatch,
  addWatchWithFreshness,
  confirmSubscriber,
  createSubscriberWithWatches,
  deleteSubscriber,
  countDistinctLiveClassKeys,
  enqueueResendMailByEmail,
  enqueueSubscriberMail,
  getSubscriberByEmail,
  getSubscriberById,
  hasLiveWatchForClass,
  listWatchFreshness,
  listWatches,
  removeWatch,
} from './repo';
export type {
  CapacityAdmissionOptions,
  ConfirmSubscriberResult,
  SubscriberLookup,
  SubscriberMailKind,
  WatchFreshnessRecord,
} from './repo';

// Worker fan-out repo functions
export {
  acknowledgeDeadLetterIncident,
  claimAlertDelivery,
  claimDeadLetterIncidentsForSurface,
  claimOpeningDeliveries,
  cancelAlertDelivery,
  cancelClaimedMailJob,
  cancelOpenAlertMail,
  claimMailBatch,
  claimMailJobs,
  commitOpeningAndEnqueueMail,
  completeMailJob,
  deadLetterMailJob,
  deferAlertDelivery,
  deferMailJob,
  enqueueOperatorMail,
  expireMailOutboxAlerts,
  expireMailOutboxRetryHorizon,
  getClassState,
  getDistinctWatchedClassKeys,
  getPollCycleCutoff,
  getEligibleAlertDelivery,
  getSubscribersWatching,
  getMailOutboxHealth,
  listPendingAlertDeliveries,
  markAlertDeliverySent,
  markDeadLetterIncidentSurfaced,
  recordParserBroken,
  recordParserRecovery,
  resolveDeadLetterIncident,
  retireWatchesForClass,
  sweepRetention,
  upsertClassState,
} from './repo';
export type {
  AlertDeliveryClaimStatus,
  AlertDeliveryInput,
  ClaimedMailCancellationInput,
  DeadLetterIncidentSurfaceClaim,
  MailCompletionInput,
  MailClaimBatch,
  MailDeferDisposition,
  MailDeferInput,
  MailDispatchJob,
  MailOutboxHealth,
  OpeningMailCommitResult,
  OpeningTransitionInput,
  PendingAlertDelivery,
  RecordParserBrokenResult,
  RetentionSweepResult,
} from './repo';

// Suppression repo functions (FR-12)
export { isSuppressed, suppressEmail } from './repo';

// Push-subscription repo functions (FR-15)
export {
  countPushSubscriptions,
  deletePushSubscription,
  deletePushSubscriptionIfMatches,
  deletePushSubscriptionForSubscriber,
  listPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS_PER_SUBSCRIBER,
  upsertPushSubscription,
} from './repo';
export type { PushSubscriptionRecord } from './repo';

// Binding adapter for the server layer — wraps repo fns into a SubscriptionRepo-shaped object
export { makeRepo } from './repo-adapter';
export type { BoundRepo, SubscriberRecord as DbSubscriberRecord } from './repo-adapter';
