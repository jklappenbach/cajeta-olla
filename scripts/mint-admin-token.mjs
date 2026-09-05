// Mint an OWNER token (publisher-trust §3.5) into `admin_tokens`.
//
// Deliberately its own script and its own table: an owner credential is what
// changes who olla trusts, and the whole design turns on it being unreachable
// from the publish path. There is no code path here that touches
// `publish_tokens`, and no flag that makes this mint one.
//
//   node scripts/mint-admin-token.mjs owner:julian            # local D1
//   node scripts/mint-admin-token.mjs owner:julian --remote    # production
//   node scripts/mint-admin-token.mjs owner:julian --days 90
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
  console.error('usage: node scripts/mint-admin-token.mjs <principal> [--remote] [--days N]');
  process.exit(2);
}
if (daysAt !== -1 && (!Number.isFinite(days) || days <= 0)) {
  console.error('--days needs a positive number');
  process.exit(2);
}

const token = `olla-admin-${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');
const now = new Date().toISOString();
const expiresAt = days
  ? `'${new Date(Date.now() + days * 86_400_000).toISOString()}'`
  : 'NULL';

const sql =
  `INSERT INTO admin_tokens (token_hash, principal, scopes, created_at, expires_at) ` +
  `VALUES ('${hash}', '${principal.replace(/'/g, "''")}', 'admin', '${now}', ${expiresAt});`;

try {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'olla-catalog', remote ? '--remote' : '--local', '--command', sql],
    { stdio: 'inherit' },
  );
} catch {
  // The insert did not happen, so the token this run generated is dead —
  // it is deliberately NOT printed. Printing one that authenticates nothing
  // is worse than printing none: it gets stored, and the failure surfaces
  // later as a mysterious 403.
  //
  // The usual cause is a stale Cloudflare OAuth token: the FIRST --remote
  // call of a session fails with code 7403 while the next one succeeds,
  // because the first triggers the refresh. Re-running is normally enough.
  console.error(
    `\nmint: the database write failed, so NO token was created.\n` +
    `If the error above is 7403 (account not authorized), this is usually a\n` +
    `stale auth token — re-run the command; the first --remote call of a\n` +
    `session can fail while the next succeeds. Otherwise check\n` +
    `\`npx wrangler whoami\`.\n`,
  );
  process.exit(1);
}

console.log(`\nprincipal : ${principal}`);
console.log(`expires   : ${days ? `${days} days` : 'never'}`);
console.log(`target    : ${remote ? 'REMOTE (production)' : 'local'}`);
console.log(`\ntoken (shown once):\n\n  ${token}\n`);
