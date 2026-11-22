# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

> **Which release to pin.** `v0.2.0`–`v0.5.0` are marked **pre-release**: the first day of the project,
> kept for the record, not what you should use. Start at **v0.6.0** or later — that is where the guarded,
> distrusted-input behaviour begins.
>
> 别从 `v0.2.0`–`v0.5.0` 开始用：那是项目的第一天，留着当记录。**从 `v0.6.0` 起**——对不可信输入的处理是从
> 那一版开始的。

## [0.12.0] — 2026-11-22

Five ways to hide a string, not one.

### Added / 新增

- **`decodeShares` is now five strategies, held to one standard.** Each candidate goes through the
  same printable/looks-like-text gate, and a miss costs nothing but a ratio check.
  五种构造一套评分，猜错只浪费一次比率计算。

| strategy | what it reads |
|---|---|
| `split-share` | two equal-length integer arrays, XOR with a position term (bla-agents) |
| `single-array-xor` | one array, XOR with a position term |
| `fromcharcode-list` | `String.fromCharCode(104, 101, …)` — no key, obfuscation by inconvenience |
| `mapped-offset` | `[104, 101, …].map(c => String.fromCharCode(c - 5))` |
| `decimal-strings` | the same trick written as `"229,134,72…"` |

- Every result now carries the `strategy` that produced it, and `result.strategies` lists which ones
  fired — so a reader can tell "recovered by split-share" from "recovered by a list I could have
  read by eye".
- `bench` check `decode-other-construction`, and a test covering four of them at once.

### Verified / 实测

The real bla-agents sample still recovers exactly one value through `split-share` (`0x5d`), which is
the point: adding strategies must not change what the right construction produces.

## [0.11.0] — 2026-11-22

Ground truth, for the case where the original can actually run.

### Added / 新增

- **`golden` command** — runs a command the caller names, keeps what it printed, and records it in the
  ledger. JSON output is parsed; anything else is kept as text. A crash is recorded as a crash, not
  as a golden.
  把原版跑一次的输出来存成 ground truth，并进台账。
- **`verify --against "<command>"`** — runs the rebuild, compares its output to the golden leaf by
  leaf, and reports exactly which path differs.
- **`compareGolden` / `flatten`** — objects and arrays flattened to paths (`items[2]`), floats with a
  1e-9 relative tolerance, type changes counted as changes, extra leaves reported separately.
- **`ob-golden`** — one obligation, not one per leaf: the comparison itself says which leaves differ.
- `bench` check `golden-match`; two tests (a matching run, and a crashed run recorded honestly).

### Verified / 实测

```text
golden   83%   leaves=6 matched=5 changed=1 missing=0   exit 0
  changed  items[2]: 3 → 4
```

Not game-frame's Unicorn harness: this compares printed output, not emulated memory. It is the
middle rung between "the strings look right" and "the port is bit-identical", and it costs one
subprocess.

## [0.10.0] — 2026-11-22

Coverage learns the difference between "wrong" and "nearly right".

### Added / 新增

- **`coverageWithDistance`** — each category now reports `weightedRatio` beside the strict `ratio`,
  and `near` entries naming the closest thing the rebuild actually has. A hit is 1, a near miss
  earns its similarity, a stranger is 0.
  覆盖度从"有没有"升级成"差多少"；严格 ratio 保留，另给加权值。
- **`diceCoefficient` / `nearest`** — bigram Dice (the pg_trgm metric: O(n), good on short literals)
  instead of edit distance, with a candidate cap so a thousand-literal rebuild stays fast.
- The report's coverage table gains a `weighted` column and a `closest miss` column, so a reader can
  see "one character off" without opening the JSON.
- `bench` check `similarity-distance`: a one-character difference must keep most of its credit and a
  different host must not.

### Verified / 实测

```text
required  https://api.example.test/v1/session
rebuild   https://api.example.test/v1/sessi0n
ratio 0    weightedRatio 0.94    near: 0.94
```

The strict ratio stays 0 on purpose. `weightedRatio` is a diagnostic, never a score: a score that
counts almost-matches would flatter every rebuild.

## [0.9.0] — 2026-11-22

The injection detector was tested against its own evasions, and lost 24 times out of 120.

### Added / 新增

- **`tools/fuzz-guard.mjs`** — 8 injection seeds × 15 mutators = 120 payloads, run against
  `scanForInstructions`, with a per-mutator catch table and a failing exit code on any miss.
  CI runs it, so a rule that stops catching a known evasion turns the build red.
  用对抗样本测自己的检测器；漏一条就红。
