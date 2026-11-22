// Programmatic surface. Anything the CLI does, a script can do with these exports.
export { buildProfile, PROFILE_SCHEMA, evidenceId } from './core/profile.mjs';
export { buildSpec, writeSpec, readSpec, normaliseSpec, SPEC_SCHEMA } from './core/spec.mjs';
export { verify, attachSimilarity } from './core/verify.mjs';
export { buildGaps, GAP_SCHEMA } from './core/gaps.mjs';
export { compare, coverage, jaccard, corpus, collectSources, minhashSignature, estimateJaccard } from './core/similarity.mjs';
export { record, prove, fileEntry, sha256File, sha256Text, LEDGER } from './core/ledger.mjs';
export { writeReport, renderMarkdown, renderHtml, REPORT_SCHEMA } from './core/report.mjs';
export { probeEngines, probePartners, which, ENGINE_SPECS } from './core/engines.mjs';
export { readTarget, detectKind, extractStrings, extractEndpoints, parsePE, parseELF, parseMachO, parseAsar } from './core/target.mjs';
export { assessShield, shieldSummary, decoyIds, looksGenerated, SHIELD_SCHEMA } from './core/shield.mjs';
export { decodeShares, decodeFile, decodedLiterals, DECODE_SCHEMA } from './core/decode.mjs';
export { toSarif, SARIF_VERSION } from './core/sarif.mjs';
export { bench, BENCH_SCHEMA } from './core/bench.mjs';
export { CAPABILITIES, STRING_RULES, API_SETS } from './core/rules.mjs';
