// Audit log (§3.10). Every mutation is authenticated, attributed, and
// recorded: actor, target, before, after, time.
//
// One writer, so no caller invents its own row shape and no mutation is
// recorded in a form the next reader cannot interpret.
import type { Env } from '../types';

export interface Mutation {
  /** Authenticated principal that made the change. */
  actor: string;
  /** What was done, e.g. 'org-keys.store', 'release.retract'. */
  action: string;
  /** What it was done to — an organization, a coordinate, a key id. */
  target: string;
  /** State before, or null when the target did not exist. */
  before: unknown;
  /** State after, or null when the target was removed. */
  after: unknown;
}

function serialise(state: unknown): string | null {
  return state === null || state === undefined ? null : JSON.stringify(state);
}

/**
 * The audit row as an unrun statement, for callers that must write it in the
 * same transaction as the change it records. Choosing D1 over KV was decided
 * on exactly this: a document stored with its audit write failed is an
 * unrecorded mutation, which is the case §3.10 exists for. Pass this to
 * `env.DB.batch([...])` alongside the mutation itself.
 */
export function auditStatement(env: Env, mutation: Mutation) {
  return env.DB.prepare(
    `INSERT INTO audit_log (occurred_at, actor, action, target, before_state, after_state)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    new Date().toISOString(),
    mutation.actor,
    mutation.action,
    mutation.target,
    serialise(mutation.before),
    serialise(mutation.after),
  );
}

/** Record a mutation on its own, when there is no other write to batch with. */
export async function recordMutation(
  env: Env,
  mutation: Mutation,
): Promise<void> {
  await auditStatement(env, mutation).run();
}
