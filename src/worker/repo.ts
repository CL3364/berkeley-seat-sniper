/**
 * src/worker/repo.ts
 *
 * Binds the raw db fan-out functions (each of which takes a `db` argument
 * first) into a `WorkerRepo`-shaped object with a fixed db connection. The
 * test-engineer can build a fake `WorkerRepo` directly; this adapter is what
 * `startPoller` wires for production.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 * Imports from ../db (read-only; db lane owns the implementation).
 */

import type { Db } from '../db';
import {
  claimAlertDelivery,
  claimOpeningDeliveries,
  cancelAlertDelivery,
  cancelClaimedMailJob,
  claimDeadLetterIncidentsForSurface,
  claimMailBatch,
  claimMailJobs,
  commitOpeningAndEnqueueMail,
  completeMailJob,
  deadLetterMailJob,
  deferAlertDelivery,
  deferMailJob,
  enqueueBlindWindowDisclosures,
  enqueueOperatorMail,
  expireMailOutboxAlerts,
  getClassState,
  getDistinctWatchedClassKeys,
  getMailOutboxHealth,
  getPollCycleCutoff,
  getEligibleAlertDelivery,
  getSubscribersWatching,
  listPendingAlertDeliveries,
  markAlertDeliverySent,
  markDeadLetterIncidentSurfaced,
  recordParserBroken,
  recordParserRecovery,
  retireWatchesForClass,
  sweepRetention,
  upsertClassState,
} from '../db';
import type { RuntimeWorkerRepo } from './types';
import type { ClassKey } from '../shared/class-key';

/**
 * Create a `WorkerRepo` bound to the given db connection. Call once at
 * startup with `getDb()` (production) or `makeTestDb()` (integration tests).
 *
 * PII note: this file never logs anything — callers own log discipline.
 */
export function createWorkerRepo(db: Db): RuntimeWorkerRepo {
  return {
    getDistinctWatchedClassKeys(): Promise<ClassKey[]> {
      return getDistinctWatchedClassKeys(db);
    },

    getPollCycleCutoff(): Promise<string> {
      return getPollCycleCutoff(db);
    },

    getSubscribersWatching(classKey: ClassKey): Promise<Array<{ id: string; email: string }>> {
      return getSubscribersWatching(db, classKey);
    },

    claimAlertDelivery(delivery) {
      return claimAlertDelivery(db, delivery);
    },

    claimOpeningDeliveries(opening) {
      return claimOpeningDeliveries(db, opening);
    },

    listPendingAlertDeliveries() {
      return listPendingAlertDeliveries(db);
    },

    getEligibleAlertDelivery(key) {
      return getEligibleAlertDelivery(db, key);
    },

    cancelAlertDelivery(key) {
      return cancelAlertDelivery(db, key);
    },

    deferAlertDelivery(key) {
      return deferAlertDelivery(db, key);
    },

    markAlertDeliverySent(key) {
      return markAlertDeliverySent(db, key);
    },

    retireWatchesForClass(classKey: ClassKey, activatedThrough: string): Promise<number> {
      return retireWatchesForClass(db, classKey, activatedThrough);
    },

    getClassState(classKey: ClassKey) {
      return getClassState(db, classKey);
    },

    upsertClassState(state: Parameters<RuntimeWorkerRepo['upsertClassState']>[0]): Promise<void> {
      return upsertClassState(db, state);
    },

    commitOpeningAndEnqueueMail(opening) {
      return commitOpeningAndEnqueueMail(db, opening);
    },

    enqueueOperatorMail(input) {
      return enqueueOperatorMail(db, input);
    },

    enqueueBlindWindowDisclosures(options) {
      return enqueueBlindWindowDisclosures(db, options);
    },

    recordParserBroken(input) {
      return recordParserBroken(db, input);
    },

    recordParserRecovery(classKey) {
      return recordParserRecovery(db, classKey);
    },

    claimMailBatch(options) {
      return claimMailBatch(db, options);
    },

    claimMailJobs(options) {
      return claimMailJobs(db, options);
    },

    completeMailJob(input) {
      return completeMailJob(db, input);
    },

    cancelClaimedMailJob(input) {
      return cancelClaimedMailJob(db, input);
    },

    deferMailJob(input) {
      return deferMailJob(db, input);
    },

    deadLetterMailJob(input) {
      return deadLetterMailJob(db, input);
    },

    claimDeadLetterIncidentsForSurface(options) {
      return claimDeadLetterIncidentsForSurface(db, options);
    },

    markDeadLetterIncidentSurfaced(input) {
      return markDeadLetterIncidentSurfaced(db, input);
    },

    expireMailOutboxAlerts() {
      return expireMailOutboxAlerts(db);
    },

    getMailOutboxHealth() {
      return getMailOutboxHealth(db);
    },

    sweepRetention(now) {
      return sweepRetention(db, now);
    },
  };
}
