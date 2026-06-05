/**
 * src/worker/index.ts
 *
 * Process entry point: `npm run worker` → `tsx src/worker/index.ts`.
 *
 * Tests import from `../worker/public` (a side-effect-free barrel) to avoid
 * triggering `startPoller()` at import time.
 *
 * Lane: src/worker/** — owned by worker-engineer.
 */

import { startPoller } from './poller';

// Surface unhandled rejections as fatal so a process supervisor can restart.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_rejection',
      error: reason instanceof Error ? reason.message : String(reason),
    }) + '\n',
  );
  process.exit(1);
});

startPoller().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'poller_fatal',
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
