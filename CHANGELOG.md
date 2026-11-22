# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

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
