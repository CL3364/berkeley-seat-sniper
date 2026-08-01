import { describe, expect, it, vi } from 'vitest';
import type { Db } from './client';
import {
  runDeadLetterIncidentCli,
  type DeadLetterIncidentCliDependencies,
} from './dead-letter-incident-cli';

const INCIDENT_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeHarness() {
  const db = {} as Db;
  const output: string[] = [];
  const errors: string[] = [];
  const loadEnvironment = vi.fn<() => void>();
  const getDatabase = vi.fn<() => Db>(() => db);
  const closeDatabase = vi.fn<() => Promise<void>>(async () => undefined);
  const acknowledge = vi.fn<DeadLetterIncidentCliDependencies['acknowledge']>(async () => true);
  const resolve = vi.fn<DeadLetterIncidentCliDependencies['resolve']>(async () => true);
  const writeOutput = vi.fn<(line: string) => void>((line) => output.push(line));
  const writeError = vi.fn<(line: string) => void>((line) => errors.push(line));
  const dependencies: DeadLetterIncidentCliDependencies = {
    loadEnvironment,
    getDatabase,
    closeDatabase,
    acknowledge,
    resolve,
    writeOutput,
    writeError,
  };

  return {
    acknowledge,
    closeDatabase,
    db,
    dependencies,
    errors,
    getDatabase,
    loadEnvironment,
    output,
    resolve,
    writeError,
    writeOutput,
  };
}

