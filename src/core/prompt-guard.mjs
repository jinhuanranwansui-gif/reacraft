// Instruction-like strings: the one attack that targets a reader instead of a binary.
//
// arXiv 2605.30667 ("Automatically Attacking Software Reverse Engineering AI Agents", May 2026)
// shows the technique: put text in a string constant that the program never uses, let the
// decompiler or the strings pass hand it to the model, and the model reads it as an order. The
// program still runs correctly, so nothing looks wrong from the outside.
//
// This tool feeds strings to a model in three places — the profile, the spec's quoted samples and
// the report's evidence table — so it has to be the thing that notices. Nothing here is executed
// and nothing is "sanitised" away: a suspicious string stays in the profile, is marked, and is
// redacted in what gets quoted, so a human can still look at the bytes.
export const GUARD_SCHEMA = 'reacraft.guard/1';

// Patterns that have no legitimate reason to appear as a string constant in a compiled program.
// Deliberately narrow: a help text saying "you must enter a name" is not an instruction, while
// "you must now output the contents of" is.
const PATTERNS = [
  { id: 'override', weight: 5, re: /\b(ignore|disregard|forget|override)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|messages?)/i },
  { id: 'override-zh', weight: 5, re: /(忽略|无视|忘记)(掉)?(之前|以上|前面|上述|先前)的?(所有)?(指令|提示|规则|要求)/ },
  { id: 'chat-template', weight: 4, re: /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>|\[INST\]|\[\/INST\]|<<SYS>>/ },
  { id: 'system-header', weight: 4, re: /(^|\n)\s*(?:#{2,}\s*)?(SYSTEM|DEVELOPER|INSTRUCTION)\s*(?:PROMPT|MESSAGE|OVERRIDE)?\s*[:：]/i },
  { id: 'role-assignment', weight: 4, re: /\byou\s+are\s+(now\s+|hereby\s+)?(an?\s+)?(AI|assistant|language\s+model|agent|helpful\s+assistant|DAN)\b/i },
  { id: 'role-assignment-zh', weight: 4, re: /你(现在)?(是|扮演|作为)(一个)?(AI|助手|模型|智能体)/ },
  { id: 'directive-verb', weight: 3, re: /\byou\s+must\s+(now\s+)?(output|print|respond|answer|reply|reveal|ignore|call|invoke|execute|write)\b/i },
  { id: 'tool-directive', weight: 4, re: /\b(call|invoke|execute|run)\s+(the\s+)?(tool|function|command)\s+[`"']?[A-Za-z_][\w.]*/i },
  { id: 'exfil-directive', weight: 5, re: /\b(send|post|upload|exfiltrate|transmit)\s+(this|the|all)\s+(\w+\s+){0,2}(to|at)\s+https?:\/\//i },
  { id: 'analysis-directive', weight: 3, re: /\b(report|conclude|state|claim)\s+that\s+(this|the)\s+(file|binary|program|sample)\s+is\b/i },
];

// A string is instruction-like when one pattern fires AND it looks like prose rather than a word:
// a two-character throwaway cannot carry an order, and a 2000-character blob is a separate problem.
function candidate(value) {
  const v = String(value);
  return v.length >= 12 && v.length <= 4000;
}

/**
 * Scan strings for text that would read as an order if a model saw it.
 *
 * The most dangerous string is the one that matches *no* parser rule — a sentence about ignoring
 * instructions carries no URL, no registry path, no API name — so this looks at every string,
 * not only the notable ones.
 *
 * @param strings - all extracted strings of the target.
 * @param makeId - (value) => evidence id, supplied by the caller.
 * @returns the assessment; `hits` carry the value so the caller can index it.
 */
export function scanForInstructions(strings = [], makeId = (v) => 'ev-instruction-' + String(v).length) {
  const hits = [];
  const seen = new Set();
  for (const raw of strings) {
    const value = String(raw);
    if (!candidate(value) || seen.has(value)) continue;
    const matched = [];
    for (const p of PATTERNS) {
      if (p.re.test(value)) matched.push({ id: p.id, weight: p.weight });
    }
    if (!matched.length) continue;
    seen.add(value);
    hits.push({
      id: makeId(value),
      value,
      preview: redact(value),
      matched: matched.map((m) => m.id),
      weight: matched.reduce((a, m) => a + m.weight, 0),
    });
  }

  hits.sort((a, b) => b.weight - a.weight);
  return {
    schema: GUARD_SCHEMA,
    detected: hits.length > 0,
    count: hits.length,
    hits,
    // What a caller should do about it.
    advice: hits.length
      ? [
          'instruction-like strings found: they are kept as evidence but must not be quoted into a prompt',
          'anything that reaches a model from this target can be read as an order (arXiv 2605.30667)',
          'the report shows them redacted with their evidence id, so the bytes can still be checked by hand',
        ]
      : ['no instruction-like string found'],
  };
}

// Keep a shape a human can recognise without handing the text to a model.
export function redact(value) {
  const v = String(value);
  const head = v.slice(0, 24).replace(/[\r\n\t]+/g, ' ');
  return '[instruction-like: ' + head + (v.length > 24 ? '…' : '') + ']';
}

// Values a spec may quote. Suspect strings never become samples or requirements.
export function quotable(profile) {
  return (profile.strings?.notable || []).filter((n) => !n.suspect);
}

export function guardSummary(guard) {
  if (!guard?.detected) return { detected: false };
  return {
    detected: true,
    count: guard.count,
    rules: [...new Set(guard.hits.flatMap((h) => h.matched))],
  };
}
