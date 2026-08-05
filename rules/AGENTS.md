# 识图（vision skill 桥接规则）

本文件供不支持 SKILL.md 的 agent 使用（如 Codex、Windsurf 等）。安装时把下面的 `<VISION_DIR>` 替换为 `vision.js` 实际所在目录。

## 识图（必读）

底层模型不具备原生识图能力时，遇到图片**不要用 Read 工具**，改用：

```
node <VISION_DIR>/vision.js "<图片绝对路径>" "请用中文描述这张图片的内容"
```

- 用户分享图片路径、消息出现 "Saved attachments:"、或要求分析/描述/识别图片时触发
- 多图时逐张处理全部图片，全部拿到描述后再回复
- 网络图片 URL 直接传（自动识别，也可加 `--url`）
- 切换模型：用户说"换增强视觉模型/换 plus"→ `qwen3-vl-plus`；"换回 flash"→ `qwen3-vl-flash`。先改 `vision.js` 同目录 `.env` 的 `VISION_MODEL`，没有 `.env` 才改脚本顶部 `MODEL`
