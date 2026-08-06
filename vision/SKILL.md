---
name: vision
description: Send images to a vision model for text description when the base LLM cannot see images natively. Use when the user shares an image (local path or network URL), "Saved attachments:" appears, or the user asks to analyze/describe/recognize image content (识图, 看图, 描述图片, 识别图片, 分析截图, 图片内容, screenshot analysis). Supports model switching on the fly: "换增强视觉模型" / "换 plus" → qwen3-vl-plus, "换回 flash" → qwen3-vl-flash.
---

# 识图能力

底层模型不具备原生识图能力时，遇到图片**不要用 Read 工具**，改用本 skill 目录下的 `vision.js`：

```
node "scripts/vision.js" "<图片路径>" "用中文描述这张图片"
```

每个 agent 调用 skill 时工作目录即为 skill 根目录，所以 `scripts/vision.js` 相对路径即可。

## 触发场景

- 用户分享图片路径（本地或网络 URL）
- 消息中出现 "Saved attachments:" 并列出图片
- 用户要求分析、描述、识别图片内容

## 多图

用户一次发多张图片时，**必须逐张处理全部图片**，拿到所有描述后再回复：

```
node "scripts/vision.js" "图片1路径" "图片2路径" "用中文描述每张图片"
```

拿到全部描述后再组织回复，不得只处理第一张。

## 网络图片

用户发来的是图片 URL 时，直接传即可（自动识别，也可用 `--url` 显式指定）：

```
node "scripts/vision.js" "https://example.com/a.png" "用中文描述这张图片"
```

## 切换模型

用户说"换增强视觉模型"或"换 plus"时：把视觉模型改为 `qwen3-vl-plus`。
用户说"换回 flash"时：改回 `qwen3-vl-flash`。
用户指定其他模型名时，按其要求填写。

改哪里：先看 `scripts/vision.js` 同目录（即 skill 根目录）有没有 `.env` 文件——有就改 `.env` 里的 `VISION_MODEL`（环境变量优先级高于代码），没有 `.env` 才改 `scripts/vision.js` 顶部模型配置区的 `MODEL`。

## 配置

第一次使用前，把 API Key 写入 skill 根目录的 `.env`（参考 skill 根目录的 `.env.example`）：

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
