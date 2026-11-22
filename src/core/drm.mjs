// Commercial protection layers: what is wrapping this binary, and how much of it a static read
// can actually see.
//
// Steam's DRM (SteamStub) is the reference case, because it is the one people assume is opaque:
// the vendor's wrapper adds a section, moves the entry point into it, and — depending on the
// build — stores the real code section encrypted, decrypting it at launch. ReaCraft does not
// break any of that. It measures it, and says which part of the file is readable and which part
// is not, so a score is never built on bytes that were never there.
//
// Detectors are deliberately name-light: a section named `.bind` is evidence, not proof, so the
// section's own entropy and the entry point's location are checked as well.
export const DRM_SCHEMA = 'reacraft.drm/1';

// Entropy that means "this body is compressed or encrypted": compiled x86 sits near 6.5, text
// under 4, and a packed body at 7.9+.
const ENCRYPTED = 7.2;

const PRODUCTS = [
  {
    id: 'steam-stub',
    label: 'Steam DRM (SteamStub)',
    sections: [/^\.bind$/i, /^\.steam$/i],
    imports: [/steam_api64?\.dll$/i, /steamclient64?\.dll$/i],
    strings: /SteamAPI_Init|SteamAPI_RestartAppIfNecessary|CSteamEngine|SteamUser|steam_appid\.txt/i,
  },
  {
    id: 'upx',
    label: 'UPX',
    sections: [/^UPX0$/i, /^UPX1$/i, /^\.upx/i],
    imports: [],
    strings: /\$Info: This file is packed with the UPX/i,
  },
  {
    id: 'vmprotect',
    label: 'VMProtect-style virtualisation',
    sections: [/^\.vmp\d?$/i, /^\.vprotect/i],
    imports: [],
    strings: /VMProtect|VMProtectSDK/i,
  },
  {
    id: 'themida',
    label: 'Themida / WinLicense',
    sections: [/^\.themida/i, /^\.winlice/i],
    imports: [],
    strings: /Themida|WinLicense|SecureEngine/i,
  },
  {
    id: 'enigma',
    label: 'Enigma Protector',
    sections: [/^\.enigma\d?$/i],
    imports: [],
    strings: /enigma protector|ENIGMA\\/i,
  },
];

/**
 * Identify the wrapper on a parsed PE and separate what is readable from what is not.
 *
 * @param profile - a profile with `pe` populated.
 * @returns the assessment; `detected: false` when nothing matched.
 */
export function detectDrm(profile) {
  const pe = profile?.pe;
  if (!pe) return { schema: DRM_SCHEMA, detected: false, products: [], evidence: [], advice: [] };

  const sections = pe.sections || [];
  const imports = pe.imports || [];
  const dlls = imports.map((i) => i.dll || '');
  const notable = (profile.strings?.notable || []).map((n) => n.value).join('\n');
  const entry = parseInt(String(pe.entryPoint || '0x0'), 16);

  const matched = [];
  const evidence = [];
  for (const p of PRODUCTS) {
    const hits = [];
    for (const s of sections) {
      if (p.sections.some((re) => re.test(s.name))) hits.push('section:' + s.name + ' (H=' + s.entropy + ')');
    }
    for (const d of dlls) {
      if (p.imports.some((re) => re.test(d))) hits.push('import:' + d);
    }
    if (p.strings && p.strings.test(notable)) hits.push('string:' + p.id);
    if (hits.length) {
      matched.push({ id: p.id, label: p.label, hits });
      evidence.push(...hits);
    }
  }

  // Steam is also identifiable without a named section: the API import alone is enough to say
  // "this build talks to Steam", which is a weaker claim than "it is wrapped".
  const steamApi = dlls.some((d) => /steam_api64?\.dll$/i.test(d));
  if (steamApi && !matched.some((m) => m.id === 'steam-stub')) {
    matched.push({ id: 'steam-linked', label: 'Steamworks API linked', hits: ['import:steam_api'] });
  }

  // The entry point living outside the code section is the structural tell of a wrapper: the
  // stub runs first and hands control back after decrypting.
  const text = sections.find((s) => /^\.text$/i.test(s.name));
  const entrySection = sections.find((s) => entry >= s.virtualAddress && entry < s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
  const entryOutsideText = Boolean(entry && text && entrySection && entrySection.name !== text.name);
  if (entryOutsideText) evidence.push('entry:' + pe.entryPoint + ' in ' + entrySection.name + ' (not .text)');

  // Is the code itself stored encrypted? This is the question that decides whether a static read
  // of the code is possible at all.
  const codeEncrypted = Boolean(text && text.entropy >= ENCRYPTED);
  const encryptedSections = sections.filter((s) => s.rawSize > 4096 && s.entropy >= ENCRYPTED).map((s) => s.name);
  if (codeEncrypted) evidence.push('code-encrypted:.text H=' + text.entropy);

  return {
    schema: DRM_SCHEMA,
    detected: matched.length > 0 || entryOutsideText || codeEncrypted,
    products: matched,
    evidence,
    entryOutsideCode: entryOutsideText,
    codeEncrypted,
    encryptedSections,
    readable: {
      container: true,
      imports: imports.length > 0,
      strings: (profile.strings?.total || 0) > 0,
      // The honest line: a wrapper does not hide the headers, it hides the code.
      code: !codeEncrypted,
    },
    advice: buildAdvice(matched, codeEncrypted, entryOutsideText),
  };
}

function buildAdvice(matched, codeEncrypted, entryOutsideText) {
  const out = [];
  const ids = matched.map((m) => m.id);
  if (ids.includes('steam-stub')) {
    out.push('SteamStub wrapper: the PE headers, imports and strings are readable, and the vendor section holds the encrypted launch stub');
  }
  if (codeEncrypted) {
    out.push('the code section is stored encrypted, so a static read of the program logic is not possible: it needs a runtime dump after the stub decrypts it, or a dedicated unpacker');
  } else if (ids.length) {
    out.push('the code section is NOT encrypted in this build: strings and imports are the real program, not stub noise');
  }
  if (entryOutsideText) {
    out.push('the entry point sits outside the code section, which is how a wrapper takes control before the program runs');
  }
  if (!ids.length && !codeEncrypted) out.push('no commercial wrapper recognised');
  out.push('a wrapper is not behaviour: obligations derived from this file describe the protected image, not what the program does after launch');
  return out;
}

export function drmSummary(drm) {
  if (!drm?.detected) return { detected: false };
  return {
    detected: true,
    products: drm.products.map((p) => p.id),
    codeEncrypted: drm.codeEncrypted,
    encryptedSections: drm.encryptedSections,
    evidence: drm.evidence.slice(0, 6),
  };
}
