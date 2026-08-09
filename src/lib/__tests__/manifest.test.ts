// parseManifestMeta — the catalog/search metadata extractor.
//
// The regression this pins: every real cajeta.json carries its metadata under
// `details.*`, but the extractor only looked top-level and under `settings.*`,
// so every package published through 2026-07-29 listed an empty description.
import { describe, expect, it } from 'vitest';
import { parseManifestMeta } from '../manifest';

describe('parseManifestMeta', () => {
  it('reads description/keywords from details.* — the canonical placement', () => {
    const meta = parseManifestMeta(
      JSON.stringify({
        details: {
          name: 'dev.cajeta.example',
          version: '1.2.3',
          description: 'an example — details placement',
          keywords: ['gbdt', 'deterministic'],
        },
        settings: { dependencies: { 'dev.cajeta.unit': '0.2.0' } },
      }),
    );
    expect(meta.description).toBe('an example — details placement');
    expect(meta.keywords).toBe('gbdt deterministic');
    expect(meta.dependencies).toEqual([{ name: 'dev.cajeta.unit', version: '0.2.0' }]);
  });

  it('details wins over top-level and settings when both present', () => {
    const meta = parseManifestMeta(
      JSON.stringify({
        description: 'top-level',
        details: { description: 'details' },
        settings: { description: 'settings' },
      }),
    );
    expect(meta.description).toBe('details');
  });

  it('still tolerates the legacy top-level / settings placements', () => {
    expect(parseManifestMeta(JSON.stringify({ description: 'top' })).description).toBe('top');
    expect(
      parseManifestMeta(JSON.stringify({ settings: { description: 'nested' } })).description,
    ).toBe('nested');
  });

  it('empty/garbage manifests degrade to empty strings, not throws', () => {
    expect(parseManifestMeta('not json').description).toBe('');
    expect(parseManifestMeta('{}').description).toBe('');
  });

  // Capabilities were reported as a hardcoded `[]` by /v2/resolve, so every
  // package claimed to touch nothing — dev.cajeta.docs declares
  // ["filesystem"] and dev.cajeta.gossip ["network"], and both resolved as
  // empty. That is the unsafe direction: a capability check that PASSES when
  // it should fail.
  it('extracts declared capabilities from settings', () => {
    const meta = parseManifestMeta(
      JSON.stringify({ settings: { capabilities: ['filesystem', 'network'] } }),
    );
    expect(meta.capabilities).toEqual(['filesystem', 'network']);
  });

  it('distinguishes a declared-empty list from a missing one, both as []', () => {
    // cajeta-cloud's §14.11 guarantee turns on `capabilities: []` MEANING it.
    expect(parseManifestMeta(JSON.stringify({ settings: { capabilities: [] } })).capabilities)
      .toEqual([]);
    expect(parseManifestMeta('{}').capabilities).toEqual([]);
  });

  it('tolerates the top-level placement and ignores non-string entries', () => {
    expect(parseManifestMeta(JSON.stringify({ capabilities: ['network'] })).capabilities)
      .toEqual(['network']);
    expect(
      parseManifestMeta(JSON.stringify({ settings: { capabilities: ['ok', 7, null] } }))
        .capabilities,
    ).toEqual(['ok']);
  });

  it('a non-array capabilities value degrades to [], not a throw', () => {
    expect(parseManifestMeta(JSON.stringify({ settings: { capabilities: 'network' } })).capabilities)
      .toEqual([]);
  });
});
