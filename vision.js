#!/usr/bin/env node
/**
 * 独立识图脚本 — 调用千问视觉模型，按量付费。
 *
 * 用法:
 *   node vision.js <图片路径> [问题]
 *   node vision.js a.jpg b.jpg [问题]      # 多图逐张识别
 *   node vision.js --url <图片链接> [问题]  # 网络图片
 *   node vision.js --help
 *
 * 配置: 见下方"模型配置"区，直接改代码填 Key 即可（无需其他文件）。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ==================== 模型配置 ====================
// 当前默认：qwen3-vl-flash（便宜，够用）
// 想增强识图质量？把下面改成 qwen3-vl-plus（更强，稍贵）
// 或直接对 AI 说："换增强视觉模型" / "换 plus"；说"换回 flash"恢复默认。
// --------------------------------------------------
const API_KEY = process.env.DASHSCOPE_API_KEY || "sk-xxx";   // ← 填你的 API Key
const MODEL   = process.env.VISION_MODEL || "qwen3-vl-flash";
const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MAX_TOKENS  = Number(process.env.VISION_MAX_TOKENS) || 1024;
const MAX_IMAGE_MB = Number(process.env.VISION_MAX_IMAGE_MB) || 7;
const MAX_IMAGES = 20;
const TIMEOUT_MS = 60000;

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const MIME_MAP = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };
const DEFAULT_PROMPT = "请详细描述这张图片的内容。";

const HELP = `用法:
  node vision.js <图片路径> [问题]
  node vision.js a.jpg b.jpg [问题]      # 多图逐张识别
  node vision.js --url <图片链接> [问题]  # 网络图片
  node vision.js --help

参数:
  <路径>       本地图片（jpg/jpeg/png/gif/webp/bmp），可多个
  [问题]       要问的问题，多个词自动拼接（默认: ${DEFAULT_PROMPT}）
  --url <链接> 网络图片链接，可重复使用
  -p, --prompt <文字>  显式指定问题（优先级最高）
  -h, --help   显示本帮助

环境变量（可选，一般不填）:
  DASHSCOPE_API_KEY      API Key（默认读上方配置区）
  VISION_MODEL           模型名（默认 qwen3-vl-flash）
  DASHSCOPE_BASE_URL     服务地址（默认阿里云百炼）
  VISION_MAX_TOKENS      最大输出 token（默认 1024）
  VISION_MAX_IMAGE_MB    单图大小上限 MB（默认 7）

模型切换:
  默认 qwen3-vl-flash（便宜）; 想增强识图改为 qwen3-vl-plus
  （编辑脚本顶部"模型配置"区，或直接对 AI 说"换增强视觉模型"）

示例:
  node vision.js shot.png "截图里有什么报错"
  node vision.js a.jpg b.jpg "对比这两张图"
  node vision.js --url https://example.com/a.png "描述这张图片"`;

function isImagePath(p) {
  const ext = path.extname(p).toLowerCase().replace(".", "");
  return IMAGE_EXTS.includes(ext);
}

function parseArgs(argv) {
  const images = [];
  const urls = [];
  let prompt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--url") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error("--url 后面需要跟图片链接");
      urls.push(v);
    } else if (a === "--prompt" || a === "-p") {
      const v = argv[++i];
      if (!v) throw new Error("--prompt 后面需要跟问题文字");
      prompt = v;
    } else if (a.startsWith("--")) {
      throw new Error(`未知参数: ${a}（用 --help 查看用法）`);
    } else if (isImagePath(a)) {
      images.push(a);
    } else {
      prompt = prompt ? prompt + " " + a : a;
    }
  }
  if (!prompt) prompt = DEFAULT_PROMPT;
  return { images, urls, prompt };
}

function resolveLocalImage(source) {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  if (!IMAGE_EXTS.includes(ext)) {
    throw new Error(`不支持的图片格式: ${ext}（支持 jpg/jpeg/png/gif/webp/bmp）`);
  }
  const size = fs.statSync(resolved).size;
  const limit = MAX_IMAGE_MB * 1024 * 1024;
  if (size > limit) {
    const out = resolved.replace(/(\.[^.]+)$/, "_small$1");
    throw new Error(
      `图片过大: ${(size / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_IMAGE_MB}MB\n` +
      `（base64 编码会使体积膨胀约 33%，API 上限约 10MB）\n` +
      `请先压缩再试，例如: sips -Z 2000 ${resolved} --out ${out}`
    );
  }
  const data = fs.readFileSync(resolved);
  return `data:image/${MIME_MAP[ext]};base64,${data.toString("base64")}`;
}

function request(payload) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          let hint = "";
          if (res.statusCode === 401 || res.statusCode === 403) {
            hint = "：请检查 API Key 是否正确/是否有效";
          } else if (res.statusCode === 404) {
            hint = "：请检查模型名是否正确/是否已开通";
          }
          return reject(new Error(`API ${res.statusCode}${hint}: ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时（${TIMEOUT_MS / 1000}s）`)));
    req.write(body);
    req.end();
  });
}

async function describe(imageUrl, prompt) {
  return request({
    model: MODEL,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: imageUrl } },
      { type: "text", text: prompt },
    ]}],
    stream: false,
    max_tokens: MAX_TOKENS,
  });
}

function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error("参数错误:", e.message);
    process.exit(1);
  }
  if (parsed.help) { console.log(HELP); return; }

  if (!API_KEY || API_KEY.startsWith("sk-xxx")) {
    console.error("请先在 vision.js 顶部『模型配置』区填入你的 API Key。");
    console.error("获取 Key: https://bailian.console.aliyun.com/");
    process.exit(1);
  }
  if (!MODEL || MODEL === "xxx") {
    console.error("模型名未配置或为占位符，请检查 vision.js 顶部的 MODEL 配置。");
    process.exit(1);
  }
  if (parsed.images.length + parsed.urls.length === 0) {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js a.jpg b.jpg [问题]   # 多图");
    console.error("      node vision.js --url <图片链接> [问题]");
    console.error("      node vision.js --help");
    process.exit(1);
  }
  if (parsed.images.length + parsed.urls.length > MAX_IMAGES) {
    console.error(`图片数量 ${parsed.images.length + parsed.urls.length} 张超过上限 ${MAX_IMAGES} 张，请分批识别。`);
    process.exit(1);
  }

  const tasks = [
    ...parsed.images.map(src => ({ label: src, resolve: () => resolveLocalImage(src) })),
    ...parsed.urls.map(url => ({ label: url, resolve: () => url })),
  ];

  (async () => {
    let failed = false;
    for (let i = 0; i < tasks.length; i++) {
      const { label, resolve } = tasks[i];
      let imageUrl;
      try {
        imageUrl = resolve();
      } catch (e) {
        failed = true;
        console.error(`识图失败 (${label}): ${e.message}`);
        continue;
      }
      try {
        const result = await describe(imageUrl, parsed.prompt);
        if (tasks.length === 1) {
          console.log(result);
        } else {
          console.log(`=== 图片 ${i + 1}: ${label} ===`);
          console.log(result);
          if (i < tasks.length - 1) console.log("");
        }
      } catch (e) {
        failed = true;
        console.error(`识图失败 (${label}, model: ${MODEL}): ${e.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
  })();
}

main();
