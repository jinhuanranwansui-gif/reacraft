# The contract: what a spec promises and how it is scored

This is the file to read if you want to argue with a score.

## Shapes

All three stage files carry a schema id, and both directions are checked by tests.

```jsonc
// profile.json — reacraft.profile/2
{
  "schema": "reacraft.profile/2",
  "target": "/abs/path", "name": "slug", "size": 24576, "sha256": "…",
  "kind": "pe-native | pe-dotnet | elf | macho | apk | jar | asar | wasm | javascript | data | …",
  "pe": { "arch": "x86_64", "sections": […], "imports": […], "exports": […], "delayImports": […] },
  "elf": { "arch": "x86_64", "needed": […], "symbols": […], "interpreter": "…" },
  "macho": { "arch": "arm64", "libraries": […], "segments": […] },
  "asar": { "manifest": {…}, "fileCount": 1200, "byExt": {…} },
  "strings": { "total": 20684, "urls": […], "notable": [{ "rule": "network", "value": "…", "id": "ev-network-ab12cd34ef" }] },
  "ruleScores": { "network": 63, "licensing": 3 },
  "importHits": [{ "rule": "net-http", "api": "ws2_32.dll!recv", "id": "ev-net-http-…" }],
  "stack": { "labels": ["rust"], "primary": "rust" },
  "unknowns": [{ "id": "u-dynamic", "question": "…", "how_to_settle": "…", "severity": "low" }],
  "evidence": [{ "id": "ev-…", "kind": "network", "value": "https://…" }]
}
```

```jsonc
// spec.json — reacraft.spec/2
{
  "schema": "reacraft.spec/2",
  "gate": 80,
  "capabilities": [{ "id": "network", "statement": "embeds remote endpoints", "weight": 3, "evidence": ["ev-…"], "samples": ["https://…"] }],
  "obligations": [{
    "id": "ob-endpoints",
    "item": "every hardcoded endpoint is present in the rebuild",
    "acceptance": "presence | symbols | file-exists | manual",
    "weight": 5,
    "why": "an endpoint that is missing means the rebuild talks to a different service",
    "patterns": ["https://…"],          // acceptance=presence
    "symbols": ["VirtualAllocEx"],      // acceptance=symbols
    "evidence": ["ev-…"]
  }],
  "must_have": [ /* the same list in the v1 shape, for older readers */ ],
  "request": "…the structured rebuild instruction…",
  "round": 1
}
```

```jsonc
// verification.json — reacraft.verification/2
{
  "schema": "reacraft.verification/2",
  "score": 30, "gate": 80, "gateResult": "pass | below | unknown",
  "pass": 0, "partial": 3, "fail": 2, "pending": 1,
  "results": [{ "id": "ob-endpoints", "status": "partial", "ratio": 0.5, "missing": ["https://…"], "note": "1/2 patterns found" }],
  "similarity": {
    "schema": "reacraft.similarity/1",
    "score": 22, "confidence": "low | medium | high", "minhashJaccard": 0.31,
    "coverage": { "endpoints": { "weight": 4, "required": 2, "hit": 1, "ratio": 0.5, "missing": […] } },
    "caveats": […]
  }
}
```

## Scoring

```
score = round( 100 × Σ(earned × weight) / Σ(weight) )     over results with status ≠ pending

earned = 1.0        status = pass
       = ratio      status = partial      (0 < ratio < 1)
       = 0          status = fail
       (excluded)   status = pending
```

Consequences that are easy to get wrong, and are therefore asserted in the tests:

- **A failing obligation must earn nothing.** The first implementation returned 100% for a
  rebuild with a failing item, because the weight of a `fail` was still added to the numerator.
- **Pending is not a pass and not a fail.** It leaves the denominator. A spec with one
  machine obligation and eleven manual ones can read 100% while almost nothing is proven —
  read the counts.
- **Partial earns its ratio**, so "8 of 12 symbols" moves the needle to 67% of that item
  instead of snapping to zero.
- **`gateResult` is `unknown` when nothing was judged**, never `pass`.

## What similarity is not

- It counts presence in a text tree. A literal inside a comment counts.
- MinHash over literals is an estimate with a wide variance on small sets; it is reported
  next to coverage, never folded into the score.
- It does not compare behaviour. `ob-behaviour` exists so that a human has to say so.

## Gap plan

```jsonc
// gaps.json — reacraft.gaps/1
{
  "open": 6,
  "gaps": [{ "id": "ob-endpoints", "kind": "partial | missing | pending | human", "weight": 5,
             "action": "add the missing item: https://…", "ask": "Add these endpoints exactly as written: …",
             "blockers": ["https://…"] }],
  "fixRequest": "Continue the rebuild of …\nCurrent score: 30% (gate 80%).\nClose these, highest weight first:\n- …"
}
```

`reacraft gaps <slug> --apply` writes `fixRequest` into `spec.request` and increments
`spec.round`, so a rebuild engine that reads the spec gets the next instruction without a
human retyping it.

## Ledger

`events.jsonl`, one record per line:

```jsonc
{ "seq": 0, "at": "…", "kind": "rea", "prev": "", "input": [{ "name": "…", "sha256": "…" }],
  "output": [{ "name": "profile.json", "sha256": "…", "bytes": 1234 }], "note": "…", "hash": "…" }
```

`hash` is sha256 over the canonical JSON of the record without `hash` (keys sorted). `prove`
recomputes each hash, each `prev` link, and each recorded output file.

A stage can be re-run, which overwrites its artifact. The newest record for a name wins; older
claims are reported as `superseded`, not as tampering. Everything else — a changed file under
the newest claim, a broken `prev`, an edited record — is a problem and makes `prove` exit 2.
