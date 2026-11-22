// SARIF 2.1.0 output: the format GitHub code scanning reads.
//
// A rebuild that misses an obligation is a real defect in that tree, and it belongs where
// defects are listed — next to the pull request, not in a Markdown file nobody opens. Nothing
// here is a security finding in the SAST sense; it is a contract-conformance report expressed in
// a schema CI already understands.
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_VERSION = '2.1.0';
export const DRIVER = 'reacraft';

const LEVEL = { fail: 'error', partial: 'warning', pending: 'note', pass: 'none' };

/**
 * Build a SARIF log from one verification.
 *
 * @param spec - the contract, for rule metadata.
 * @param verification - the scored run.
 * @param options - { rebuildDir, version }
 * @returns a SARIF 2.1.0 log object.
 */
export function toSarif(spec, verification, { rebuildDir = null, version = '0.0.0' } = {}) {
  const obligations = new Map((spec.obligations || []).map((o) => [o.id, o]));
  const results = [];

  for (const r of verification?.results || []) {
    if (r.status === 'pass') continue;
    const o = obligations.get(r.id) || {};
    const detail = [];
    if (r.note) detail.push(r.note);
    if (r.why) detail.push('why it matters: ' + r.why);
    if ((r.missing || []).length) detail.push('missing: ' + r.missing.slice(0, 8).join(', '));

    results.push({
      ruleId: r.id,
      level: LEVEL[r.status] || 'warning',
      message: {
        text: r.item + (r.note ? ' — ' + r.note : ''),
        markdown: '**' + r.item + '**\n\n' + detail.map((d) => '- ' + d).join('\n'),
      },
      locations: [{
        physicalLocation: {
          // The rebuild tree itself is the location: an obligation is about the whole tree, not
          // one line. Relative to SRCROOT below, which is what the reader resolves.
          artifactLocation: { uri: '.', uriBaseId: 'SRCROOT' },
          region: { startLine: 1 },
        },
      }],
      properties: {
        weight: r.weight,
        status: r.status,
        ratio: r.ratio ?? null,
        acceptance: r.acceptance || o.acceptance || null,
        evidence: r.evidence || [],
      },
    });
  }

  const rules = (spec.obligations || []).map((o) => ({
    id: o.id,
    name: o.id,
    shortDescription: { text: o.item },
    fullDescription: { text: [o.why, 'acceptance: ' + o.acceptance].filter(Boolean).join(' — ') },
    defaultConfiguration: { level: 'warning' },
    properties: { weight: o.weight, acceptance: o.acceptance, evidence: o.evidence || [] },
  }));

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: DRIVER,
          informationUri: 'https://github.com/jinhuanranwansui-gif/reacraft',
          version,
          rules,
        },
      },
      originalUriBaseIds: {
        SRCROOT: { uri: normalizeUri(rebuildDir || verification?.rebuildDir || '.') + '/' },
      },
      invocations: [{
        executionSuccessful: true,
        properties: {
          score: verification?.score ?? null,
          gate: verification?.gate ?? null,
          gateResult: verification?.gateResult ?? 'unknown',
        },
      }],
      results,
      properties: {
        score: verification?.score ?? null,
        gate: verification?.gate ?? null,
        gateResult: verification?.gateResult ?? 'unknown',
        counts: {
          pass: verification?.pass ?? 0,
          partial: verification?.partial ?? 0,
          fail: verification?.fail ?? 0,
          pending: verification?.pending ?? 0,
        },
        similarity: verification?.similarity?.score ?? null,
      },
    }],
  };
}

// SARIF wants forward slashes and no Windows drive escaping games.
function normaliseSafe(p) {
  return String(p).replace(/\\/g, '/');
}

function normalizeUri(p) {
  const s = normaliseSafe(p).replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

export { normalizeUri };
