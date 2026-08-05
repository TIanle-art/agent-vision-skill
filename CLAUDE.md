# 识图能力

你的底层模型不具备原生识图能力。遇到图片时，**不要用 Read 工具**，改用 vision.js：

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

用户发来的是图片 URL 时，用 `--url` 参数：

```
node vision.js --url "https://example.com/a.png" "用中文描述这张图片"
```

## 切换模型

用户说"换增强视觉模型"或"换 plus"时：把视觉模型改为 `qwen3-vl-plus`。
用户说"换回 flash"时：改回 `qwen3-vl-flash`。
用户指定其他模型名时，按其要求填写。

改哪里：先看同目录有没有 `.env` 文件——有就改 `.env` 里的 `VISION_MODEL`（环境变量优先级高于代码），没有 `.env` 才改 `vision.js` 顶部模型配置区的 `MODEL`。

## 配置好之后

用户直接发图片，自动识图，无需手动打命令。

> 本项目另有标准 Agent Skill 形态：`skill/SKILL.md` + `skill/vision.js`（Claude Code / opencode / Cline / Cursor 等支持 SKILL.md 的 agent 可直接安装，无需本文件）。本文件是"拷贝进项目"形态，两者规则内容保持一致。
