// Defensive extraction of catalog/search metadata from a published
// cajeta.json. The CANONICAL placement is `details.*` — that is where every
// real cajeta manifest carries name/version/description (see any repo's
// cajeta.json) — with top-level and `settings.*` tolerated as fallbacks so
// the registry stays robust across manifest-schema revisions. Omitting
// `details` here was why every published package listed an empty
// description until 2026-07-29.

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
  const details = m.details ?? {};

  const description = String(
    pick(details.description, m.description, settings.description) ?? '',
  );

  const rawKeywords = pick<any>(details.keywords, m.keywords, settings.keywords);
  let keywords = '';
  if (Array.isArray(rawKeywords)) keywords = rawKeywords.join(' ');
  else if (typeof rawKeywords === 'string') keywords = rawKeywords;

  const namespace = (pick<string>(details.namespace, m.namespace, settings.namespace) ??
    null) as string | null;

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
