/**
 * Authenticated-local Operator control for durable dead-letter incidents.
 *
 * The authentication boundary is the deployment host/container runtime:
 * invoke this only through an authorized OS/SSH session or `docker compose
 * exec`. There is intentionally no HTTP route. Output is fixed and never
 * includes arguments, database errors, mail payloads, or subscriber data.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Db } from './client';
import { closeDb, getDb } from './client';
import { acknowledgeDeadLetterIncident, resolveDeadLetterIncident } from './repo';

const INCIDENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const USAGE = 'usage: db:incident <acknowledge|resolve> <incident-uuid>';
const TRANSITION_REJECTED = 'incident transition rejected';
const COMMAND_FAILED = 'incident command failed';

type IncidentAction = 'acknowledge' | 'resolve';

export interface DeadLetterIncidentCliDependencies {
  loadEnvironment(): void;
  getDatabase(): Db;
  closeDatabase(): Promise<void>;
  acknowledge(db: Db, id: string): Promise<boolean>;
  resolve(db: Db, id: string): Promise<boolean>;
  writeOutput(line: string): void;
  writeError(line: string): void;
}

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    // A container receives its environment directly and has no .env file.
    // Any other read/parse failure is real configuration failure, but its
    // details remain hidden from CLI output because they may contain a path.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const defaultDependencies: DeadLetterIncidentCliDependencies = {
  loadEnvironment,
  getDatabase: getDb,
  closeDatabase: closeDb,
  acknowledge: acknowledgeDeadLetterIncident,
  resolve: resolveDeadLetterIncident,
  writeOutput(line) {
    process.stdout.write(`${line}\n`);
  },
  writeError(line) {
    process.stderr.write(`${line}\n`);
  },
};

function parseCommand(args: readonly string[]): { action: IncidentAction; id: string } | undefined {
  if (args.length !== 2) return undefined;
  const [action, id] = args;
  if (
    (action !== 'acknowledge' && action !== 'resolve') ||
    id === undefined ||
    !INCIDENT_UUID_PATTERN.test(id)
  ) {
    return undefined;
  }
  return { action, id };
}

/**
 * Execute one bounded incident-state transition.
 *
 * Exit codes are stable:
 *   0 transition committed
 *   1 environment/database/close failure
 *   2 invalid action, UUID, or argument count
 *   3 incident missing or not transitionable from its current state
 */
export async function runDeadLetterIncidentCli(
  args: readonly string[],
  dependencies: DeadLetterIncidentCliDependencies = defaultDependencies,
): Promise<number> {
  const command = parseCommand(args);
  if (!command) {
    dependencies.writeError(USAGE);
    return 2;
  }

  let exitCode = 1;
  let successMessage: string | undefined;
  let failureReported = false;
  try {
    dependencies.loadEnvironment();
    const db = dependencies.getDatabase();
    const transitioned =
      command.action === 'acknowledge'
        ? await dependencies.acknowledge(db, command.id)
        : await dependencies.resolve(db, command.id);
    if (!transitioned) {
      dependencies.writeError(TRANSITION_REJECTED);
      exitCode = 3;
    } else {
      successMessage =
        command.action === 'acknowledge' ? 'incident acknowledged' : 'incident resolved';
      exitCode = 0;
    }
  } catch {
    dependencies.writeError(COMMAND_FAILED);
    failureReported = true;
    exitCode = 1;
  }

  try {
    await dependencies.closeDatabase();
  } catch {
    // A successful mutation followed by an uncertain client shutdown is
    // reported only as a fixed failure. The transition is idempotent, so the
    // Operator can inspect state before another action.
    if (!failureReported) dependencies.writeError(COMMAND_FAILED);
    exitCode = 1;
  }
  if (exitCode === 0 && successMessage) dependencies.writeOutput(successMessage);
  return exitCode;
}

function isDirectInvocation(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isDirectInvocation()) {
  void runDeadLetterIncidentCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
