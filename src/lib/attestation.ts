// Build-provenance attestation verification (§15), mirroring the build tool's
// `verifyProvenanceJson` (src/cajeta/buildtool/Provenance.cpp) so the registry
// rejects the same malformed/mis-bound attestations `cajeta install` would.
//
// The attestation is an in-toto Statement v1 envelope whose predicate is a
// SLSA provenance v1 record. The build tool currently ships it UNSIGNED (no
// DSSE envelope on the wire), so verification is structural + a digest binding:
// the statement's subject digest must equal the published artifact's sha256.
// (If a future build tool wraps it in a signed DSSE envelope, verify the
// envelope signature against the trust store before these checks.)

const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILD_TYPE = 'https://cajeta.org/build/v1';

export interface AttestationResult {
  ok: boolean;
  error?: string;
  buildType?: string;
  compilerVersion?: string;
  flavor?: string;
  target?: string;
  manifestChecksum?: string;
  lockfileChecksum?: string;
}

function fail(error: string): AttestationResult {
  return { ok: false, error };
}

/** `expectedHex` is the bare lowercase sha256 hex of the published archive. */
export function verifyAttestation(jsonDoc: string, expectedHex: string): AttestationResult {
  let root: any;
  try {
    root = JSON.parse(jsonDoc);
  } catch {
    return fail('parse error');
  }
  if (typeof root !== 'object' || root === null) {
    return fail('top-level value is not an object');
  }
  if (root._type !== STATEMENT_TYPE) {
    return fail(`_type mismatch — expected '${STATEMENT_TYPE}'`);
  }
  if (root.predicateType !== PREDICATE_TYPE) {
    return fail(`predicateType mismatch — expected '${PREDICATE_TYPE}'`);
  }
  const subject = root.subject;
  if (!Array.isArray(subject) || subject.length === 0) {
    return fail('subject[] is empty');
  }
  const s0 = subject[0];
  const claimed = s0?.digest?.sha256;
  if (typeof claimed !== 'string') {
    return fail('subject[0].digest.sha256 missing');
  }
  const claimedHex = claimed.replace(/^sha256:/, '');
  if (claimedHex !== expectedHex) {
    return fail(`archive digest mismatch — claimed sha256:${claimedHex}, actual sha256:${expectedHex}`);
  }
  const bd = root.predicate?.buildDefinition;
  if (!bd || typeof bd !== 'object') {
    return fail('predicate.buildDefinition missing');
  }
  if (bd.buildType !== BUILD_TYPE) {
    return fail(`buildType '${bd.buildType ?? ''}' is not the cajeta build type`);
  }
  const ext = bd.externalParameters ?? {};
  const intl = bd.internalParameters ?? {};
  const compilerVersion = intl['compiler-version'] ?? '';
  const manifestChecksum = ext['manifest-checksum'] ?? '';
  if (!compilerVersion) {
    return fail('internalParameters.compiler-version is empty — required field');
  }
  if (!manifestChecksum) {
    return fail('externalParameters.manifest-checksum is empty — required field');
  }
  return {
    ok: true,
    buildType: bd.buildType,
    compilerVersion,
    flavor: intl.flavor ?? '',
    target: intl.target ?? '',
    manifestChecksum,
    lockfileChecksum: ext['lockfile-checksum'] ?? '',
  };
}
