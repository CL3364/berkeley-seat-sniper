/**
 * Explicit source-safety-stop reset.
 *
 * Invoke deliberately with:
 *   npx tsx src/worker/source-safety-stop-cli.ts RESET_SOURCE_SAFETY_STOP
 */

import {
  SourceSafetyStopResetDeferredError,
  resetSourceSafetyStop,
  sourceSafetyStopCliResetRejection,
} from './source-safety-stop';

if (process.env.SKIP_ENV_FILE !== '1') {
  try {
    process.loadEnvFile();
  } catch {
    // Deployed Operators normally provide env directly; a local file is optional.
  }
}

async function main(): Promise<void> {
  const confirmation = process.argv[2] ?? '';
  const rejection = sourceSafetyStopCliResetRejection(confirmation);
  if (rejection !== null) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'source_safety_stop_reset_rejected',
        classification: rejection,
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    await resetSourceSafetyStop(confirmation);
    process.stdout.write(
      `${JSON.stringify({
        event: 'source_safety_stop_reset',
        classification: 'operator_confirmed',
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'source_safety_stop_reset_failed',
        classification:
          error instanceof SourceSafetyStopResetDeferredError
            ? 'resume_deadline_active'
            : 'marker_reset_failed',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
