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

// Absorb a pending OAuth refresh before the write.
//
// Measured 2026-09-05: wrangler refreshes its token lazily, and the request
// that TRIGGERS the refresh goes out with the stale one and fails
// `code 7403: account not authorized` — while the very next request
// succeeds. Three mints died that way. `whoami` is a harmless read, so it
// takes the hit instead of the INSERT.
//
// Failing here is not fatal: if whoami itself errors the write below will
// report the real problem, and swallowing this keeps an offline-ish
// environment from being blocked by a diagnostic call.
if (remote) {
  try {
    execFileSync('npx', ['wrangler', 'whoami'], { stdio: 'ignore' });
  } catch {
    /* the write reports the real failure */
  }
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

console.log(`\norganization : ${principal}`);
console.log(`expires      : ${days ? `${days} days` : 'never'}`);
console.log(`target       : ${remote ? 'REMOTE (production)' : 'local'}`);
console.log(
  `\nThis organization needs a signed key document at /v2/org-keys/${principal}\n` +
    'before any upload with this token is accepted.',
);
console.log(`\ntoken (shown once):\n\n  ${token}\n`);
