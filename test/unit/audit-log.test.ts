// Plan 1.1.6. Spec §3.10 — every mutation authenticated, attributed, recorded.
//
// "Who changed which key, and when" is the question asked after a compromise,
// and it cannot be reconstructed later if it was not recorded at the time. So
// the log is append-only at the storage layer, not by convention.
//
// Storage is shared across the tests in this file and the log cannot be
// truncated between them — that is the property under test — so each case
// writes to its own target and reads back by target.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { recordMutation } from '../../src/lib/audit';

interface AuditRow {
  actor: string;
  action: string;
  target: string;
  before_state: string | null;
  after_state: string | null;
  occurred_at: string;
}

function rowFor(target: string) {
  return env.DB.prepare(
    `SELECT actor, action, target, before_state, after_state, occurred_at
       FROM audit_log WHERE target = ?`,
  )
    .bind(target)
    .first<AuditRow>();
}

describe('recordMutation', () => {
  it('captures actor, action, target, before, after and time (1.1.6)', async () => {
    const before = { keys: ['publish-1'] };
    const after = { keys: ['publish-1', 'publish-2'] };

    await recordMutation(env, {
      actor: 'owner:julian',
      action: 'org-keys.store',
      target: 'captures.example',
      before,
      after,
    });

    const row = await rowFor('captures.example');
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('owner:julian');
    expect(row!.action).toBe('org-keys.store');
    expect(JSON.parse(row!.before_state!)).toEqual(before);
    expect(JSON.parse(row!.after_state!)).toEqual(after);
    expect(Number.isFinite(Date.parse(row!.occurred_at))).toBe(true);
  });

  it('records a creation with no prior state', async () => {
    await recordMutation(env, {
      actor: 'owner:julian',
      action: 'org-keys.store',
      target: 'creation.example',
      before: null,
      after: { keys: ['publish-1'] },
    });

    const row = await rowFor('creation.example');
    expect(row!.before_state).toBeNull();
    expect(row!.after_state).not.toBeNull();
  });

  it('records a removal with no resulting state', async () => {
    await recordMutation(env, {
      actor: 'owner:julian',
      action: 'org-keys.remove',
      target: 'removal.example',
      before: { keys: ['publish-1'] },
      after: null,
    });

    const row = await rowFor('removal.example');
    expect(row!.before_state).not.toBeNull();
    expect(row!.after_state).toBeNull();
  });
});

describe('audit_log is append-only (1.1.6)', () => {
  async function seed(target: string) {
    await recordMutation(env, {
      actor: 'owner:julian',
      action: 'org-keys.store',
      target,
      before: null,
      after: { keys: [] },
    });
  }

  it('refuses an UPDATE', async () => {
    await seed('no-update.example');
    await expect(
      env.DB.prepare("UPDATE audit_log SET actor = 'someone-else' WHERE target = ?")
        .bind('no-update.example')
        .run(),
    ).rejects.toThrow(/append-only/);

    const row = await rowFor('no-update.example');
    expect(row!.actor).toBe('owner:julian');
  });

  it('refuses a DELETE', async () => {
    await seed('no-delete.example');
    await expect(
      env.DB.prepare('DELETE FROM audit_log WHERE target = ?')
        .bind('no-delete.example')
        .run(),
    ).rejects.toThrow(/append-only/);

    expect(await rowFor('no-delete.example')).not.toBeNull();
  });
});
