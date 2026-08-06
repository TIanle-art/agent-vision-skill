# 给配置助手的强制指令（收到本仓库链接/路径的 AI 必读）

用户把本仓库发给你，意图是让你**帮他配置识图能力**（或回答他关于本项目的问题）。

## 第一步永远是提问，不是动手

执行任何安装、下载、写文件的操作之前，必须先向用户提问，顺序如下：

1. **问路线**：默认路线（阿里云百炼 + 千问视觉模型，新用户有免费 token 额度）还是用户已有自己的平台/Key（任何 OpenAI 兼容格式均可）？
2. **问 Key**：用户没有 Key 时，引导去 https://bailian.console.aliyun.com/ 注册申请（新用户有免费额度），**拿到 Key 才继续**。
3. **问模型**：`qwen3-vl-flash`（默认，便宜）/ `qwen3-vl-plus`（更强）/ 用户指定。

**硬性规则：**

- **提问后必须主动要 Key，并给用户两条路，不得甩锅：**
  - 用户有 Key 或愿意去注册：引导去 https://bailian.console.aliyun.com/ 注册申请（新用户有免费额度），拿到 Key 后由你配好并验证；
  - 用户不想给 Key / 想自己配：提供逐步指引——复制 `.env.example` 为 `.env`、填入 `DASHSCOPE_API_KEY`（自有平台还填 `DASHSCOPE_BASE_URL`、`VISION_MODEL`）、运行 `node vision.js --help` 验证。**不得只甩一句"自己配"而不给步骤。**
- **用户没给 Key 之前：不得替用户填 Key、不得编造/猜测 Key；不涉及 Key 的安装（拷贝脚本、放规则文件）可以先做。**
- 用户选择了自有平台时，必须问全三项：API Base URL、API Key、模型名，按用户给的写，不得替用户猜测默认值。

## 拿到信息后

按 README「如果你是 AI」分区的「场景 A」执行（拷贝模式），或引导用户安装 Skill 形态（`vision/` 目录，README 有各 agent 安装命令）。

- Key 一律写进 `.env`（复制 `.env.example`），**禁止把 Key 写进 `vision.js` 代码**。
- 配置完成后运行 `node vision.js --help` 验证可用，再告诉用户"以后直接发图片即可"。

## 本仓库文件角色

| 文件 | 角色 |
|------|------|
| `AGENTS.md` | 本文件：上半是配置助手指令（收到仓库链接/路径时生效），下半是识图规则（拷入用户项目后生效） |
| `vision/SKILL.md` | 识图规则（Skill 形态，装 skill 的 agent 用；正文与本文件识图段一致，CI 校验） |
| `vision.js` | 核心脚本（与 `vision/scripts/vision.js` 同一代码双形态分发，CI 校验完全一致） |
| `README.md` | 详细配置流程与人类说明 |

---

# 识图能力

底层模型不具备原生识图能力。遇到图片时，**不要用 Read 工具**，改用本项目脚本 vision.js：

```
node vision.js "<图片路径>" "用中文描述这张图片"
```

## 触发场景

- 用户分享图片路径（本地或网络 URL）
- 消息中出现 "Saved attachments:" 并列出图片
- 用户要求分析、描述、识别图片内容

## 多图

用户一次发多张图片时，**必须逐张处理全部图片**，拿到所有描述后再回复：

```
node vision.js "图片1路径" "图片2路径" "用中文描述每张图片"
```

拿到全部描述后再组织回复，不得只处理第一张。

## 网络图片

用户发来的是图片 URL 时，直接传即可（自动识别，也可用 `--url` 显式指定）：

```
node vision.js "https://example.com/a.png" "用中文描述这张图片"
```

## 切换模型

用户说"换增强视觉模型"或"换 plus"时：把视觉模型改为 `qwen3-vl-plus`。
用户说"换回 flash"时：改回 `qwen3-vl-flash`。
用户指定其他模型名时，按其要求填写。

改哪里：先看 vision.js 同目录有没有 `.env` 文件——有就改 `.env` 里的 `VISION_MODEL`（环境变量优先级高于代码），没有 `.env` 才改 vision.js 顶部模型配置区的 `MODEL`。（skill 安装形态下 `.env` 放在 skill 根目录，同样优先改它）

## 配置

第一次使用前，把 `.env.example` 复制为 `.env`（放在 vision.js 同目录；skill 安装形态放 skill 根目录）并填入 API Key：

```
DASHSCOPE_API_KEY=sk-xxx
```

没有 Key 时：提示用户去 https://bailian.console.aliyun.com/ 注册申请（新用户有免费额度），拿到 Key 再继续。

## 常见错误

- `文件不存在: <路径>`：图片路径写错，先确认文件真实存在
- `API 401/403`：API Key 错误或失效
- `API 404`：模型名错误或未开通，或 BASE_URL 服务地址错误
- `图片过大`：超过 7MB（macOS 可用 `sips -Z 2000 <图片> --out <新文件>` 压缩，Windows 用画图/图片工具缩放；或改 `.env` 的 `VISION_MAX_IMAGE_MB`）
- `图片分辨率过大`：超过 8K（macOS 可用 `sips -Z 7680 <图片> --out <新文件>` 压缩，Windows 用画图/图片工具缩放）
- `不支持 GIF 动图`：gif 需先转 jpg/png（macOS 可用 `sips -s format jpeg <图片> --out <新文件>.jpg`，Windows 用图片工具转存）
- 失败会自动重试（429/5xx/超时，最多 2 次）

## 粘贴图路径未知时（消息里只有 [Image N]，无文件路径）

部分 agent（如 opencode）粘贴图片时不写临时文件，而是把 base64 存进本地 SQLite 数据库（opencode: `~/.local/share/opencode/opencode.db` 的 `part` 表），消息里只有 `[Image N]` 占位。**不要**按临时目录"最新文件"猜路径（`clipboard_image.png` 之类可能是旧会话残留，会读错图）。直接让脚本自动定位：

```
node vision.js --locate "用中文描述这张图片"
```

`--locate` 会从已知存储位置（当前支持 opencode 数据库）恢复最新图片附件、解码并直接识别；找不到时报错提示手动传路径。

多会话并发怕取错图时，可用环境变量限定会话（当前会话 ID 可通过查询自己的工具调用记录得到：`SELECT DISTINCT session_id FROM part WHERE data LIKE '%<自己的工具名>%' ORDER BY time_created DESC LIMIT 1;`）：

```
VISION_OPENCODE_SESSION=<会话ID> node vision.js --locate "用中文描述这张图片"
```

识别结果明显与用户描述的图不符时，先查数据库而不是再猜路径。

## 配置好之后

用户直接发图片，自动识图，无需手动打命令。

## 本文件是什么

本段是识图规则（正文与 `vision/SKILL.md` 一致，改任一份需同步）。拷贝形态下，把本段随 vision.js 一起拷入用户项目——主流 agent（Claude Code / Codex / opencode / Cursor）直接读 `AGENTS.md` 无需改名；Claude Code 也可用 `CLAUDE.md`，Cline 用 `.clinerules`。
