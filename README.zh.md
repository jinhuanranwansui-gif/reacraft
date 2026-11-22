# ReaCraft

[English](README.md) · **中文** · [变更日志](CHANGELOG.md) · [合同与评分口径](docs/CONTRACT.zh.md)

读目标 → 写合同 → 重建 → 打分 → 把差额变成下一步。

ReaCraft 站在两个优秀工具的中间，做它们各自都不做的那一段：把静态读取的结果变成**自带验收方式**的义务，按义务给重建打分，再把每个失败翻译成下一轮指令。整条链路留下哈希链记录，事后可以逐条复算。

零依赖。纯 Node，什么都没装也能跑。

```
read ──▶ spec ──▶ (rebuild) ──▶ verify ──▶ gaps ──▶ (rebuild) ──▶ verify
  │        │                       │          │
profile   义务 + 验收方式          分数 +     给重建引擎的
                                 覆盖度      下一步指令
```

## 为什么有这个

| | [REA](https://github.com/morluto/rea) | [craft-anything](https://github.com/storytold/craft-anything) | ReaCraft |
|---|---|---|---|
| 强项 | 读：100+ 命令，原生/托管/安卓/Web/EVM/WASM/固件，背后是 Ghidra 与 Frida | 重建：驱动编码智能体重构 app、游戏、网站，每轮自检 | 把"读到的"变成可打分的合同，把"分数"变成下一步 |
| 重建 | 不做 | 做（需要编码智能体 + 它自己的项目格式） | 交给 craft-anything 或任何编码智能体 |
| 给重建打分 | 义务台账 + 覆盖评估 | 有，但绑在自己的 rebuild 循环里，且是领域算法（网站像素布局 + SSIM、app 的构建/运行/截图/机制检查） | **不依赖引擎、不依赖工具：任何重建文件夹，从外部打分，不需要项目格式、不需要 LLM、不需要运行时** |
| 失败 → 下一步 | — | 它自己的 builder 按自己的检查迭代 | **`gaps` 直接产出下一轮请求，不管重建是谁做的** |
| 可复算 | 证据导出/导入 | 项目内证据库 | **哈希链台账；`prove` 逐个重算记录过的文件** |
| 需要装引擎 | 需要（深度靠 Ghidra） | 需要（106 MB Rust 二进制） | **不需要** |
| DSH 集成 | MCP 桥插件 | MCP 桥插件 | **原生 Cordis 插件：7 个工具，无桥进程，自带 skill** |

口径说窄一点、也说得可查：两个伙伴都把自己的闭环关在**自己的运行时和项目格式里**；ReaCraft 把闭环放在**合同层**——一堆源码就够，读取可以来自它自己的解析器、REA、或者人；打分既不需要 LLM 也不需要 106 MB 的二进制。它**不试图**在读取广度上超过 REA；对网站重建，craft-anything 的像素/SSIM 比对比字面量覆盖更锐利，这种情况下两边的结果都该看。装了 REA 就 `--deep` 交给它，不跟它抢。

## 安装

核心不需要安装：

```bash
node src/cli.mjs probe
```

当命令行用：

```bash
npm i -g reacraft        # 或在本仓库 npm link
reacraft probe
```

当 DSH 插件用（7 个工具，没有 MCP 桥）：

```bash
dsh plugin --profile desktop add link:<本仓库绝对路径>
# 重启 DSH —— bundle patch 只在启动时合入
```

插件直接 import 流水线，工具调用不跨进程。

## 用法

```bash
# 1. 读
node src/cli.mjs rea path/to/sample.exe --name sample

# 2. 合同（每条义务自带验收方式）
node src/cli.mjs spec sample --gate 80

# 3. 重建（先 dry run；--run 才真驱动 craft-anything 的编码智能体）
node src/cli.mjs craft sample --run

# 4. 打分并同时拿到差额
node src/cli.mjs verify sample --rebuild build/sample
#    score 30%   gate=80% → below
#    similar 22% (low confidence, minhash=0)
#    pass=0 partial=3 fail=2 pending=1

# 5. 把差额写回规格，成为下一轮指令
node src/cli.mjs gaps sample --apply

# 6. 报告 + 复算
node src/cli.mjs report sample --html
node src/cli.mjs prove sample
```

退出码：`0` 正常，`1` 用法/IO 错误，`2` 未达门槛或证据链断裂（CI 可以直接用）。

在 DSH 里同样六步是六个工具：`reacraft_read`、`reacraft_spec`、`reacraft_verify`、`reacraft_prove`、`reacraft_report`、`reacraft_status`。

## 分数到底怎么算

两个数分开报，故意不合并——合并会掩盖哪一边弱。

**义务分**：对能判定的义务做加权通过率。权重 1–5；`partial`（比如 12 个符号里命中 8 个）按比例给分；`pending` 完全不计分——**看百分比之前先看 pending 数量**；人工义务不会自己变成 pass。

**集合覆盖**：原目标的词汇有多少进了重建。

| 类别 | 比什么 | 权重 |
|---|---|---|
| endpoints | 主机与 URL 前缀 | 4 |
| literals | 注册表路径、文件路径、SQL、API 路由 | 3 |
| symbols | 导入/导出名，或源码标识符 | 3 |
| structure | manifest 字段、段名、扩展名分布 | 2 |

外加一个基于字面量的 MinHash 估计做交叉参考。

覆盖是"出现过"，不是"行为一致"：一个 URL 出现在注释里也算。报告里写明了，分数是拿来争辩的下限，不是证书。

## 结构

| 文件 | 作用 |
|---|---|
| `src/core/target.mjs` | 格式识别与解析：PE、ELF、Mach-O、APK/JAR/ZIP、ASAR、WASM、脚本 |
| `src/core/rules.mjs` | 所有"这个字面量意味着什么能力"的规则，集中一处可审 |
| `src/core/profile.mjs` | 读取：能力打分、栈猜测、局限、内容派生 evidence id |
| `src/core/spec.mjs` | 合同：能力、带验收方式的义务、结构化重建请求 |
| `src/core/verify.mjs` | 执行义务、加权打分、门槛判定 |
| `src/core/similarity.mjs` | 集合覆盖、Jaccard、MinHash |
| `src/core/gaps.mjs` | 失败 → 下一步指令 |
| `src/core/ledger.mjs` | 哈希链事件日志、`prove` |
| `src/core/report.mjs` | report.md / report.json / report.html |
| `src/core/partners.mjs` | 可选的 REA 与 craft-anything CLI 封装 |
| `src/cli.mjs` | 命令行 |
| `dsh/host/index.js` | DSH 插件：`ctx.tools` 上 7 个工具 |
| `skill/rea-craft/SKILL.md` | 给智能体看的操作手册 |
| `docs/CONTRACT.md` | schema 与评分口径（英文） |
| `docs/CONTRACT.zh.md` | 同上，中文——要跟分数吵架就读这个 |
| `CHANGELOG.md` | 版本之间改了什么（中英对照） |

## 实测踩过的坑（都已修）

- **导入必须精确匹配**，只做 A/W 后缀归一。前缀匹配会把 `SendInput` 认成网络 I/O、把 `SystemParametersInfoA` 认成进程创建。
- **UTF-16 宽串会粘尾字符**（`keychain` → `keychainH`）：用「ASCII 集合 + 去掉尾部 1–2 字符后命中则丢弃」过滤。
- **URL 会粘连**：按第二个 scheme 截断，再按正文标点收尾。
- **Electron 只能结构化判定**（`app.asar`、`chrome_*.dll`），不能看字符串里有没有 "electron"——craft-anything 自己满身这个词。
- **p-code 目标（VB6/Delphi）静态读很薄**，spec 会变短、`unknowns` 会变高；用假义务凑数比承认更糟。
- **失败必须拿 0 分**：第一版把 `fail` 的权重也加进了分子，带失败项的重建能打 100 分。现在是测试里的断言。
- **重跑一个阶段会覆盖产物**，旧记录不该算篡改：最新一条记录对同名产物负责，更早的记为 `superseded`。
- **Windows 下子进程输出别用管道**，sandbox 可能拒绝；写临时文件最稳。

## 局限（先说清楚）

- 只做静态。不执行目标。行为是人来签的义务。
- 没有反汇编、没有反编译器、没有 Ghidra：需要就装 REA 用 `--deep`。
- 相似度是集合覆盖，不是等价。
- APK 只到 zip 索引与 dex 类描述符，不解 manifest。
- 固件、EVM、WASM 内部：不在范围内（REA 覆盖，把它的产物当补充证据传进来）。
- 重建本身不在这个仓库里，是设计决定：`craft` 把请求交给 craft-anything，任何接受这个请求的编码智能体都行。

## 自己验一遍

```bash
node --test                    # 10 个测试，无外部样本，无网络
node src/cli.mjs selftest      # 端到端：读 → 规格 → 打分 → 差额 → 篡改检测
node src/cli.mjs all examples/hello/target.txt --name demo --rebuild examples/hello/rebuild
```

## 许可

MIT。思路来自 [REA](https://github.com/morluto/rea)（MIT）与 [craft-anything](https://github.com/storytold/craft-anything)（MIT OR Apache-2.0）；没有拷贝它们的代码，两者都通过各自的 CLI 调用。
