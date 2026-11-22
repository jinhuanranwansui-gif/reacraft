// Shield assessment: is this target protected, and which of my own readings are bought?
//
// Written against bla-agents (github.com/qybaihe/bla), a blue-team shield that hardens JS/TS,
// Electron ASAR, WASM, Python, native binaries, SQLite, model files and DEX for one purpose:
// make a reverse-engineering agent's *reading* wrong rather than impossible.
//
// Its three moves, and what each one does to this pipeline:
//
//   Poison   format-valid decoys (fake attestation manifests, honey source maps, shadow state
//            machines). ReaCraft does not reason, so it cannot be led down a rabbit hole — but
//            it will happily file a decoy literal as evidence. That is the damage fixed here.
//   Exhaust  inputs sized past an analyzer's budgets (REA: 256 primitive candidates, 32 fuse
//            sentinels, 16 MiB ASAR headers). ReaCraft has no such budget: it parses from the
//            outside and counts. This is where the two tools differ most, and it costs BLA a
//            lot of bytes for nothing.
//   Entangle sibling SHA-256 self-seal, so a stripped or patched file refuses to load. Static
//            reading is unaffected; running a patched build is not.
//
// What no static reader gets back is the *masked string literals* of maximum/bankrupt
// intensity: the value is stored as XOR-masked pieces, so grep, `strings` and this reader all
// see nothing. That is reported, not papered over.
export const SHIELD_SCHEMA = 'reacraft.shield/1';

