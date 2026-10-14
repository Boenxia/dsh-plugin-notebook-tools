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
  updatedAt: 2026-10-14T11:28:14.000Z
  version: 3
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

> 这是本项目的默认风格。用户明确要求别的排版（英文标题、不编号、或把所有说明
> 写成代码注释）时，以用户的要求为准。

## 工作流

1. **新建一律用 `notebook_create`**，不要手写 notebook JSON。
2. **先列或先搜**：要总览用 `notebook_list_cells`；已知目标文本用
   `notebook_search`。两者都会返回**稳定的 cell id**。
3. **按需精确读**：需要正文时才用 `notebook_read`，配合 `cell_ids`、
   `cell_range`，只在必要时加 `include_outputs`。
4. **用 `cell_id` 定位，不要用下标**：任何插入/删除都会让下标漂移，
   cell id 则跨操作稳定（稳定性边界见下）。
5. **能用就带上陈旧校验**：改动前把最近一次结果里的小票传进去，避免覆盖别人
   期间的修改——但**只有这两个来源有效**，别臆造：
   - `expected_source_sha256` ← 只有 **`notebook_read`** 返回 `source_sha256`；
     `notebook_list_cells` / `notebook_search` **不返回**它。
   - `expected_file_mtime_ms` ← **`notebook_read`** 或 **`notebook_list_cells`**
     返回的 `mtime_ms`；`notebook_search` / `notebook_validate` **不返回**。
6. **改，而不是重写**：改内容用 `notebook_edit_cell`，加单元格用
   `notebook_insert_cell`，改完用 `notebook_validate` 收尾。

## cell id 的稳定性边界（重要）

只有**已经写在磁盘上**的 id 才稳定。老 notebook（nbformat < 4.5 或手工拼的
JSON）里没有 id 的单元格，会在**每次加载时临时补一个新的随机 id**，只有等到
下一次「写」操作才会落盘。所以：

- 刚 `list` / `read` 拿到 id 后，如果**中间没发生过任何写操作**，不要拿这个
  id 去跨调用定位——下次加载它会换一个。
- 稳妥顺序是：先做一次写操作（或直接 `notebook_create`）把 id 固化，再按 id
  定位。
- `notebook_create` 新建的、以及任何一次写操作保留下来的 id 都是稳定的。

## 返回值形态

- 只读工具（`notebook_read` / `notebook_list_cells` / `notebook_search` /
  `notebook_validate`）返回 **JSON 文本**，可直接解析取 `cells[].id`、
  `source_sha256`、`mtime_ms`。
- 写工具（`notebook_create` / `edit_cell` / `insert_cell` / `delete_cell` /
  `clear_outputs`）返回**人类可读的一句话**（含新 id、下标、字符数变化），
  不要按 JSON 解析。

## 改动之后

- **编辑代码单元格会自动清空它的输出**（`outputs = []`、
  `execution_count = null`）——必须在回复里告诉用户。
- 插入单元格后，把**新的 cell id** 告诉用户。
- 用户要「干净版 notebook」时，调用 `notebook_clear_outputs` 且不传
  `cell_id`，一次性清空全部输出。
- 在声称「已改好且有效」之前跑一次 `notebook_validate`。

## 不要做

- 不要用 `read` / `write` / `edit` 去动 `.ipynb`。
- 不要试图执行单元格——本工具集不执行内核代码；需要运行就建议用户在
  JupyterLab 里自己跑。
- 不要跨多次工具调用沿用下标定位单元格——要么重新 list，要么只用 id。
- 不要在没用过工具的情况下凭记忆猜 cell id 或单元格数量。
- 不要对 `.ipynb` 用 `notebook_validate` 以外的「结构校验」手段；本工具集
  不校验内核可执行性，只校验 notebook 结构。
