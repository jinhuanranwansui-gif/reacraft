# ReaCraft

Read a target, write a contract, rebuild it, score the rebuild, close the gap.

ReaCraft sits between two excellent tools and does the thing neither of them does on its own:
it takes what a static read found, turns it into obligations that each carry their own
acceptance test, scores a rebuild against those obligations, and turns every failure into the
next instruction. The whole run leaves a hash-chained record you can recompute later.

Zero dependencies. One Node file tree. Runs with nothing installed.

```
read ──▶ spec ──▶ (rebuild) ──▶ verify ──▶ gaps ──▶ (rebuild) ──▶ verify
  │        │                       │          │
profile   obligations +           score +    fix request
          acceptance tests        coverage   for the builder
```

## Why this exists

| | [REA](https://github.com/morluto/rea) | [craft-anything](https://github.com/storytold/craft-anything) | ReaCraft |
|---|---|---|---|
| What it is good at | Reading anything: 100+ CLI commands, native/managed/Android/Web/EVM/WASM/firmware, Ghidra and Frida behind it | Rebuilding: drives a coding agent to reconstruct an app, game or site, then checks its own build each round | Turning a read into a scored contract, and a score into the next instruction |
| Static read | Deep, broad | Clean-room / deep modes, 305 engine tools | Enough to write checkable obligations |
| Rebuild | No | Yes (needs a coding agent + its project format) | Delegates to craft-anything or any coding agent |
| Scoring a rebuild | Obligation ledger; coverage evaluation | Yes — but inside its own rebuild loop, with domain checks (web layout + SSIM similarity, app build/run/screenshot/mechanics checks) | **Engine-free, tool-agnostic: any rebuild folder, scored from outside, no project format, no LLM, no runtime** |
| Failure → next instruction | — | Its builder iterates on its own checks | **`gaps` writes the follow-up request for whichever builder produced the tree** |
| Reproducibility | Evidence export/import | Evidence library inside the project | **Hash-chained ledger; `prove` recomputes every recorded file** |
| Needs an engine installed | Yes (Ghidra for depth) | Yes (106 MB Rust binary) | **No** |
| DSH integration | MCP bridge plugin | MCP bridge plugin | **Native Cordis plugin: 7 tools, no bridge process, ships its own skill** |

The claim is narrow and meant to be checked: both partners close the loop **inside their own
runtime and project format**. ReaCraft closes it at the contract layer — a plain folder of
source is enough, the read can come from anywhere (its own parser, REA, or a person), and the
score needs neither an LLM nor a 106 MB binary. It does **not** try to out-read REA, and it does
not claim a better similarity algorithm than craft-anything's pixel/SSIM comparison: for a
website that comparison is sharper than literal coverage, and if the rebuild came out of
craft-anything you should read its own checks too. When REA is installed, `--deep` hands the
read over instead of competing.

## Install

Nothing to install for the core:

```bash
node src/cli.mjs probe
```

As a CLI:

```bash
npm i -g reacraft        # or: npm link   from this checkout
reacraft probe
```

As a DeepSeek Harness plugin (7 tools, no MCP bridge):

```bash
dsh plugin --profile desktop add link:<absolute path to this checkout>
# restart DSH — bundle patches are merged at startup
```

The plugin imports the pipeline directly, so a tool call never crosses a process boundary.
`reacraft_probe` then reports what else is available.

## Use

```bash
# 1. read
node src/cli.mjs rea  path/to/sample.exe --name sample
#    → kind, stack, imports/symbols, strings, endpoints, and an evidence id per claim

# 2. contract
node src/cli.mjs spec sample --gate 80
#    → capabilities + obligations (each with its acceptance test) + rebuild request

# 3. rebuild (dry run first; --run drives craft-anything's coding agent)
node src/cli.mjs craft sample
node src/cli.mjs craft sample --run

# 4. score, and get the gap plan in the same step
node src/cli.mjs verify sample --rebuild build/sample
#    score 62%  gate=80% → below
#    similar 71% (high confidence, minhash=0.64)
#    pass=4 partial=1 fail=2 pending=1

#    if the tree came from craft-anything, its source lives in <craft project>/app:
node src/cli.mjs verify sample --rebuild path/to/craft-project/app

# 5. push the gap plan back into the spec as the next instruction
node src/cli.mjs gaps sample --apply

# 6. report + proof
node src/cli.mjs report sample --html
node src/cli.mjs prove sample
```

Exit codes are CI-friendly: `0` ok, `1` usage, `2` gate not met or chain broken.

In DSH the same six steps are six tool calls: `reacraft_read`, `reacraft_spec`,
`reacraft_verify`, `reacraft_prove`, `reacraft_report`, `reacraft_status`.

## What a score means, and what it does not

Two numbers are reported and deliberately kept apart. Merging them would hide which one is
weak.

**Obligation score** — weighted pass ratio over obligations that could be judged:

- weights 1–5; 5 means "the rebuild is wrong without it"
- a `partial` obligation (say 8 of 12 symbols present) earns `weight × ratio`
- `pending` obligations are excluded entirely — **always read the pending count before the
  percentage**
- a manual obligation never turns into a pass by itself; someone has to write the note

**Set coverage** — how much of the original's vocabulary reached the rebuild:

| category | what is compared | weight |
|---|---|---|
| endpoints | hosts and URL prefixes | 4 |
| literals | registry paths, file paths, SQL, API routes | 3 |
| symbols | imports/exports, or source identifiers | 3 |
| structure | manifest fields, section names, extension mix | 2 |

Plus a MinHash estimate over literals for a cheap second opinion.

Coverage is presence, not behaviour. A URL can appear in a comment and never be called. The
report says so; the score is meant to be a floor to argue with, not a certificate.

## The parts

| file | role |
|---|---|
| `src/core/target.mjs` | format detection and parsing: PE, ELF, Mach-O, APK/JAR/ZIP, ASAR, WASM, scripts |
| `src/core/rules.mjs` | every rule that decides "this literal means capability X" — reviewable in one place |
| `src/core/profile.mjs` | the read: capability scores, stack guess, limits, content-derived evidence ids |
| `src/core/spec.mjs` | the contract: capabilities, obligations with acceptance tests, structured request |
| `src/core/verify.mjs` | obligation runner, weighted score, gate verdict |
| `src/core/similarity.mjs` | set coverage, Jaccard, MinHash |
| `src/core/gaps.mjs` | failures → the next instruction |
| `src/core/ledger.mjs` | hash-chained event log, `prove` |
| `src/core/report.mjs` | report.md / report.json / report.html |
| `src/core/partners.mjs` | optional REA and craft-anything CLI wrappers |
| `src/cli.mjs` | the CLI |
| `dsh/host/index.js` | the DSH plugin: 7 tools on `ctx.tools` |
| `skill/rea-craft/SKILL.md` | the agent-facing playbook |

Design notes:

- **Exact import matching**, with one `A`/`W` suffix rule. Prefix matching used to file
  `SendInput` as network I/O and `SystemParametersInfoA` as process creation.
- **UTF-16 strings are de-glued**: a wide run read across an ASCII neighbour glues one
  character on the end (`keychainH`), so any wide hit that is an ASCII hit plus one or two
  trailing characters is dropped.
- **URLs are cut at the second scheme** and at prose punctuation, because wide-string runs
  join neighbouring literals.
- **Electron is decided structurally** (`app.asar`, `chrome_*.dll`), never by the word
  "electron" in a string — craft-anything itself mentions Electron everywhere.
- **A p-code target produces a thin spec, and the spec says so.** When VB6 or Delphi wrappers
  hide the logic, the obligations shrink and `unknowns` grows; that is the target's property,
  and hiding it with filler obligations would be worse.
- **Child processes write to temp files, not pipes** on Windows: the sandbox may refuse pipe
  capture while plain file descriptors always work.

## Limits, stated up front

- Static only. Nothing from the target is executed. Behaviour is a human obligation.
- No disassembly, no decompiler, no Ghidra: install REA and use `--deep`.
- Similarity is set coverage, not equivalence.
- APK support stops at the zip index and dex class descriptors; no manifest decoding.
- Firmware, EVM, WASM internals: out of scope (REA covers these; pass its output in as extra
  evidence).
- The rebuild itself is not implemented here by design. `craft` hands a request to
  craft-anything; any coding agent that accepts the request works too.

## Verify the claims

```bash
node --test          # 10 tests, no fixtures, no network
node src/cli.mjs selftest   # end-to-end: read → spec → verify → gaps → ledger tamper check
```

The selftest includes the bug that mattered: a rebuild with a failing obligation once scored
100 because failures were earning their weight. It is now an assertion.

## License

MIT. Built on the ideas of [REA](https://github.com/morluto/rea) (MIT) and
[craft-anything](https://github.com/storytold/craft-anything) (MIT OR Apache-2.0); no code was
copied from either, and both are driven through their own CLIs.