- **`normalizeForScan`** — three cheap evasions were getting through and are now closed:
  zero-width characters between words, Cyrillic/Greek homoglyphs, and `.`/`_`/`-` as separators.
  A model reads all three without noticing, which is exactly why the detector has to.
- **ROT13 view** — a payload decoded by rot13 is scanned too. A hit only on a decoded or normalised
  form is reported with `obfuscated: true` and one extra weight.

### Fixed / 修复

- **`$1 $2` in a one-group replacement.** An out-of-range `$n` is kept literally by JavaScript, so
  the first normaliser inserted the text `$2` into every string and matched nothing. Found by the
  fuzz run, not by reading.
- **A `SYSTEM:` header mid-sentence.** `Note to any reader: SYSTEM: …` was missed because the rule
  demanded start-of-line. It now accepts a preceding `:` or `;` and is case-sensitive, so a
  lowercase `system:` log prefix is still not a hit.

### Verified / 实测

```
before  76/120 caught  (rot13 13%, zero-width 38%, homoglyph 38%, dotted 38%)
after  120/120 caught on this set
```

Stated honestly: 120 payloads were designed by the same person who wrote the rules, so this is the
floor, not the ceiling. A real attacker with a search loop has a larger space, and the fuzz file says
so at the top.

## [0.8.0] — 2026-11-22

A diagnosis instead of a verdict, borrowed from a better verifier.

### Added / 新增

