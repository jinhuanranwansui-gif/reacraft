---
name: rea-craft
description: 用 REA(读透目标) + craft-anything(重建并比对) 跑一条闭环：读目标→出规格→交重建→按义务打分→把差额变成下一步指令。适合本地样本逆向、二进制/应用行为复刻、以及"这东西到底干什么"的取证式分析。
---

# rea-craft

REA 负责把目标读透，craft-anything 负责照规格重建，中间那一层——**读出来的东西要变成可验证的合同**——是这个 skill 补的。它比"读一下"多做三件事：每条结论带可复算的 evidence id；每条义务自带验收方式；每次失败直接产出下一步指令。

## 什么时候用它

- 手里有本地样本（exe / dll / elf / mach-o / apk / jar / asar / js bundle），想弄清它做什么
- 想按行为重建一个东西，并且要有分数而不是"我觉得差不多"
- 需要一个能复算的分析记录，给未来的自己或别人看

不做的事：不执行目标；不做动态追踪（要的话接 REA 的 capture 或 Frida，把结果当补充证据）。

## 五条命令（CLI）

```powershell
node src/cli.mjs probe                                   # 引擎 + 伙伴 CLI + 项目根
node src/cli.mjs rea  <target> [--name slug] [--deep]    # 读：格式/符号/字符串/证据 id
node src/cli.mjs spec <slug> [--request "一句话"] [--gate 80]  # 合同：能力 + 义务 + 重建请求
node src/cli.mjs verify <slug> --rebuild <dir>           # 打分 + 差额
node src/cli.mjs gaps <slug> [--apply]                   # 差额 → 下一步指令
node src/cli.mjs report <slug> [--html]                  # md + json (+ html)
node src/cli.mjs prove <slug>                            # 重算证据链
```

`--deep` 会调 REA CLI 拿更深的结构化结果；`verify` 从来不依赖它。

## 在 DSH 里用（推荐）

装了插件就直接调工具，不用记命令：

| 工具 | 干什么 |
|---|---|
| `reacraft_read` | 读目标，落 profile + 证据 id |
| `reacraft_spec` | 出合同（能力 / 义务 / 重建请求） |
| `reacraft_verify` | 打分 + 差额 + 下一步指令，一步做完 |
| `reacraft_report` | 出报告并复算证据链 |
| `reacraft_prove` | 只验链 |
| `reacraft_status` | 所有项目一览 |

## 判定标准（不要软化）

- **score 只算可判定义务**。`pending` 不计分——看分数前先看 pending 数量。
- **`partial` 按比例给分**。符号覆盖 8/12 是 67%，不是 0 也不是 100。
- **similarity 是独立维度**，覆盖不是等价。字面量出现 != 被使用。
- **manual 义务永远不会自己变成 pass**。要写一句判定依据。
- **unknowns 是交付内容**。逐条说明，不要用平滑措辞盖掉。
- **prove 不过的报告不算数**。链条断了或被重写过，先查再引用。

## 坑（都踩过）

1. **clean room 默认开**：craft CLI 不读目标内部，调用时显式 `--deep --allow-run`。
2. **导入前缀匹配会误判**：`SendInput` 会被认成网络 I/O、`SystemParametersInfoA` 会被认成进程创建。必须用精确名 + A/W 后缀归一。
3. **UTF-16 宽串会粘连**：`keychain` 读成 `keychainH`。用「ASCII 集合 + 去掉尾部 1–2 字符后命中则丢弃」过滤。
4. **URL 也会连成串**：`https://a.com/xhttps://b.com`，按第二个 scheme 截断，再按 `) " < >` 收尾。
5. **Electron 不能靠字符串判**：craft-anything 自己满身 electron 字样（它分析 electron 应用），要按 asar / chrome_*.dll 等结构证据判。
6. **p-code 目标（VB6、Delphi）静态读很薄**：没有导入表可推理，spec 的 unknowns 会高亮，这是目标的属性不是工具的失败。
7. **Windows 下别用管道抓子进程输出**：sandbox 可能拒绝，改成临时文件重定向。

## 闭环怎么走

```
read → spec → (rebuild) → verify → gaps --apply → (rebuild again) → verify
```

第二轮开始 `spec.request` 已经是差额指令，重建引擎直接读它。收敛判据是 `gate`，不是"感觉够了"。
