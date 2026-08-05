#!/usr/bin/env node
/**
 * 独立识图脚本 — 调用千问视觉模型，按量付费。
 *
 * 用法:
 *   node vision.js <图片路径> [问题]
 *   node vision.js a.jpg b.jpg [问题]      # 多图逐张识别
 *   node vision.js --url <图片链接> [问题]  # 网络图片
 *   node vision.js <图片链接> [问题]       # 网络图片（URL 自动识别）
 *   node vision.js --help
 *
 * 配置: 推荐复制同目录 .env.example 为 .env 并填入 Key（.env 已被 gitignore，不会误提交）；
 *       也可改下方"模型配置"区直接填（改代码有误提交 Key 的风险，不推荐）。
 * 注意: 本文件与 skill/vision.js 保持同步，改动请同时更新两份。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// 读取同目录 .env（Key 放这里更安全，不会误传 GitHub）
function loadDotEnv(filePath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).replace(/\s+#.*$/, "").trim();
    if (value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
         (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

// ==================== 模型配置 ====================
// 推荐优先用 .env（复制 .env.example 为 .env，.env 已被 gitignore 不会误提交）；
// 没有 .env 时，下面的代码默认值才生效。
// 当前默认：qwen3-vl-flash（便宜，够用）
// 想增强识图质量？把下面改成 qwen3-vl-plus（更强，稍贵）
// 或直接对 AI 说："换增强视觉模型" / "换 plus"；说"换回 flash"恢复默认。
// 注意：若同目录 .env 里设置了 VISION_MODEL，它的优先级高于这里，改这里不生效。
// --------------------------------------------------
const API_KEY = process.env.DASHSCOPE_API_KEY || "sk-xxx";   // ← 填你的 API Key
const MODEL   = process.env.VISION_MODEL || "qwen3-vl-flash";
const BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1")
  .replace(/\/chat\/completions\/?$/, "");   // 兼容用户填完整 endpoint 的情况
const MAX_TOKENS  = Number(process.env.VISION_MAX_TOKENS) || 1024;
const MAX_IMAGE_MB = Number(process.env.VISION_MAX_IMAGE_MB) || 7;
const MAX_IMAGES = Number(process.env.VISION_MAX_IMAGES) || 20;
const CONCURRENCY = Number(process.env.VISION_CONCURRENCY) || 3;
const TIMEOUT_MS = 60000;
const MAX_RETRIES = Number(process.env.VISION_MAX_RETRIES) || 2;
const RETRY_BASE_DELAY_MS = 600;
// 服务端建议：最长边不超过 8K(7680px)；4K(3840px) 以上仅支持 jpg/jpeg/png
const MAX_IMAGE_PX = Number(process.env.VISION_MAX_IMAGE_PX) || 7680;
const PX_4K = 3840;

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic"];
const MIME_MAP = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp", tif: "tiff", tiff: "tiff", heic: "heic" };
const DEFAULT_PROMPT = "请详细描述这张图片的内容。";

const HELP = `用法:
  node vision.js <图片路径> [问题]
  node vision.js a.jpg b.jpg [问题]      # 多图逐张识别
  node vision.js <图片链接> [问题]       # 网络图片（URL 自动识别，可多个）
  node vision.js --url <图片链接> [问题] # 网络图片（显式指定，可重复）
  node vision.js --help

参数:
  <路径>       本地图片（jpg/jpeg/png/bmp/webp/tiff/heic；gif 动图不支持），可多个
  <链接>       网络图片 URL（含 :// 自动识别，可多个；也可用 --url 显式指定）
  [问题]       要问的问题，多个词自动拼接（默认: ${DEFAULT_PROMPT}）
  --url <链接> 网络图片链接，可重复使用
  -p, --prompt <文字>  指定问题（可多次，与普通词一起按出现顺序拼接）
  --json       以 JSON 数组输出结果（每张图一个对象: {ok,label,text|error}，供程序解析）
  -h, --help   显示本帮助

环境变量（可选，一般不填）:
  DASHSCOPE_API_KEY      API Key（默认读上方配置区）
  VISION_MODEL           模型名（默认 qwen3-vl-flash）
  DASHSCOPE_BASE_URL     服务地址（默认阿里云百炼；填了 /chat/completions 后缀会自动去掉）
  VISION_MAX_TOKENS      最大输出 token（默认 1024）
  VISION_MAX_IMAGE_MB    单图大小上限 MB（默认 7）
  VISION_MAX_IMAGE_PX    单图最长边上限 px（默认 7680，服务端建议 8K 以内）
  VISION_CONCURRENCY     多图并发数（默认 3）
  VISION_MAX_IMAGES      单次最多图片数（默认 20）
  VISION_MAX_RETRIES     失败自动重试次数（默认 2；429/5xx/超时会重试）

限制说明（以服务端为准，本地提前拦截并提示压缩）:
  gif 动图不支持；分辨率 4K(3840px) 以上仅支持 jpg/jpeg/png；
  最长边超过 8K(7680px) 会建议压缩（如 sips -Z 7680 <图片> --out <新文件>）

模型切换:
  默认 qwen3-vl-flash（便宜）; 想增强识图改为 qwen3-vl-plus
  （编辑脚本顶部"模型配置"区，或直接对 AI 说"换增强视觉模型"）

示例:
  node vision.js shot.png "截图里有什么报错"
  node vision.js a.jpg b.jpg "对比这两张图"
  node vision.js https://example.com/a.png "描述这张图片"
  node vision.js --url https://example.com/a.png "描述这张图片"`;

function isImagePath(p) {
  const ext = path.extname(p).toLowerCase().replace(".", "");
  return IMAGE_EXTS.includes(ext);
}

function parseArgs(argv) {
  const images = [];
  const urls = [];
  let prompt = "";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--json") {
      json = true;
    } else if (a === "--url") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error("--url 后面需要跟图片链接");
      if (!v.includes("://")) throw new Error(`--url 需要完整的网络图片链接（含 http:// 或 https://）: ${v}`);
      urls.push(v);
    } else if (a === "--prompt" || a === "-p") {
      const v = argv[++i];
      if (!v) throw new Error("--prompt 后面需要跟问题文字");
      prompt = prompt ? `${prompt} ${v}` : v;
    } else if (a.startsWith("--")) {
      throw new Error(`未知参数: ${a}（用 --help 查看用法）`);
    } else if (a.includes("://")) {
      urls.push(a);
    } else if (isImagePath(a)) {
      images.push(a);
    } else {
      prompt = prompt ? prompt + " " + a : a;
    }
  }
  if (!prompt) prompt = DEFAULT_PROMPT;
  return { images, urls, prompt, json };
}

function exceedsImageLimit(parsed, max = MAX_IMAGES) {
  return parsed.images.length + parsed.urls.length > max;
}

// 本地解析图片尺寸（PNG/JPEG/GIF/BMP），解析失败返回 null（放行，交给服务端兜底）
function readImageDimensions(filePath) {
  try {
    const b = Buffer.alloc(32);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, b, 0, 32, 0);
    fs.closeSync(fd);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { // PNG
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: 扫描 SOF 段拿尺寸
      let offset = 2;
      while (offset + 9 <= b.length) {
        if (b[offset] !== 0xff) { offset++; continue; }
        const marker = b[offset + 1];
        const len = b.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
      return null;
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) { // GIF
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (b[0] === 0x42 && b[1] === 0x4d) { // BMP
      return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
    }
  } catch {}
  return null;
}

function resolveLocalImage(source) {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  if (!IMAGE_EXTS.includes(ext)) {
    throw new Error(`不支持的图片格式: ${ext}（支持 jpg/jpeg/png/bmp/webp/tiff/heic）`);
  }
  if (ext === "gif") {
    throw new Error(
      "不支持 GIF 动图（服务端不支持该格式），请先转换为 jpg/png 再试\n" +
      `（macOS: sips -s format jpeg ${resolved} --out ${resolved}.jpg；Windows: 用画图/图片工具转存为 jpg）`
    );
  }
  const size = fs.statSync(resolved).size;
  const limit = MAX_IMAGE_MB * 1024 * 1024;
  if (size > limit) {
    const out = resolved.replace(/(\.[^.]+)$/, "_small$1");
    throw new Error(
      `图片过大: ${(size / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_IMAGE_MB}MB\n` +
      `（base64 编码会使体积膨胀约 33%；服务端 Base64 上限 Qwen3-VL 系列 20MB/其他 10MB，默认 7MB 为保守值）\n` +
      `请先压缩再试（macOS: sips -Z 2000 ${resolved} --out ${out}；Windows: 用画图/任意图片工具缩放后另存）`
    );
  }
  const dim = readImageDimensions(resolved);
  if (dim) {
    const longEdge = Math.max(dim.width, dim.height);
    if (longEdge > MAX_IMAGE_PX) {
      const out = resolved.replace(/(\.[^.]+)$/, "_small$1");
      throw new Error(
        `图片分辨率过大: ${dim.width}x${dim.height}，超过建议上限（最长边 ${MAX_IMAGE_PX}px）\n` +
        `（超大分辨率不提升识别精度，反而易致调用超时）\n` +
        `请先压缩再试（macOS: sips -Z ${MAX_IMAGE_PX} ${resolved} --out ${out}；Windows: 用画图/任意图片工具缩放后另存）`
      );
    }
    if (longEdge > PX_4K && !["jpg", "jpeg", "png"].includes(ext)) {
      const out = resolved.replace(/(\.[^.]+)$/, "_small.jpg");
      throw new Error(
        `图片分辨率 ${dim.width}x${dim.height}（4K 以上）服务端仅支持 jpg/jpeg/png，当前为 ${ext}\n` +
        `请先转换格式（macOS: sips -s format jpeg ${resolved} --out ${out}；Windows: 用图片工具转存为 jpg）`
      );
    }
  }
  const data = fs.readFileSync(resolved);
  return `data:image/${MIME_MAP[ext]};base64,${data.toString("base64")}`;
}

// 网络图片预检（最佳努力）：HEAD 取 Content-Length/Content-Type 检查；失败/无信息则放行，交给 API 兜底
function checkRemoteSize(urlStr, maxBytes = MAX_IMAGE_MB * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const probe = (target) => {
      if (hops++ > 5) return resolve();
      let u;
      try { u = new URL(target); } catch { return resolve(); }
      if (!["http:", "https:"].includes(u.protocol)) {
        return reject(new Error(`不支持的图片链接协议: ${u.protocol}（仅支持 http/https）`));
      }
      const transport = u.protocol === "https:" ? https : http;
      const req = transport.request(u, {
        method: "HEAD",
        headers: { "User-Agent": "vision.js" },
      }, (res) => {
        res.resume();
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return probe(new URL(res.headers.location, u).href);
        }
        const len = Number(res.headers["content-length"]);
        if (Number.isFinite(len) && len > maxBytes) {
          return reject(new Error(
            `图片过大: ${(len / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_IMAGE_MB}MB，请压缩后重试`
          ));
        }
        const ct = String(res.headers["content-type"] || "").toLowerCase();
        if (ct.includes("gif")) {
          return reject(new Error("不支持 GIF 动图（服务端不支持该格式），请先转换为 jpg/png 再试"));
        }
        resolve();
      });
      req.on("error", () => resolve());
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.end();
    };
    probe(urlStr);
  });
}

function extractApiError(raw) {
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message || parsed?.message;
    if (typeof msg === "string" && msg) return msg;
  } catch {}
  return raw.slice(0, 300);
}

function requestOnce(url, body) {
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
            hint = "：请检查模型名是否正确/已开通，或 BASE_URL 服务地址是否正确（不要带 /chat/completions 后缀）";
          } else if (res.statusCode === 429) {
            hint = "：触发限流或额度不足，稍后自动重试";
          }
          const err = new Error(`API ${res.statusCode}${hint}: ${extractApiError(data)}`);
          if (res.statusCode === 429 || res.statusCode >= 500) {
            err.retryable = true;
            err.retryAfter = res.headers["retry-after"];
          }
          return reject(err);
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage) {
            console.error(
              `[用量] 输入 ${parsed.usage.prompt_tokens ?? "-"} / 输出 ${parsed.usage.completion_tokens ?? "-"} tokens`
            );
          }
          resolve(parsed?.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.on("error", (e) => { e.retryable = true; reject(e); });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时（${TIMEOUT_MS / 1000}s）`)));
    req.write(body);
    req.end();
  });
}

// 429 / 5xx / 网络错误 / 超时自动重试（最多 MAX_RETRIES 次，指数退避；有 Retry-After 则优先使用）
async function request(payload) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify(payload);
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(url, body);
    } catch (e) {
      if (!e.retryable || attempt >= MAX_RETRIES) throw e;
      const ra = Number(e.retryAfter);
      const delay = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 10000)
        : RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.error(`API 调用失败（${e.message.slice(0, 60)}），${(delay / 1000).toFixed(1)}s 后自动重试（${attempt + 1}/${MAX_RETRIES}）`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
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

// 多图并发识别：并发执行、按输入顺序输出；单张失败不中断其他，返回是否有失败
// opts.json 为 true 时，stdout 只输出 JSON 数组（每张图一个对象），供程序解析
async function runWithConcurrency(tasks, limit, prompt, opts = {}) {
  const results = new Array(tasks.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const { label, resolve } = tasks[i];
      try {
        const imageUrl = await resolve();
        results[i] = { ok: true, label, text: await describe(imageUrl, prompt) };
      } catch (e) {
        failed = true;
        results[i] = { ok: false, label, error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (opts.json) {
    console.log(JSON.stringify(results.map(r => r.ok
      ? { ok: true, label: r.label, text: r.text }
      : { ok: false, label: r.label, error: r.error })));
    return failed;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok) {
      if (tasks.length === 1) {
        console.log(r.text);
      } else {
        console.log(`=== 图片 ${i + 1}: ${r.label} ===`);
        console.log(r.text);
        if (i < results.length - 1) console.log("");
      }
    } else {
      console.error(`识图失败 (${r.label}): ${r.error}`);
    }
  }
  return failed;
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
    console.error("请先配置 API Key：在 vision.js 顶部『模型配置』区填入，或在同目录 .env 里写 DASHSCOPE_API_KEY=sk-xxx（推荐，参考 .env.example）。");
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
  if (exceedsImageLimit(parsed)) {
    console.error(`图片数量 ${parsed.images.length + parsed.urls.length} 张超过上限 ${MAX_IMAGES} 张，请分批识别。`);
    process.exit(1);
  }

  const tasks = [
    ...parsed.images.map(src => ({ label: src, resolve: () => resolveLocalImage(src) })),
    ...parsed.urls.map(url => ({
      label: url,
      resolve: async () => { await checkRemoteSize(url); return url; },
    })),
  ];

  (async () => {
    const failed = await runWithConcurrency(tasks, CONCURRENCY, parsed.prompt, { json: parsed.json });
    // 用 exitCode 而非 process.exit()：后者会截断 stdout 管道输出（大 JSON 可能被切掉）
    process.exitCode = failed ? 1 : 0;
  })();
}

if (require.main === module) main();
module.exports = { parseArgs, exceedsImageLimit, isImagePath, readImageDimensions, resolveLocalImage, loadDotEnv, checkRemoteSize, request, runWithConcurrency };