// Markers that only exist because a shield ran. Each has a false-positive story next to it, so
// a single hit is a signal, not a verdict.
const SIGNALS = [
  {
    id: 'bla-interlock-corpus',
    re: /_interlockSafetyCorpus_/,
    label: 'bla-agents decoy corpus (prompt poison)',
    weight: 5,
  },
  {
    id: 'bla-generated-symbols',
    re: /\b_[a-z][A-Za-z0-9]{2,40}_[0-9a-f]{3,4}\b/g,
    label: 'generated _name_hash4 symbols',
    weight: 3,
    count: true,
  },
  {
    id: 'decoy-narrative',
    re: /ENCLAVE-ATTESTATION-GUARD|HSM attestation|TEE sealed|ZERO-TRUST|zero-trust IPC|quorum ledger|SGX|TPM2|Secure Enclave/i,
    label: 'security narrative used as bait',
    weight: 3,
    count: true,
  },
  {
    id: 'opaque-predicate',
    re: /\b7\s*\*\s*[a-z]\s*\*\s*[a-z]\s*-\s*1\b|Math\.imul\([^)]{0,80}0x85ebca6b/,
    label: 'number-theoretic opaque predicate / mix constant',
    weight: 2,
  },
  {
    id: 'masked-string-loop',
    // A literal rebuilt at run time: byte codes mixed with XOR, in either operand order.
    re: /charCodeAt\([^)]{0,60}\)\s*\^|\^\s*[A-Za-z_$][\w$]*\.charCodeAt\(|fromCharCode\([^)]{0,40}\^/,
    label: 'string decoded byte by byte (masked literal)',
    weight: 3,
    count: true,
  },
  {
    id: 'self-seal',
    re: /self[_ -]?seal|integrityBinding|sidecar[_ -]?entangle/i,
    label: 'sibling integrity binding',
    weight: 2,
  },
  {
    id: 'honey-sourcemap',
    re: /sourceMappingURL=[^\s"']*honey|honey[_ -]?source[_ -]?maps/i,
    label: 'honey source map',
    weight: 2,
  },
];

// A rule whose values repeat is a decoy field: one decoy registered under several names.
const DECOY_REPEAT = 2;
// Security vocabulary a rebuild has no reason to honour, applied only on a shielded target.
const DECOY_WORDS = /\b(?:enclave|attest(?:ation)?|seal(?:ed)?|quorum|ledger|canary|honey|armor|zero-trust|TEE|HSM|SGX|TPM)\b/i;

// Generated rather than written: long, varied, no surrounding prose. Judged by shape.
export function looksGenerated(value) {
  const v = String(value);
  if (v.length < 8) return false;
  const digits = (v.match(/\d/g) || []).length;
  const upper = (v.match(/[A-Z]/g) || []).length;
  const symbols = (v.match(/[^A-Za-z0-9]/g) || []).length;
  return (digits + upper + symbols) / v.length > 0.45;
}

/**
 * Score a target for shielding and mark the evidence that cannot be trusted.
 *
 * @param profile - the profile being built (mutated: notable entries gain `decoy`).
 * @param text - the target's own bytes as text, or null for binaries.
 * @returns the assessment, embedded in the profile as `shield`.
 */
export function assessShield(profile, text) {
  const signals = [];
  if (text) {
    for (const s of SIGNALS) {
      if (s.count) {
        const flags = s.re.flags.includes('g') ? s.re.flags : s.re.flags + 'g';
        const hits = text.match(new RegExp(s.re.source, flags));
        const n = hits ? hits.length : 0;
        if (n > 0) signals.push({ id: s.id, label: s.label, weight: s.weight, count: n, sample: hits[0].slice(0, 120) });
      } else if (s.re.test(text)) {
        signals.push({ id: s.id, label: s.label, weight: s.weight, count: 1 });
      }
    }
  }

  const weight = signals.reduce((a, s) => a + s.weight, 0);
  const detected = weight >= 5;

  // Everything below only runs once a shield is confirmed: on an ordinary target the same
  // words are just vocabulary, and marking them would be a false accusation.
  const byRule = new Map();
  for (const n of profile.strings?.notable || []) {
    if (!byRule.has(n.rule)) byRule.set(n.rule, []);
    byRule.get(n.rule).push(n);
  }

  const decoyFields = [];
  let narrative = 0;
  if (detected) {
    for (const [rule, items] of byRule) {
      const distinct = new Set(items.map((i) => i.value));
      const repeat = items.length / Math.max(1, distinct.size);
      if (items.length >= 4 && repeat >= DECOY_REPEAT) {
        decoyFields.push({ rule, values: items.length, distinct: distinct.size, repeat: Number(repeat.toFixed(1)) });
        for (const item of items) item.decoy = true;
      }
    }
    for (const n of profile.strings?.notable || []) {
      if (n.decoy) continue;
      if (DECOY_WORDS.test(n.value)) { n.decoy = true; narrative++; }
    }
  }

  const maskedLiterals = signals.some((s) => s.id === 'masked-string-loop');

  return {
    schema: SHIELD_SCHEMA,
    detected,
    products: detected ? ['bla-agents'] : [],
    confidence: weight >= 10 ? 'high' : weight >= 5 ? 'medium' : 'low',
    weight,
    signals,
    decoyFields,
    poisonedNarrative: narrative,
    // The honest part: this reader cannot recover masked literals, and says so.
    readable: {
      structure: true,
      identifiers: true,
      plainLiterals: !maskedLiterals,
      maskedLiterals: maskedLiterals ? 'present-but-unreadable' : 'none-detected',
    },
    unreadableCount: (profile.strings?.notable || []).filter((n) => n.decoy).length,
    advice: buildAdvice(detected, maskedLiterals, decoyFields.length, narrative),
  };
}

function buildAdvice(detected, masked, decoys, narrative) {
  const out = [];
  if (!detected) {
    out.push('no shield marker: every evidence id is a plain observation');
    return out;
  }
  if (masked) {
    out.push('masked string literals: a static read cannot recover them — run the program and hook the decoder, or copy the decoding function out and evaluate it offline');
  }
  if (decoys) out.push(decoys + ' rule(s) repeat a value many times: marked decoy and kept out of the obligations');
  if (narrative) out.push(narrative + ' security-narrative literal(s) marked decoy: they read as evidence and are not');
  out.push('structural facts (format, sections, symbols, imports) are unaffected by poisoning: a shield adds bytes, it does not rewrite the container');
  out.push('budget exhaustion does not apply to this reader: there is no candidate limit to trip');
  return out;
}

// A URL on a shielded target is worth keeping only if it looks written by a person.
export function filterEndpoints(endpoints, shielded = false) {
  return (endpoints || []).filter((u) => {
    const bare = String(u).replace(/^https?:\/\//, '');
    if (looksGenerated(bare)) return false;
    if (shielded && DECOY_WORDS.test(bare)) return false;
    return true;
  });
}

export function decoyIds(profile) {
  return new Set((profile.strings?.notable || []).filter((n) => n.decoy).map((n) => n.id));
}

export function shieldSummary(shield) {
  if (!shield) return null;
  if (!shield.detected) return { detected: false };
  return {
    detected: true,
    confidence: shield.confidence,
    signals: shield.signals.map((s) => s.id + (s.count > 1 ? '×' + s.count : '')),
    decoyFields: shield.decoyFields.map((d) => d.rule + '(' + d.distinct + '×' + d.repeat + ')'),
    maskedLiterals: shield.readable.maskedLiterals,
    untrusted: shield.unreadableCount,
  };
}
