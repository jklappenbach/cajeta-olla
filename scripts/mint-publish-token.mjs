// Mint a PUBLISH token into `publish_tokens`.
//
// The counterpart to mint-admin-token.mjs, and deliberately a separate script
// for the same reason that is a separate table: a publish token uploads
// artifacts, an owner token changes who olla trusts, and the design turns on
// neither being reachable from the other. There is no code path here that
// touches `admin_tokens`, and no flag that makes this mint one.
//
//   node scripts/mint-publish-token.mjs dev.cajeta             # local D1
//   node scripts/mint-publish-token.mjs dev.cajeta --remote    # production
//   node scripts/mint-publish-token.mjs dev.cajeta --days 365
//
// THE PRINCIPAL IS THE ORGANIZATION (publisher-trust §4.5). Whatever is passed
// here is what olla records as the publisher of every artifact this token
// uploads, and it is the subject of the signed key document the upload is
// checked against — so it must match an organization that has one, exactly.
//
// The raw token is printed ONCE. Only its sha256 is stored, so a lost token is
// re-minted, never recovered.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const principal = args.find((a) => !a.startsWith('--'));
const remote = args.includes('--remote');
const daysAt = args.indexOf('--days');
const days = daysAt === -1 ? null : Number(args[daysAt + 1]);

if (!principal) {
  console.error(
    'usage: node scripts/mint-publish-token.mjs <organization> [--remote] [--days N]',
  );
  process.exit(2);
}
if (daysAt !== -1 && (!Number.isFinite(days) || days <= 0)) {
  console.error('--days needs a positive number');
  process.exit(2);
}

const token = `olla-publish-${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');
const now = new Date().toISOString();
const expiresAt = days
  ? `'${new Date(Date.now() + days * 86_400_000).toISOString()}'`
  : 'NULL';

const sql =
  `INSERT INTO publish_tokens (token_hash, principal, scopes, created_at, expires_at) ` +
  `VALUES ('${hash}', '${principal.replace(/'/g, "''")}', 'publish', '${now}', ${expiresAt});`;

execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'olla-catalog', remote ? '--remote' : '--local', '--command', sql],
  { stdio: 'inherit' },
);

console.log(`\norganization : ${principal}`);
console.log(`expires      : ${days ? `${days} days` : 'never'}`);
console.log(`target       : ${remote ? 'REMOTE (production)' : 'local'}`);
console.log(
  `\nThis organization needs a signed key document at /v2/org-keys/${principal}\n` +
    'before any upload with this token is accepted.',
);
console.log(`\ntoken (shown once):\n\n  ${token}\n`);
