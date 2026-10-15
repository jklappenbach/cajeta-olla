// Trusted publishing (olla-trusted-publishing §3): the binding from a
// repository, as a verified identity names it, to the organization it may
// publish as. Owner-administered (§3.6), audited (§3.7), one organization per
// repository (§3.8). The default ref pattern admits tags only (§3.1).
import type { Env } from '../types';
import { auditStatement } from './audit';

export const DEFAULT_REF_PATTERN = 'refs/tags/*';

export interface Binding {
  provider: 'github';
  repository: string; // lower-cased owner/name
  organization: string;
  refPattern: string;
  createdAt?: string;
  createdBy?: string;
}

interface Row {
  provider: string;
  repository: string;
  organization: string;
  ref_pattern: string;
  created_at: string;
  created_by: string;
}

function fromRow(r: Row): Binding {
  return {
    provider: r.provider as 'github',
    repository: r.repository,
    organization: r.organization,
    refPattern: r.ref_pattern,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

/** GitHub compares repository names without case; so does the store (§3.1). */
export function normaliseRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

/** `*` matches any run of characters, including none; nothing else is special. */
export function refMatches(pattern: string, ref: string): boolean {
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(ref);
}

export async function findBinding(env: Env, provider: string, repository: string): Promise<Binding | null> {
  const row = await env.DB.prepare(
    `SELECT provider, repository, organization, ref_pattern, created_at, created_by
       FROM publisher_bindings WHERE provider = ? AND repository = ?`,
  )
    .bind(provider, normaliseRepository(repository))
    .first<Row>();
  return row ? fromRow(row) : null;
}

export async function listBindings(env: Env, organization: string): Promise<Binding[]> {
  const r = await env.DB.prepare(
    `SELECT provider, repository, organization, ref_pattern, created_at, created_by
       FROM publisher_bindings WHERE organization = ? ORDER BY provider, repository`,
  )
    .bind(organization)
    .all<Row>();
  return r.results.map(fromRow);
}

export type PutResult = { ok: true; binding: Binding } | { ok: false; status: 409; message: string };

/**
 * Create or replace a binding. A repository already bound to ANOTHER
 * organization is refused (§3.8); re-binding to the same organization
 * replaces the pattern. The change and its audit row commit together.
 */
export async function putBinding(
  env: Env,
  input: { provider: 'github'; repository: string; organization: string; refPattern?: string },
  actor: string,
): Promise<PutResult> {
  const repository = normaliseRepository(input.repository);
  const refPattern = input.refPattern?.trim() || DEFAULT_REF_PATTERN;
  const before = await findBinding(env, input.provider, repository);
  if (before && before.organization !== input.organization) {
    return {
      ok: false,
      status: 409,
      message:
        `${input.provider}:${repository} is bound to organization '${before.organization}'; ` +
        `remove that binding before binding it to '${input.organization}'`,
    };
  }
  const now = new Date().toISOString();
  const after: Binding = {
    provider: input.provider,
    repository,
    organization: input.organization,
    refPattern,
    createdAt: now,
    createdBy: actor,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO publisher_bindings
         (provider, repository, organization, ref_pattern, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(input.provider, repository, input.organization, refPattern, now, actor),
    auditStatement(env, {
      actor,
      action: 'publisher.bind',
      target: `${input.provider}:${repository}`,
      before: before ? publicView(before) : null,
      after: publicView(after),
    }),
  ]);
  return { ok: true, binding: after };
}

/** Remove a binding; a missing one is not an error, and writes no audit row. */
export async function deleteBinding(
  env: Env,
  input: { provider: 'github'; repository: string; organization: string },
  actor: string,
): Promise<{ removed: boolean }> {
  const repository = normaliseRepository(input.repository);
  const before = await findBinding(env, input.provider, repository);
  if (!before || before.organization !== input.organization) return { removed: false };
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM publisher_bindings WHERE provider = ? AND repository = ?`).bind(
      input.provider,
      repository,
    ),
    auditStatement(env, {
      actor,
      action: 'publisher.unbind',
      target: `${input.provider}:${repository}`,
      before: publicView(before),
      after: null,
    }),
  ]);
  return { removed: true };
}

/** The wire shape: hyphenated keys like the rest of the v2 surface. */
export function publicView(b: Binding): Record<string, string> {
  return {
    provider: b.provider,
    repository: b.repository,
    organization: b.organization,
    'ref-pattern': b.refPattern,
    ...(b.createdAt ? { 'created-at': b.createdAt } : {}),
    ...(b.createdBy ? { 'created-by': b.createdBy } : {}),
  };
}
