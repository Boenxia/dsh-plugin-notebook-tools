---
name: notebook-tools
description: |
  读取、修改、新建、清理 Jupyter Notebook（.ipynb）时使用。当用户要求查看/编辑/插入/删除
  notebook 单元格、新建或编写 notebook 脚本、清空输出、校验 notebook 结构，或按文本
  搜索 notebook 内容时使用；由 dsh-plugin-notebook-tools 插件提供 9 个 notebook_* 工具。
whenToUse: '用户提到 .ipynb / Jupyter Notebook / 单元格（cell）、要新建或编写 notebook 脚本、要清空 notebook 输出、要在 notebook 里按文本或正则查找、要批量改代码单元格时。前提：dsh-plugin-notebook-tools 插件已装入当前 profile 并生效。'
metadata:
  authoredBy: ported-from-openclaw-notebook-tools
  source: https://github.com/Lightbridge-KS/openclaw-notebook-tools
  updatedAt: 2026-10-15T00:00:00.000Z
  version: 4
---

# 处理 Jupyter Notebook

不要用 `read` / `write` / `edit` / `str_replace_editor` 这类通用文件工具直接改
`.ipynb`——它的本质是 JSON，手工改极易破坏结构、且非常费 token。改用下面这套
cell-aware 工具（由 `dsh-plugin-notebook-tools` 注册）：

| 工具 | 作用 | 有副作用 |
| --- | --- | --- |
| `notebook_read` | 结构化读取整个或指定单元格（可选输出） | 否 |
| `notebook_list_cells` | 轻量索引：id / 类型 / 预览 / 输出计数 | 否 |
| `notebook_search` | 按文本或正则查找单元格 | 否 |
| `notebook_validate` | 校验结构并报告事实 | 否 |
| `notebook_create` | 新建 notebook | 是 |
| `notebook_edit_cell` | 替换某单元格的 source / 类型 | 是 |
| `notebook_insert_cell` | 插入单元格 | 是 |
| `notebook_delete_cell` | 删除单元格 | 是 |
| `notebook_clear_outputs` | 清空全部或单个单元格的输出 | 是 |

## notebook 写法约定（风格）

写 notebook 时按下面这套排版。**章节说明一律单独占一个 markdown 单元格**，
不要把分节标题塞进代码格的注释里：

- **首格**（markdown）：`# 文件名去掉扩展名` → 一句「这个脚本做什么」→ 需要时
  再加 `## 使用方法` + 有序列表 → 末尾用 `---` 收束。整个 notebook 只用这一个
  `---`。
- **每个章节 = 1 个 markdown 格 + 1..n 个代码格**。markdown 格写
  `## N. 中文标题`（N 从 1 开始），下面接一两句散文（这节做什么、为什么），
  要罗列要点时再用 `- ` 列表。
- **代码格里不放分节横幅**：不要 `# =====`、也不要 `# 1. 标题` 这类复制标题的
  注释。代码里的 `#` 只解释**这一行为什么这么写**。
- **提醒、注意事项用引用块**：`> **注意**: …`、`> ✅ 已完成 …`。
- 同一章节有多段代码时，**共用一个** markdown 格，不要每格前面都补一个标题。
- **类型必须对**：首格和每个 `## N.` 标题格的 `cell_type` 必须是 `markdown`。
  内容长得像 markdown 但类型写成了 `code` 时，JupyterLab 的 `Run All` 会把它当
  Python 执行，在第一处非注释文字上直接抛
  `SyntaxError: invalid character '（' (U+FF08)`——而且报错位置往往隔了好几格，
  很容易误判成别的问题。

> 这是本项目的默认风格。用户明确要求别的排版（英文标题、不编号、或把所有说明
> 写成代码注释）时，以用户的要求为准。

## 工作流

1. **新建一律用 `notebook_create`**，不要手写 notebook JSON。
2. **先列或先搜**：要总览用 `notebook_list_cells`；已知目标文本用
   `notebook_search`。两者都会返回**稳定的 cell id**。
3. **按需精确读**：需要正文时才用 `notebook_read`，配合 `cell_ids`、
   `cell_range`，只在必要时加 `include_outputs`。
4. **用 `cell_id` 定位，不要用下标**：任何插入/删除都会让下标漂移，
   cell id 则跨操作稳定（稳定性见下）。
5. **能用就带上陈旧校验**：改动前把最近一次结果里的小票传进去，避免覆盖别人
   期间的修改——但**只有这几个来源有效**，别臆造：
   - `expected_file_sha256` ← **`notebook_read`** 或 **`notebook_list_cells`**
     返回的 `file_sha256`。这是最强的一道：整份文件任何一个字节变了都会拦下，
     连「同一毫秒内被重写」也拦得住。**首选它。**
   - `expected_source_sha256` ← 只有 **`notebook_read`** 返回 `source_sha256`；
     `notebook_list_cells` / `notebook_search` **不返回**它。它守的是**单个
     单元格**：`edit_cell` / `delete_cell` 守目标格，`insert_cell` 守
     `anchor_id` 那一格，`clear_outputs` 守指定格。
   - `expected_file_mtime_ms` ← **`notebook_read`** 或 **`notebook_list_cells`**
     返回的 `mtime_ms`；`notebook_search` / `notebook_validate` **不返回**。
