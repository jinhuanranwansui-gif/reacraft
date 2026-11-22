# 合同：一份 spec 承诺什么，分数怎么算

想跟分数吵架，就读这一篇。

## 三种文件的结构

三份产物都带 schema id，双向兼容都有测试。

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
  "strings": { "total": 20684, "urls": […],
               "notable": [{ "rule": "network", "value": "…", "id": "ev-network-ab12cd34ef" }] },
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
  "capabilities": [{ "id": "network", "statement": "embeds remote endpoints", "weight": 3,
                     "evidence": ["ev-…"], "samples": ["https://…"] }],
  "obligations": [{
    "id": "ob-endpoints",
    "item": "every hardcoded endpoint is present in the rebuild",
    "acceptance": "presence | symbols | file-exists | manual",
    "weight": 5,
    "why": "an endpoint that is missing means the rebuild talks to a different service",
    "patterns": ["https://…"],      // acceptance=presence
    "symbols": ["VirtualAllocEx"],  // acceptance=symbols
    "evidence": ["ev-…"]
  }],
  "must_have": [ /* 同一份清单的 v1 形状，给旧读者 */ ],
  "request": "…结构化重建指令…",
  "round": 1
}
```

```jsonc
// verification.json — reacraft.verification/2
{
  "schema": "reacraft.verification/2",
  "score": 30, "gate": 80, "gateResult": "pass | below | unknown",
  "pass": 0, "partial": 3, "fail": 2, "pending": 1,
  "results": [{ "id": "ob-endpoints", "status": "partial", "ratio": 0.5,
                "missing": ["https://…"], "note": "1/2 patterns found" }],
  "similarity": {
    "schema": "reacraft.similarity/1",
    "score": 22, "confidence": "low | medium | high", "minhashJaccard": 0.31,
    "coverage": { "endpoints": { "weight": 4, "required": 2, "hit": 1, "ratio": 0.5, "missing": […] } },
    "caveats": […]
  }
}
```

## 评分

```
score = round( 100 × Σ(得分 × 权重) / Σ(权重) )     只统计 status ≠ pending 的项

得分 = 1.0      status = pass
     = ratio    status = partial       (0 < ratio < 1)
     = 0        status = fail
     （不计）    status = pending
```

几条容易搞错、因此写进测试的后果：

- **失败项必须拿 0 分。** 第一版把 `fail` 的权重也加进分子，带失败项的重建能打 100 分。
- **pending 既不是 pass 也不是 fail**，它退出分母。一条机器义务加十一条人工义务的 spec，
  可能在什么都没证的情况下读成 100%——**先看计数**。
- **partial 按比例给分**，"12 个符号里 8 个"让这一项拿到 67%，而不是被归零。
- **什么都没判定时 `gateResult` 是 `unknown`**，永远不会是 `pass`。

## 相似度不是什么

- 它数的是文本树里的出现次数。注释里的字面量也算。
- 字面量上的 MinHash 是估计，小集合上方差很大；它只跟覆盖度并排显示，从不并入分数。
- 它不比较行为。`ob-behaviour` 这条人工义务就是为了逼人说一句。

## 差额计划

```jsonc
// gaps.json — reacraft.gaps/1
{
  "open": 6,
  "gaps": [{ "id": "ob-endpoints", "kind": "partial | missing | pending | human", "weight": 5,
             "action": "add the missing item: https://…",
             "ask": "Add these endpoints exactly as written: …",
             "blockers": ["https://…"] }],
  "fixRequest": "Continue the rebuild of …\nCurrent score: 30% (gate 80%).\nClose these, highest weight first:\n- …"
}
```

`reacraft gaps <slug> --apply` 把 `fixRequest` 写进 `spec.request`，并把 `spec.round` 加一。
读 spec 的重建引擎不用人重新描述就能拿到下一轮指令。

## 台账

`events.jsonl`，一行一条：

```jsonc
{ "seq": 0, "at": "…", "kind": "rea", "prev": "",
  "input":  [{ "name": "…", "sha256": "…" }],
  "output": [{ "name": "profile.json", "sha256": "…", "bytes": 1234 }],
  "note": "…", "hash": "…" }
```

`hash` = 去掉 `hash` 字段后按 key 排序的规范 JSON 的 sha256。`prove` 逐条重算 `hash`、
每条 `prev` 链接、以及每个记录过的产物文件。

一个阶段可以重跑，会覆盖产物。**同名产物的最新一条记录负责**，更早的记为 `superseded`，不算篡改。
其余情况——最新记录名下的文件变了、`prev` 断了、记录被改过——都是问题，`prove` 退出码 2。

v0.1 时代写下的记录没有 `hash` 字段：它们被计为 `legacy`，不算断链。
