# Cyberboss 识图配置 — 给 AI 助手执行的指令

请你帮我完成以下操作，不要问问题，直接执行：

## 步骤 1：拷贝 vision.js

把当前目录下的 `vision.js` 拷贝到 cyberboss 的 `scripts/vision.js`。
如果 `scripts/` 目录不存在就创建它。

拷贝后打开 `scripts/vision.js`，顶部「模型配置」区：
- `API_KEY` 填成用户的 Key（替换 `sk-xxx`）——如果用户之前没给过，先问
- `MODEL` 确认是用户选的模型（默认 `qwen3-vl-flash`）

## 步骤 2：修改 persona（weixin-instructions.md）

找到 cyberboss 的 persona 文件，通常在 `~/.cyberboss/weixin-instructions.md` 或 `{stateDir}/weixin-instructions.md`。
**如果这两个路径都不存在**，用以下命令搜索：

```
find ~/.cyberboss -name "weixin-instructions.md" 2>/dev/null
```

实在找不到就告诉用户路径，让用户自己确认，不要猜。

在文件最开头（`# 写给未来的自己` 之前）插入以下内容：

```
## 图片识别（必读）

你当前接入的模型不具备识图能力。Read 工具无法读取图片内容。
当系统提示图片路径时，不要用 Read 工具。改用：

node scripts/vision.js "<图片绝对路径>" "请用中文描述这张图片的内容"

对每张图片依次执行（多图时逐张处理，全部拿到描述后再回复）。这是强制规则，不可跳过。

用户说"换增强视觉模型"或"换 plus"时：把 scripts/vision.js 的 MODEL 改为 qwen3-vl-plus；"换回 flash"则改回 qwen3-vl-flash。
```

## 步骤 3：修改 app.js

打开 `src/core/app.js`，找到 `buildInboundText` 函数里这一段：

```
if (runtimeUsesReadForImages(runtimeId)) {
    lines.push("Read every image first with `Read`.");
}
```

替换成：

```
lines.push("If your model has native vision, use `Read` on each image.");
lines.push("If your model does NOT have vision (e.g. DeepSeek), for EVERY image run:");
lines.push('  node scripts/vision.js "<path>" "请用中文描述这张图片的内容"');
lines.push("Say nothing before all images are processed.");
```

**如果找不到这段代码**：先用 grep 搜索代码片段特征：

```
grep -rn "Read every image" src/core/app.js
```

找到后替换对应位置；如果 grep 也找不到（可能是新版本改动了结构），跳过这一步，并告诉用户"app.js 的图片提示代码段未找到，可能此版本无需修改，请手动检查"，不要硬改。

## 步骤 4：验证

跑一下 `node scripts/vision.js` 确保没有语法错误。

## 步骤 5：告知用户

告诉用户：重启 cyberboss 即可生效。以后微信发图片，AI 会自动用 vision.js 识图。