6. **改，而不是重写**：改内容用 `notebook_edit_cell`，加单元格用
   `notebook_insert_cell`，改完用 `notebook_validate` 收尾。

## 写入的保真度（重要）

本工具集**只改你要求改的那一处**，其余部分原样写回：

- **保留原文件的排版**：JSON 缩进（0/1/2/4 空格）、行尾（LF / CRLF）、末尾有没有
  换行，都按读到的样子写回。JupyterLab、`nbformat.writes`、或手工编辑产生的
  notebook 不会被重新格式化。
- **不凭空添加字段**：某单元格原本没有 `outputs` / `execution_count` / `metadata`
  键，写回后仍然没有。
- **`source` 的形态保持原样**：原本是字符串就写回字符串，原本是「一行一个元素的
  数组」就写回数组。
- 所以「读进来 → 什么都没改 → 写回去」是**逐字节相同**的。

**无法保真的三种情况**（会被规整成默认风格：1 空格缩进、键序排序）：
① 用 Tab 缩进的文件；② 非 ASCII 字符在文件里是 `\uXXXX` 转义的（Python
`json.dump` 默认 `ensure_ascii=True` 的产物）；③ 文件末尾有两个以上空行。
遇到这三种，先告诉用户该文件会被重新排版，再动手。

## cell id 的稳定性

- **已经写在磁盘上的 id 永远稳定**（`notebook_create` 新建的、以及任何一次写操作
  保留下来的 id 都属于此类）。
- 老 notebook（nbformat < 4.5，或手工拼的 JSON）里没有 id 的单元格，会按内容
  **推导**出一个确定性 id（形如 `sn` + 6 位小写 base36，例：`snfb4flq`）。它**每次
  加载都一样**，跨调用、跨进程稳定，可以直接拿去做 `cell_id`——不必先写一次来「固化」。
- 但推导 id 绑定的是「位置 + 源码」，所以：改掉某格的源码、或在它前面插入/删除
  单元格，都会让它的推导 id 变化。**连续多次编辑时，每次改完重新 `list` 一次取新
  id**，不要沿用上一轮拿到的。
- 只有 nbformat ≥ 4.5 的文件才会把 id 真的写进磁盘；补 id **不会**抬高
  `nbformat_minor`，也不会改动 `nbformat`。

## 返回值形态

- 只读工具（`notebook_read` / `notebook_list_cells` / `notebook_search` /
  `notebook_validate`）返回 **JSON 文本**，可直接解析取 `cells[].id`、
  `source_sha256`、`file_sha256`、`mtime_ms`。
- 写工具（`notebook_create` / `edit_cell` / `insert_cell` / `delete_cell` /
  `clear_outputs`）返回**人类可读的一句话**（含新 id、下标、字符数变化），
  不要按 JSON 解析。

## 改动之后

- **编辑代码单元格会自动清空它的输出**（`outputs = []`、
  `execution_count = null`）——必须在回复里告诉用户。
- 插入单元格后，把**新的 cell id** 告诉用户。
- 用户要「干净版 notebook」时，调用 `notebook_clear_outputs` 且不传
  `cell_id`，一次性清空全部输出。
- **做过排版类重构后，用 `notebook_list_cells` 复核一遍 `cell_type`**（首格与
  每个 `## N.` 格必须是 `markdown`）。`notebook_validate` 只校验结构，**发现不
  了「markdown 内容落在 code 格里」**这种错——它能过 validate，却让 `Run All`
  在第一格就报 SyntaxError。
- 用户反馈「notebook 不能正常执行」时，先按上一条查 `cell_type`，再看是不是
  卡在 `input()`：`input()` 所在单元格如果比屏幕还高且顶部可见，JupyterLab
  原生不会帮你把输入框滚进视野。
- **写操作会先做一次深层结构校验**：cell id 重复或不合规
  （正则 `^[A-Za-z0-9_-]{1,64}$`）、`metadata` 存在但不是对象、code 格的
  `outputs` 存在但不是数组、`source` 数组里混进非字符串——任一条都会**直接拒写**
  （抛 `INVALID_NOTEBOOK`，文件保持原样）。遇到这种报错先修结构，别反复重试。
- 在声称「已改好且有效」之前跑一次 `notebook_validate`。

## 不要做

- 不要用 `read` / `write` / `edit` 去动 `.ipynb`。
- 不要试图执行单元格——本工具集不执行内核代码；需要运行就建议用户在
  JupyterLab 里自己跑。
- 不要跨多次工具调用沿用下标定位单元格——要么重新 list，要么只用 id。
- 不要在没用过工具的情况下凭记忆猜 cell id 或单元格数量。
- 不要臆造 `file_sha256` / `source_sha256` / `mtime_ms`：这三个值只能从只读工具的
  返回里取，猜出来的会让写操作必然报 `STALE_NOTEBOOK`。
- 不要对 `.ipynb` 用 `notebook_validate` 以外的「结构校验」手段；本工具集
  不校验内核可执行性，只校验 notebook 结构。
