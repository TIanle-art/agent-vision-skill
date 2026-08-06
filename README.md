# Agent Vision Skill

![test](https://github.com/TIanle-art/agent-vision-skill/actions/workflows/test.yml/badge.svg)

让没有识图能力的模型获得识图能力——把图片发给有 vision 的模型，用文字描述回来。

DeepSeek V4、GLM 等纯文本大模型无法直接理解图片内容，收到图片只能看到路径或文件名。装上本工具后，图片会自动转成文字描述喂给模型，它们也能"看图"。

适用于 Claude Code、Codex、opencode、Cline、Cyberboss 等任何能执行 node 脚本的 AI 编程助手/智能体，不绑定特定产品。

> 本仓库基于 [asuojun/claude-vision-skill](https://github.com/asuojun/claude-vision-skill) 修改，感谢原作者。

---

## 如果你是 AI（Claude Code / Codex / opencode / 其他助手），请读这里

用户把这个链接发给你，是想让你帮他配置识图。先确认信息，再按场景执行。

### 先确认

1. **先问用户走哪条路线**：
   - **默认路线（推荐）**：阿里云百炼平台 + 千问视觉模型。向用户讲明：新用户有免费 token 额度；模型二选一（`qwen3-vl-flash` 便宜 / `qwen3-vl-plus` 更强）；Key 只需注册百炼即可获得
   - **自有路线**：用户已有自己的平台和 Key（任何 OpenAI 兼容格式均可）
2. **默认路线**：
   - 问 API Key：没有就引导去 https://bailian.console.aliyun.com/ 注册申请（新用户有免费额度），拿到 Key 才继续
   - 让用户模型二选一：`qwen3-vl-flash`（推荐默认，便宜）/ `qwen3-vl-plus`（更强，稍贵）
3. **自有路线**：直接问全三项——**API Base URL、API Key、模型名**，按用户给的配置写入，不推荐任何默认值

用户没给 Key 就不动手。

### 场景 A：用户要在普通 AI 编程助手项目里用

1. 把这个仓库里的 `vision.js` 下载到项目根目录
2. 打开 `vision.js` 顶部「模型配置」区：
   - `API_KEY` 填成用户的 Key（替换 `sk-xxx`）
   - `MODEL` 填成用户选的模型名
   - 用户选了非百炼平台时，`BASE_URL` 同步填成用户给的服务地址
   - **或者（推荐）**：复制 `.env.example` 为 `.env`，把 Key 和模型写在 `.env` 里，见下方「用 .env 存 Key」小节
3. 把 `CLAUDE.md` 的内容合并到项目的说明文件（Claude Code 用 `CLAUDE.md`，Cline 用 `.clinerules`，其他助手按其约定；没有就新建）
4. 验证配置：运行 `node vision.js --help`，能看到用法输出即脚本可用
5. 告诉用户：配置完成，以后直接发图片就行，AI 会自动识图。**想切换模型随时说一声**——"换增强视觉模型"或"换 plus"就是更强的 `qwen3-vl-plus`，"换回 flash"回到默认。（AI 会优先改 `.env` 里的 `VISION_MODEL`，没有 `.env` 才改 `vision.js` 顶部）

### 场景 B：用户只想了解这是什么

简要解释：
- `vision.js` 是核心，读取图片 → base64 → 发给千问视觉模型 API → 返回文字描述
- 默认模型 `qwen3-vl-flash`（便宜）；想增强可切换 `qwen3-vl-plus`
- 配置好之后，用户直接发图片，AI 自动处理，无需手动打命令

---

## 如果你是人类，请读这里

### 这是什么

一个让 DeepSeek、GLM 等无 vision 能力的模型也能"看图"的脚本。配置好之后，直接发图片 AI 就会自动识别。

### 推荐识图服务

| 服务 | 模型 | 备注 |
|------|------|------|
| **阿里云百炼（推荐）** | `qwen3-vl-flash`（默认） | 便宜，识图够用 |
| 阿里云百炼 | `qwen3-vl-plus` | 更强，稍贵 |
| 其他 | 任何 OpenAI 兼容格式 | 改 `BASE_URL` 和模型名即可 |

> 注：百炼新用户赠送免费 token 额度，上述模型均适用。成本按 token 计费，`qwen3-vl-flash` 单次识图通常几分钱，免费额度足够日常使用很久（具体以百炼定价页为准）。模型以百炼控制台实际列表为准：如需更强效果，可换官方新系列 `qwen3.7-plus` / `qwen3.8-max`（均支持识图）；旧系列若下线，同样把模型名换成控制台现有的视觉模型即可。
>
> 限制：`gif` 动图不支持；图片分辨率建议在 8K（最长边 7680px）以内，4K 以上仅支持 jpg/jpeg/png；单图默认上限 7MB，超限时脚本会直接提示压缩命令。

### 自动配置

**方式一（推荐）**：先把仓库 clone 到本地，然后告诉 AI 助手本地路径：

```
git clone https://github.com/TIanle-art/agent-vision-skill.git
```

然后在 AI 助手里说：

> 读一下 agent-vision-skill/README.md，帮我配置识图

**方式二**：直接发 GitHub 链接（DeepSeek 等第三方模型可能无法访问 GitHub）：

> 按 https://github.com/TIanle-art/agent-vision-skill 的 README 帮我配置识图

AI 会问你 API Key、要哪个模型，然后自动配好。

### 作为 Skill 安装（各 agent 通用）

`vision/` 目录是标准 Agent Skill（Anthropic agent skills 规范）：`SKILL.md` + `scripts/vision.js`，Claude Code、opencode、Cline、Cursor 等支持 SKILL.md 的 agent 直接安装即可，装好后 AI 收到图片会自动识图，无需再拷 CLAUDE.md：

```
git clone https://github.com/TIanle-art/agent-vision-skill.git
```

| agent | 安装命令 |
|-------|---------|
| Claude Code | `mkdir -p ~/.claude/skills/vision && cp -r agent-vision-skill/vision/* ~/.claude/skills/vision/` |
| opencode | `mkdir -p ~/.config/opencode/skills/vision && cp -r agent-vision-skill/vision/* ~/.config/opencode/skills/vision/` |
| Cline | 兼容 Claude Code 路径（`~/.claude/skills/vision/`），或按你的 Cline 版本约定放置 |
| 其他支持 SKILL.md 的 agent | 按其 skills 目录约定放置 `vision/` 内容 |

装完把 API Key 写进 skill 目录的 `.env`（复制 `.env.example`），之后直接发图片即可。**切换模型随时说一声**——"换增强视觉模型/换 plus"→ `qwen3-vl-plus`，"换回 flash"→ `qwen3-vl-flash`。

不支持 SKILL.md 的 agent（如 Codex、Windsurf）：改用上文"场景 A / 手动配置"的粘贴模式，把规则合入其约定的规则文件（Codex 用 `AGENTS.md`，其他助手按其约定）。

### 手动配置

1. 把 `vision.js` 拷到项目里（需要 Node.js ≥ 18，脚本零依赖，无需 npm install）
2. 打开 `vision.js` 顶部「模型配置」区，填 API Key（替换 `sk-xxx`），确认模型名（默认 `qwen3-vl-flash`，想增强就填 `qwen3-vl-plus`；用非千问服务还需改 API 地址）
3. 把 `CLAUDE.md` 放到项目根目录

### 用 .env 存 Key（推荐）

不想改代码？把配置写进同目录 `.env` 文件，`vision.js` 启动时自动读取：

1. 复制 `.env.example` 为 `.env`（或手动新建）
2. 在 `.env` 里填：

```
DASHSCOPE_API_KEY=sk-xxx
VISION_MODEL=qwen3-vl-flash
```

`.env` 已被 `.gitignore` 忽略，不会误传 GitHub。配置优先级：**终端环境变量 > `.env` 文件 > `vision.js` 顶部代码默认值**。

### 如何换更强的模型

跟 AI 说一句"换增强视觉模型"或"换 plus"即可（AI 会自动改配置：优先改 `.env` 里的 `VISION_MODEL`，没有 `.env` 才改 `vision.js` 顶部）。也可以手动改 `vision.js` 顶部一行：

| 想要的效果 | MODEL 填 | 备注 |
|------|------|------|
| 默认（便宜） | `qwen3-vl-flash` | 识图够用 |
| 质量更好 | `qwen3-vl-plus` | 同系列增强 |
| 更强 | `qwen3.7-plus` | 官方新系列，支持识图 |
| 最强 | `qwen3.8-max` | 旗舰模型 |

### 文件说明

| 文件 | 用途 |
|------|------|
| `vision.js` | 核心脚本，OpenAI 兼容格式（与 `vision/scripts/vision.js` 同步） |
| `CLAUDE.md` | 识图规则说明，让 AI 知道何时调用 vision.js（其他助手可转为 `.clinerules` 等格式） |
| `vision/SKILL.md` + `vision/scripts/vision.js` | 标准 Agent Skill 形态，各支持 SKILL.md 的 agent 直接安装 |
| `.env.example` | 环境变量示例，复制为 `.env` 填 Key 即可 |
| `test/` | 单元测试，`npm test` 运行 |

---

## 安全说明

- **把 Key 放在 `.env` 文件里**（已被 `.gitignore` 忽略，不会提交进仓库），不要直接写进 `vision.js`。
- **切勿**把填了真实 Key 的 `vision.js` 提交到 GitHub 或任何公开仓库。
- 如果误提交，请立即到百炼控制台**吊销并重新生成**该 Key，而不是只删掉提交记录。
- `vision.js` 不收集、不上传任何额外数据；网络图片通过 URL 直接传给服务商，请注意图片本身的隐私（截图、证件照、聊天记录等慎用第三方模型）。