describe('dead-letter incident operator CLI', () => {
  it.each([
    { name: 'no arguments', args: [] },
    { name: 'missing UUID', args: ['acknowledge'] },
    { name: 'extra argument', args: ['resolve', INCIDENT_ID, 'extra'] },
    { name: 'unknown action', args: ['delete', INCIDENT_ID] },
    { name: 'abbreviated action', args: ['ack', INCIDENT_ID] },
    { name: 'leading UUID whitespace', args: ['acknowledge', ` ${INCIDENT_ID}`] },
    { name: 'trailing UUID whitespace', args: ['resolve', `${INCIDENT_ID} `] },
    {
      name: 'non-RFC UUID version',
      args: ['acknowledge', '123e4567-e89b-02d3-a456-426614174000'],
    },
    {
      name: 'non-RFC UUID variant',
      args: ['resolve', '123e4567-e89b-42d3-7456-426614174000'],
    },
  ])('returns usage exit 2 for $name without touching environment or DB', async ({ args }) => {
    const harness = makeHarness();

    const exitCode = await runDeadLetterIncidentCli(args, harness.dependencies);

    expect(exitCode).toBe(2);
    expect(harness.output).toEqual([]);
    expect(harness.errors).toEqual(['usage: db:incident <acknowledge|resolve> <incident-uuid>']);
    expect(harness.loadEnvironment).not.toHaveBeenCalled();
    expect(harness.getDatabase).not.toHaveBeenCalled();
    expect(harness.acknowledge).not.toHaveBeenCalled();
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.closeDatabase).not.toHaveBeenCalled();
  });

  it('acknowledges the exact UUID, closes first, and emits only fixed success output', async () => {
    const harness = makeHarness();

    const exitCode = await runDeadLetterIncidentCli(
      ['acknowledge', INCIDENT_ID],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.loadEnvironment).toHaveBeenCalledOnce();
    expect(harness.getDatabase).toHaveBeenCalledOnce();
    expect(harness.acknowledge).toHaveBeenCalledOnce();
    expect(harness.acknowledge).toHaveBeenCalledWith(harness.db, INCIDENT_ID);
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      harness.writeOutput.mock.invocationCallOrder[0]!,
    );
    expect(harness.output).toEqual(['incident acknowledged']);
    expect(harness.errors).toEqual([]);
    expect([...harness.output, ...harness.errors].join('\n')).not.toContain(INCIDENT_ID);
  });

  it('resolves the exact UUID and emits only fixed success output', async () => {
    const harness = makeHarness();
    const uppercaseId = INCIDENT_ID.toUpperCase();

    const exitCode = await runDeadLetterIncidentCli(['resolve', uppercaseId], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.resolve).toHaveBeenCalledWith(harness.db, uppercaseId);
    expect(harness.acknowledge).not.toHaveBeenCalled();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.output).toEqual(['incident resolved']);
    expect(harness.errors).toEqual([]);
    expect([...harness.output, ...harness.errors].join('\n')).not.toContain(uppercaseId);
  });

  it.each(['acknowledge', 'resolve'] as const)(
    'returns exit 3 when %s cannot transition the incident',
    async (action) => {
      const harness = makeHarness();
      harness[action].mockResolvedValue(false);

      const exitCode = await runDeadLetterIncidentCli([action, INCIDENT_ID], harness.dependencies);

      expect(exitCode).toBe(3);
      expect(harness[action]).toHaveBeenCalledWith(harness.db, INCIDENT_ID);
      expect(harness.closeDatabase).toHaveBeenCalledOnce();
      expect(harness.output).toEqual([]);
      expect(harness.errors).toEqual(['incident transition rejected']);
      expect(harness.errors.join('\n')).not.toContain(INCIDENT_ID);
    },
  );

  it('returns fixed exit 1 output when environment loading fails', async () => {
    const harness = makeHarness();
    harness.loadEnvironment.mockImplementation(() => {
      throw new Error(`secret-path/${INCIDENT_ID}`);
    });

    const exitCode = await runDeadLetterIncidentCli(
      ['acknowledge', INCIDENT_ID],
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.getDatabase).not.toHaveBeenCalled();
    expect(harness.acknowledge).not.toHaveBeenCalled();
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.output).toEqual([]);
    expect(harness.errors).toEqual(['incident command failed']);
    expect(harness.errors.join('\n')).not.toContain(INCIDENT_ID);
  });

  it('returns fixed exit 1 output when database acquisition fails', async () => {
    const harness = makeHarness();
    harness.getDatabase.mockImplementation(() => {
      throw new Error(`postgres://sensitive/${INCIDENT_ID}`);
    });

    const exitCode = await runDeadLetterIncidentCli(['resolve', INCIDENT_ID], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.output).toEqual([]);
    expect(harness.errors).toEqual(['incident command failed']);
    expect(harness.errors.join('\n')).not.toContain(INCIDENT_ID);
  });

  it.each(['acknowledge', 'resolve'] as const)(
    'returns fixed exit 1 output when %s throws and still closes',
    async (action) => {
      const harness = makeHarness();
      harness[action].mockRejectedValue(new Error(`sensitive payload ${INCIDENT_ID}`));

      const exitCode = await runDeadLetterIncidentCli([action, INCIDENT_ID], harness.dependencies);

      expect(exitCode).toBe(1);
      expect(harness.closeDatabase).toHaveBeenCalledOnce();
      expect(harness.output).toEqual([]);
      expect(harness.errors).toEqual(['incident command failed']);
      expect(harness.errors.join('\n')).not.toContain(INCIDENT_ID);
    },
  );

  it('returns exit 1 and suppresses success output when close fails after a transition', async () => {
    const harness = makeHarness();
    harness.closeDatabase.mockRejectedValue(new Error(`socket failure ${INCIDENT_ID}`));

    const exitCode = await runDeadLetterIncidentCli(
      ['acknowledge', INCIDENT_ID],
      harness.dependencies,
    );

    expect(harness.acknowledge).toHaveBeenCalledWith(harness.db, INCIDENT_ID);
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(exitCode).toBe(1);
    expect(harness.output).toEqual([]);
    expect(harness.errors).toEqual(['incident command failed']);
    expect(harness.errors.join('\n')).not.toContain(INCIDENT_ID);
  });

  it('does not duplicate fixed failure output when both the action and close fail', async () => {
    const harness = makeHarness();
    harness.resolve.mockRejectedValue(new Error('first sensitive failure'));
    harness.closeDatabase.mockRejectedValue(new Error('second sensitive failure'));

    const exitCode = await runDeadLetterIncidentCli(['resolve', INCIDENT_ID], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.output).toEqual([]);
    expect(harness.errors).toEqual(['incident command failed']);
  });
});
