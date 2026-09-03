// Local trust bootstrap. The §5 upload refusals are unconditional, so a local
// registry needs the same three things production does before anything can be
// published: a repository root, a signed key document per organization, and a
// publish key named inside it.
//
//   node scripts/dev-trust.mjs          # generate the dev root, wire .dev.vars
//   node scripts/seed.mjs               # uses it (calls installOrg below)
//
// The root generated here is a DEVELOPMENT root and never leaves this machine.
// The production root is offline and signs at a ceremony; nothing in this
// repository can or should reproduce that (spec §3.1).
import { execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT_KEY_FILE = '.dev-root-key.pem'; // gitignored by *.pem
const ROOT_KEY_ID = 'dev-root-1';
const DEV_VARS = '.dev.vars';

// .dev.vars is dotenv, so the value must be one line — newlines only. NOT all
// whitespace: the PEM parser matches `-----BEGIN <label>-----` with the space
// intact, so squeezing that out silently produces a key nothing can import.
const oneLine = (pem) => pem.replace(/\r?\n/g, '');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Ensure a development root exists and that `.dev.vars` names its public half.
 * Returns true when `.dev.vars` was changed, which means `wrangler dev` is
 * holding the old (or no) value and has to be restarted.
 */
export function ensureDevRoot() {
  if (!existsSync(ROOT_KEY_FILE)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(
      ROOT_KEY_FILE,
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    console.log(`generated ${ROOT_KEY_FILE} (development root, never committed)`);
  }

  // The public half is derived from the private key, never stored separately:
  // two files that can disagree is one more way for local trust to break.
  const pub = oneLine(
    createPublicKey(rootPrivate()).export({ type: 'spki', format: 'pem' }),
  );

  const vars = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
  if (vars.includes(`CAJETA_ROOT_KEY_PEM=${pub}`)) return false;

  const cleaned = vars
    .split('\n')
    .filter((l) => !/^CAJETA_ROOT_KEY_(PEM|ID)=/.test(l))
    .join('\n')
    .replace(/\n+$/, '');
  writeFileSync(
    DEV_VARS,
    `${cleaned}\n\n# Development root (scripts/dev-trust.mjs). PUBLIC half only.\n` +
      `CAJETA_ROOT_KEY_ID=${ROOT_KEY_ID}\nCAJETA_ROOT_KEY_PEM=${pub}\n`,
  );
  console.log(`wrote CAJETA_ROOT_KEY_ID/_PEM into ${DEV_VARS}`);
  return true;
}

function rootPrivate() {
  return createPrivateKey(readFileSync(ROOT_KEY_FILE, 'utf8'));
}

/** Sign a payload the way the operator's olla-key toolkit does: base64 of the
 *  UTF-8 JSON, signature over those decoded bytes, no canonical-JSON step. */
export function signEnvelope(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return JSON.stringify({
    format: 1,
    'root-key-id': ROOT_KEY_ID,
    payload: b64(bytes),
    signature: b64(edSign(null, bytes, rootPrivate())),
  });
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'olla-devtrust-'));
  const file = join(dir, 'bootstrap.sql');
  writeFileSync(file, sql);
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'olla-catalog', '--local', '--file', file],
    { stdio: 'inherit' },
  );
}

const FAR = '2099-01-01T00:00:00Z';

/**
 * Install one organization: a publish token, a fresh publish keypair, and a
 * root-signed key document naming that key over `namespaces`.
 */
export function installOrg({ organization, namespaces }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = `${organization}-dev-1`;
  const token = `olla-publish-${randomBytes(12).toString('base64url')}`;
  const now = new Date().toISOString();

  const envelope = signEnvelope({
    organization,
    namespaces,
    'issued-at': now,
    'not-after': FAR,
    keys: [
      {
        id: keyId,
        algorithm: 'ed25519',
        'public-key': publicKey.export({ type: 'spki', format: 'pem' }),
        'not-before': '2020-01-01T00:00:00Z',
        'not-after': FAR,
      },
    ],
  });

  runSql(
    `INSERT OR REPLACE INTO publish_tokens
       (token_hash, principal, scopes, created_at, expires_at)
     VALUES (${sqlStr(createHash('sha256').update(token).digest('hex'))},
             ${sqlStr(organization)}, 'publish', ${sqlStr(now)}, NULL);
     INSERT OR REPLACE INTO signed_documents
       (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
     VALUES ('org-keys', ${sqlStr(organization)}, ${sqlStr(envelope)},
             ${sqlStr(now)}, ${sqlStr(FAR)}, ${sqlStr(ROOT_KEY_ID)}, ${sqlStr(now)});`,
  );

  return { organization, token, keyId, privateKey };
}

export function signArchive(privateKey, bytes) {
  return edSign(null, Buffer.from(bytes), privateKey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const changed = ensureDevRoot();
  console.log(
    changed
      ? '\n.dev.vars changed — restart `npm run dev` before seeding.'
      : '\ndevelopment root already wired into .dev.vars.',
  );
}