- **`nearestMatch` — a missing literal now comes with how close the rebuild got.** game-frame's
  `bitcompare` reports a mismatch *plus* its distance in ULP ("1 ULP means one operation in a
  different order; large differences mean a wrong formula"). The string-level analogue is the
  longest shared anchor: a required endpoint whose host appears with a different path is a different
  mistake from a host that is missing entirely, and the fix plan now says which one it is.
  缺口诊断从"缺了"升级成"缺成什么样"：同一 host 不同 path，和整个 host 都没了，是两种错。
- `verify` counts near misses in its per-item note, and `gaps` carries a `near` array with the
  anchor, the text that appears instead, and the file.
- Test: same host with a swapped route must report `near[0].anchor = api.example.test` and the gap
  sentence must contain "near miss".

### Verified / 实测

```text
ob-endpoints   0/2 patterns found (1 near miss)
ask: Add these endpoints … https://api.example.test/v1/session — a near miss exists:
     api.example.test appears as "api.example.test/v1/logout"
```

## [0.7.0] — 2026-11-22

Found by scanning a real machine: a failure mode where the right answer is to stop producing answers.

### Added / 新增

- **`drm.imageEncrypted`** — when several sections are random at once (including structural ones
  like `.pdata` and a compiler marker), the image itself was encrypted or replaced, not wrapped.
  A wrapper keeps the exception table and relocation table readable because the loader needs them.
  整镜像加密与"有壳"分开判定。
- **`strings.unreliable`** — a fully encrypted image yields tens of thousands of accidental printable
  runs. The profile marks them unreliable, and the spec step refuses to build anything on them.
- **`ob-readable-image`** — the contract for such a target collapses to manual obligations, starting
  with "a readable image exists before any behaviour is claimed".
- `bench` and tests cover both: a wrapper with a readable code section, and an image with every
  section random.

### Verified / 实测

`WardogsClient-Win64-Shipping.exe` (228,536,216 bytes) in a real Steam library: no wrapper section,
entry inside `.text`, `.pdata` and `.msvcjmc` at entropy 8.0, `.rsrc` at 2.86 and `.reloc` at 5.32 —
**99.9% of raw bytes random**. Reported as `imageEncrypted`, `readable.code=false`, 2 capabilities,
4 manual obligations, and 60,026 extracted strings marked unreliable in the same profile.

### Changed / 变更

- `drm.readable.code` is false for an encrypted image as well as for an encrypted code section.
- README documents both cases side by side (a SteamStub build whose code is readable, and an image
  that is not readable at all).

## [0.6.0] — 2026-11-22

Found by reading instead of writing: a published attack on this exact kind of tool, and a project
that does the verification part better.

### Added / 新增

- **`src/core/prompt-guard.mjs` — instruction-like strings.** arXiv 2605.30667 showed that a string
  constant the program never uses can be read as an order by any model that sees it. This tool hands
  strings to a model three times, so it now scans **all** strings (the bait matches no parser rule),
  marks hits `suspect: 'instruction-like'`, keeps them out of every sample and obligation, and prints
  them redacted with their evidence id.
  把"给模型看的字符串"当成攻击面来扫，命中即降级，报告里打码但保留 id。
- `unknowns` gains `u-instruction-strings` when anything is found, and the report gains a section
  listing the matched rules and weights.
- `bench` check `guard-marks-bait`: a bait string must be detected and must not appear in any
  contract.

### Changed / 变更

- README now states plainly what this is **not**: [GameFrame](https://tanepiper.github.io/game-frame/)
  runs the original's functions under Unicorn and requires bit-for-bit equality with 104 checks. When
  the original runs, that is the stronger test and it should be used. ReaCraft's claim narrows to
  "the floor you can always compute, without running anything" — a weaker claim, honestly labelled.
  在 README 里承认 GameFrame 的验证更深，把自己的口径收窄到"不运行就能算出的地板"。

## [0.5.0] — 2026-11-22

Reads binaries that ship behind a commercial wrapper, and says exactly how much of them it can see.

### Added / 新增

- **`src/core/drm.mjs` — wrapper detection.** Steam DRM (SteamStub), UPX, VMProtect, Themida and
  Enigma are recognised by structure: the section names, the **per-section entropy** and the
  **entry point's location**. No product string is trusted on its own.
  结构化识别商业壳，不单凭产品字符串。
- **`parsePE` now measures entropy per section**, so a packed or encrypted body is distinguishable
  from compiled code (about 6.5) and from padding (under 4).
- **`drm.codeEncrypted` / `drm.readable.code`** — the honest split between "the wrapper is
  present" and "the code is readable". When the code section is encrypted the profile says so and
  `unknowns` names the way out (dump after the stub decrypts, then read that).
- **`ob-drm-scope`** — one obligation that keeps a wrapper out of the contract: a rebuild owes
  post-launch behaviour, not the packaging.

### Verified / 实测

A real Steam library, not a sample:

| target | what it is | result |
|---|---|---|
| `isaac-ng.exe` (The Binding of Isaac: Rebirth) | SteamStub | `.bind` H=7.98, entry `0x00924310` inside `.bind`, **`.text` H=6.56 → not encrypted**; 13 capabilities, 8 obligations including `ob-drm-scope` |
| `wallpaper64.exe` (Wallpaper Engine) | no wrapper | `drm.detected=false`; the Steam link is not assumed |

The conclusion that matters: **this build ships its program readable**. The wrapper gates launch and
holds the encrypted stub; the code is not ciphertext. A build that does encrypt `.text` gets
`readable.code=false` and no invented obligations — the score never pretends to have read bytes that
were not there.

### Fixed / 修复

- `drm` is always present on a PE (`detected: false` when clean), so a caller never has to guard
  against a missing field.

## [0.4.0] — 2026-11-22

The release that makes it a project rather than a script: a version, an action, a security policy,
and three correctness fixes that were genuinely wrong.

### Added / 新增

- **`--version`** — the CLI reports `reacraft <version>`; the SARIF driver version now comes from the
  same manifest field, so the two can never drift.
- **`action.yml`** — a composite GitHub Action. Reads the target, writes the contract, scores the
  rebuild, fails below the gate, writes the score into the job summary, and uploads the SARIF when
  the job allows it. `uses: jinhuanranwansui-gif/reacraft@v0.4.0`.
- **`SECURITY.md`** — what is in scope (a parser crash on hostile input) and what is not (a shield
  defeating the reader is the designed behaviour).
- **`CONTRIBUTING.md`** — the three rules: run the bench, read the contract, look for prior art.
  Plus what a pull request needs, and the style the code here is held to.
- **`CODE_OF_CONDUCT.md`**, **`.editorconfig`**, issue forms (bug / feature) and a pull request
  template that asks for the same checks CI runs.
- README badges: ci, release, license, node, dependencies.

### Fixed / 修复

- **A short pattern matched as a substring.** `Run` was satisfied by `Runtime`, so an obligation
  about a registry key could pass on code that never touches it. Under five characters a token
  boundary is now required; there is a test for exactly this pair.
- **`minhashJaccard: 0` next to `similarity: 61%`** read as a contradiction. The estimate is now
  `null` below 20 literals on either side, with a caveat that says why, instead of a number nobody
  should trust on a small set.
- **`craft --run` and `rea --deep` failed late** with an ENOENT from inside a spawn. Both now check
  the CLI first and say which knob to set (`REACRAFT_CRAFT_CLI` / `REACRAFT_REA_CLI`).
- **`src/cli.mjs` carried mangled punctuation** — PowerShell's `Set-Content -Encoding UTF8`
  round-trip turned em dashes, middle dots and arrows into mojibake on six lines. Repaired, and the
  rule is now in the contributing guide: write source files with an explicit no-BOM UTF-8 writer.

### Verified / 实测

`node --test`: 19 tests. `node src/cli.mjs bench`: 16 checks, ~60 ms. CI: 3 OS × 3 Node, including
the bench and a BOM-free syntax check on Linux.

## [0.3.0] — 2026-11-22

The masked literals come back, and the score lands in CI.

### Added / 新增

- **`decode` — masked literals recovered by arithmetic** (`src/core/decode.mjs`). A shield that
  stores a literal as two integer halves plus a position term keeps the key in the file, so
  `a[i] ^ b[i] ^ ((i * coef) & 0xffff)` returns the value with **no target code executed**. The
  coefficient is read from the file's own decoder, and the pair is found by shape, not by name.
  纯算术还原被掩码的字面量，不执行目标；普通文件不误报。
- **SARIF 2.1.0 output** — `verify --sarif out.sarif`. `fail` → `error`, `partial` → `warning`,
  `pending` → `note`, each rule carrying weight, acceptance kind and evidence ids, so a sweep can
  run as GitHub code scanning instead of being read by hand.
- **`bench`** — the whole claim in one command on generated fixtures: read, contract, score,
  improvement, gap instruction, ledger tamper detection, shield detection, decoy marking, masked
  literal recovery, SARIF shape, report rendering. 16 checks, ~72 ms, no network, no engine.
  CI runs it on 3 OS × 3 Node.
- **`reacraft_decode` DSH tool** — the same recovery from inside a Harness session.
- Obligation and capability for recovered values (`ob-decoded`, `hidden-strings`), so a rebuild can
  be held to a string that no plain scan finds.

### Verified / 实测

`bla-agents` crackme v6, both hardened artifacts, offline:

```
vault.cjs        1     0x5d   "TEE_ENCLAVE_MASTER_KEY_c9cd_SLOT_0xc23c89e5"
panel.html       1     0x5d   "TEE_ENCLAVE_MASTER_KEY_2dcd_SLOT_0x397443e9"
```

BLA's own red-team table records REA returning 0 of 3 known values at 1×, 4× and 64× budgets. This
does not out-read REA at anything REA does; it closes the one case a static reader was told it could
not close, because the "encryption" was a split whose halves ship together.

## [0.2.1] — 2026-11-22

Reads targets that fight back.

### Added / 新增

- **Shield assessment** (`src/core/shield.mjs`) — recognises bla-agents hardening by marker
  (decoy corpus, generated `_name_hash4` symbols, bait narrative, opaque predicates, masked
  string loops, self-seal), then marks the evidence that cannot be trusted.
  被盾保护的目标会被识别出来，诱饵证据打标记、不进义务。
- **Decoy fields / 诱饵字段** — a rule whose values repeat (or that carries security vocabulary a
  rebuild has no reason to honour) is marked decoy on a shielded target only; endpoints are
  filtered the same way. On an ordinary target nothing is marked.
- **Honest admission of the unreadable** — masked literals (BLA `maximum`/`bankrupt`) are reported
  as `present-but-unreadable` with the two ways out (hook the decoder, or lift and evaluate it).
- `spec.shield` and a report section so a reader sees the verdict next to the score.

### Verified / 实测

`bla-agents` crackme v6 at `bankrupt` intensity (`defenseScore: 99`):

```
detected true (high)   4 signals, 452 generated symbols, 46 bait narrative hits
decoy fields           electron 2×4.5 · anti-analysis 2×4 · mobile 1×11 · licensing 3×2
untrusted evidence     48 marked        endpoints 9 → 3 (six were bait)
masked literals        present-but-unreadable
```

Not a claim to break the shield: BLA's *exhaustion* vectors cannot touch a reader with no budget,
its *poison* can no longer buy evidence — and its masked literals stay unreadable, which the report
says out loud.

## [0.2.0] — 2026-11-22

The release that turns two separate tools into one rail: read → contract → rebuild → score → gap.

### Added / 新增

- **Contract stage / 合同层** — `spec.json` carries obligations, and every obligation names its own
  acceptance test (`presence` / `symbols` / `file-exists` / `manual`), a weight and a `why`.
  每条义务自带验收方式、权重和理由，人工项永不自动通过。
- **Gap stage / 差额反哺** — `gaps.json` + `reacraft gaps --apply` writes the fix request back into
  `spec.request` and bumps `round`, so the next rebuild round is mechanical.
  失败直接变成下一轮指令，不需要人重新描述。
- **Similarity engine / 相似度引擎** — set coverage over endpoints, literals, symbols and structure,
  plus a MinHash estimate. Reported **next to** the obligation score, never merged into it.
  覆盖度与义务分并列报告，不合成一个数。
- **Evidence ledger / 证据链** — hash-chained `events.jsonl`; `reacraft prove` recomputes every
  record and every recorded file. Re-running a stage marks the old artifact `superseded`, not
  tampered; records written before the chain existed are counted as `legacy`.
- **Multi-format reader** — PE (imports, exports, delay imports, signature, overlay), ELF
  (sections, dynsym, DT_NEEDED, interpreter), Mach-O (segments, dylibs, fat check), APK/JAR/ZIP,
  ASAR (manifest, integrity), WASM, pyc, scripts.
- **DSH plugin** — 7 tools on `ctx.tools` (`reacraft_probe/read/spec/verify/report/prove/status`),
  no MCP bridge and no external runtime; ships `skill/rea-craft/SKILL.md`.
- **`selftest`** — one command that runs read → spec → verify → gaps → ledger tamper check.
- **Signed manual obligations / 人工项可签名** — `verify --sign ob-behaviour="ran both, X differs"`
  (or `sign: {…}` in the DSH tool) turns a manual obligation into a pass and keeps the sentence as
  its evidence. An automatic obligation cannot be signed into a pass.
  不然 spec 永远停在 pending，门槛就变成没人看的东西。
- **Templated URLs are evidence, never requirements** — a URL containing `${…}`, `%s`, `#{` or a
  backtick is kept in the profile's strings but never becomes a verbatim requirement; a rebuild can
  never contain the original's template literal.
- **CI** — 3 OS × 3 Node, syntax check, plugin-entry load, zero-dependency assertion.

### Changed / 变更

- Project home defaults to `<package>/projects` and honours `REACRAFT_HOME`.
- `status` shows obligations, gate, open gaps and chain state per project.
- CLI exit codes are CI-friendly: `0` ok, `1` usage/io, `2` gate not met or chain broken.
- `must_have` is still written alongside `obligations` so v0.1 readers keep working.

### Fixed / 修复

- **A failing obligation earned its weight**, so a rebuild with a failed item could score 100%.
  Failures now earn nothing; the case is asserted in the tests.
- **Electron was detected from the word "electron"** in strings — craft-anything itself mentions it
  everywhere. Now decided structurally (`app.asar`, `chrome_*.dll`, `node.dll`).
- **Prefix import matching** filed `SendInput` as network I/O and `SystemParametersInfoA` as process
  creation. Exact names with one `A`/`W` normalisation.
- **Re-running a stage looked like tampering** because the older record's hash went stale.
  The newest claim for a name now wins; older ones are `superseded`.
- **`presence` was all-or-nothing** — one missing literal out of twelve scored zero. Now `partial`
  with a ratio.
- **Duplicate capability rows** when several rules pointed at the same behaviour; they merge.
- **A p-code target (VB6/Delphi) produced a spec of lies.** It now names `u-pcode` and keeps the
  spec short.
- **DSH passed `null` as config**, which crashed `reacraft_status`; the plugin normalises it.
- **Old v0.1 specs have no `obligations`**, which crashed `status`; the reader falls back.
- **Ledger records from v0.1 have no hash** and broke the chain check; they are now `legacy`.
- **`node --test test/`** is treated as a module by Node 22+, which failed the first CI run.

### Verified against a real rebuild / 真实闭环

`default_app.asar` (the Electron default app shipped inside DeepSeek Harness) was read, specced,
rebuilt by craft-anything with a DeepSeek backend, and scored from outside:

```
score 100%  gate=80% → pass
pass=5 partial=0 fail=0 pending=1
similar 67% (medium confidence)
  pass  ob-endpoints       10/10 patterns found
  pass  ob-electron-shape  signed: package.json main=main.js, preload.js present, …
  pass  ob-cap-electron    4/4
  pass  ob-cap-network     6/6
  pass  ob-cap-crypto      2/2
  pending ob-behaviour     needs a human note
```

The first pass scored 96% with one `partial`: the missing pattern was
`https://nodejs.org/docs/v${process.versions.node}/api` — a template literal from the original that
no rebuild could contain verbatim. That is the bug the templated-URL rule fixes.

### Removed / 移除

- The v0.1 `lib/` pipeline and `reacraft.mjs` moved to `legacy/` (not shipped). The v0.2 modules
  replace them; the old skill file was rewritten in place.

## [0.1.0] — 2026-11-16

Internal first cut: `rea` → `spec` → `craft` → `verify` → `report` over `projects/<slug>/`, with a
regex-based checklist and a Markdown report. Never released publicly.

[0.2.0]: https://github.com/jinhuanranwansui-gif/reacraft/releases/tag/v0.2.0
