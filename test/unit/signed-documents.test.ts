// Plan 1.3.1. Spec §2.1 — the envelope is returned byte for byte as it was
// signed.
//
// This is a schema property, asserted now so Unit 2 cannot quietly break it.
// The signature covers the transmitted bytes and there is no canonical-JSON
// step, so a document that is parsed on the way in and reserialised on the way
// out no longer verifies — and it fails in the field, at every client, not
// here. Whitespace, key order and Unicode escapes all have to survive.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ENVELOPE = `{
  "format" : "cajeta-org-keys-v1",
  "root-key-id":"olla-root-1",
    "payload": "eyJvcmdhbml6YXRpb24iOiJkZXYuY2FqZXRhIn0=",
  "signature": "Ym9ndXMtc2lnbmF0dXJlLWJ5dGVz",
  "note": "\\u00e9 trailing space -> "
}
`;

describe('signed_documents', () => {
  it('returns the envelope byte for byte (1.3.1)', async () => {
    await env.DB.prepare(
      `INSERT INTO signed_documents
         (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        'org-keys',
        'dev.cajeta',
        ENVELOPE,
        '2026-09-02T00:00:00Z',
        '2027-09-02T00:00:00Z',
        'olla-root-1',
        new Date().toISOString(),
      )
      .run();

    const row = await env.DB.prepare(
      'SELECT envelope FROM signed_documents WHERE kind = ? AND subject = ?',
    )
      .bind('org-keys', 'dev.cajeta')
      .first<{ envelope: string }>();

    expect(row!.envelope).toBe(ENVELOPE);
  });

  it('keys the repository-wide kinds on an empty subject (1.2.1)', async () => {
    for (const kind of ['repository-keys', 'revocations']) {
      await env.DB.prepare(
        `INSERT INTO signed_documents
           (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
         VALUES (?, '', ?, ?, NULL, ?, ?)`,
      )
        .bind(kind, `{"kind":"${kind}"}`, '2026-09-02T00:00:00Z', 'olla-root-1', new Date().toISOString())
        .run();
    }

    const { results } = await env.DB.prepare(
      "SELECT kind FROM signed_documents WHERE subject = '' ORDER BY kind",
    ).all<{ kind: string }>();
    expect(results.map((r) => r.kind)).toEqual(['repository-keys', 'revocations']);
  });
});
