// Defensive extraction of catalog/search metadata from a published
// cajeta.json. We tolerate both top-level and `settings.*` placement so the
// registry stays robust across manifest-schema revisions (manifest-v1.json).

export interface ManifestMeta {
  description: string;
  keywords: string; // space-joined for FTS
  namespace: string | null;
  dependencies: { name: string; version: string }[];
}

function pick<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

export function parseManifestMeta(manifestJson: string): ManifestMeta {
  let m: any = {};
  try {
    m = JSON.parse(manifestJson) ?? {};
  } catch {
    m = {};
  }
  const settings = m.settings ?? {};

  const description = String(pick(m.description, settings.description) ?? '');

  const rawKeywords = pick<any>(m.keywords, settings.keywords);
  let keywords = '';
  if (Array.isArray(rawKeywords)) keywords = rawKeywords.join(' ');
  else if (typeof rawKeywords === 'string') keywords = rawKeywords;

  const namespace = (pick<string>(m.namespace, settings.namespace) ?? null) as
    | string
    | null;

  // dependencies: { "<name>": "<constraint>" | { version, from } }
  const depObj = pick<Record<string, any>>(settings.dependencies, m.dependencies) ?? {};
  const dependencies: { name: string; version: string }[] = [];
  for (const [name, spec] of Object.entries(depObj)) {
    let version = '';
    if (typeof spec === 'string') version = spec;
    else if (spec && typeof spec === 'object' && typeof spec.version === 'string')
      version = spec.version;
    dependencies.push({ name, version });
  }

  return { description, keywords, namespace, dependencies };
}
