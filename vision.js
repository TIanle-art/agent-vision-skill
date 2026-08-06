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
 * 配置: 把本文件同目录（或 skill 根目录）的 .env.example 复制为 .env 并填入 Key（.env 已被 gitignore，不会误提交）；
 *       也可改下方"模型配置"区直接填（改代码有误提交 Key 的风险，不推荐）。
 * 注意: 本文件与 vision/scripts/vision.js 为同一代码的双位置分发，必须保持完全一致，改动请同时更新两份。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, execFile: _execFile } = require("child_process");
const https = require("https");
const http = require("http");

// 读取 .env（Key 放这里更安全，不会误传 GitHub）。
// 传入路径时只读该文件；否则读本文件同目录 .env，
// 若本文件位于 scripts/ 目录（skill 形态），额外回退到 skill 根目录 .env。
function loadDotEnv(filePath) {
  const candidates = filePath
    ? [filePath]
    : [
        path.join(__dirname, ".env"),
        path.basename(__dirname) === "scripts" ? path.join(path.dirname(__dirname), ".env") : null,
      ].filter(Boolean);
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
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
    return; // 只加载第一个找到的
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
const AUTO_RESIZE_PX = Number(process.env.VISION_AUTO_RESIZE_PX) || 0;           // 0=不缩放；设为 1500 等值则用 sips 缩放
const BATCH = process.env.VISION_BATCH !== "0" && process.env.VISION_BATCH !== "false"; // 多图合批（默认开）
const CONVERT_PNG = process.env.VISION_CONVERT_PNG === "1" || process.env.VISION_CONVERT_PNG === "true"; // PNG→JPEG 转码省 token（默认关）
const STREAM = process.env.VISION_STREAM !== "0" && process.env.VISION_STREAM !== "false"; // SSE 流式输出（默认开）
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
  VISION_CONCURRENCY     多图并发数（默认 3；合批关闭时生效）
  VISION_MAX_IMAGES      单次最多图片数（默认 20）
  VISION_MAX_RETRIES     失败自动重试次数（默认 2；429/5xx/超时会重试）
  VISION_BATCH           多图合批（默认开 1/true；设 0 或 false 回退逐张并发）
  VISION_AUTO_RESIZE_PX  自动缩放最长边到指定像素（默认 0 不缩放；如 1500，macOS sips 下生效）
  VISION_CONVERT_PNG     PNG 自动转 JPEG 省 token（默认 0；设 1 或 true 启用，macOS sips 下生效）
  VISION_STREAM          SSE 流式输出逐字显示（默认开 1/true；设 0 或 false 关闭）

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
    // 读足够大的 header：PNG/GIF/BMP 尺寸在前 32 字节；JPEG 的 SOF 可能在 EXIF 之后（常见偏移 1-64KB）
    const bufSize = 65536; // 64KB — 覆盖绝大多数 JPEG 的 EXIF 段
    const stat = fs.statSync(filePath);
    const b = Buffer.alloc(Math.min(bufSize, stat.size));
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { // PNG
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: 扫描 SOF 段拿尺寸
      let offset = 2;
      while (offset + 9 <= b.length) {
        if (b[offset] !== 0xff) { offset++; continue; }
        const marker = b[offset + 1];
        if (marker === 0x00) { offset++; continue; } // 转义的 0xFF，跳过
        const len = b.readUInt16BE(offset + 2);
        // JPEG 段长度含自身 2 字节，合法值 ≥ 2；异常值跳过防死循环
        if (len < 2) { offset += 2; continue; }
        if (offset + 2 + len > b.length) return null; // 段超出 buffer，放弃
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

// 同步执行 sips 命令。虽然阻塞事件循环，但 sips 通常在数百 ms 内完成，且 resolveLocalImage
// 作为同步函数链的一部分，改为异步会需要重构整个调用链。对单图/少量图片影响可忽略。
function autoResizeImage(filePath, targetPx = AUTO_RESIZE_PX) {
  if (!targetPx || targetPx <= 0) return filePath;
  const dim = readImageDimensions(filePath);
  if (!dim) return filePath; // 读不到尺寸，跳过缩放
  if (Math.max(dim.width, dim.height) <= targetPx) return filePath; // 已足够小
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const tmpPath = path.join(os.tmpdir(), `vision-resize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  try {
    execSync(`sips -Z ${targetPx} "${filePath}" --out "${tmpPath}"`, { stdio: "pipe", timeout: 15000 });
    return tmpPath;
  } catch (e) {
    // sips 不可用（非 macOS 或格式不支持），静默跳过继续用原图
    if (process.platform === "darwin") {
      console.error(`[提示] 图片缩放失败（${e.message.slice(0, 40)}），将使用原图。`);
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    return filePath;
  }
}

// PNG→JPEG 自动转码（节省大量 vision token），返回临时文件路径；失败或无需转换时返回原路径
function autoConvertPng(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (ext !== "png") return filePath;
  const tmpPath = path.join(os.tmpdir(), `vision-convert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  try {
    execSync(`sips -s format jpeg "${filePath}" --out "${tmpPath}"`, { stdio: "pipe", timeout: 15000 });
    const origSize = fs.statSync(filePath).size;
    const newSize = fs.statSync(tmpPath).size;
    const ratio = ((origSize - newSize) / origSize * 100).toFixed(0);
    if (newSize >= origSize) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return filePath;
    }
    console.error(`[提示] PNG→JPEG 转码: ${(origSize/1024).toFixed(0)}KB → ${(newSize/1024).toFixed(0)}KB (缩减 ${ratio}%)`);
    return tmpPath;
  } catch (e) {
    if (process.platform === "darwin") {
      console.error(`[提示] PNG 转 JPEG 失败（${e.message.slice(0, 40)}），将使用原图。`);
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    return filePath;
  }
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
  // 自动缩放（VISION_AUTO_RESIZE_PX）
  let fileToRead = autoResizeImage(resolved);
  // PNG→JPEG 转码（VISION_CONVERT_PNG）
  if (CONVERT_PNG) {
    fileToRead = autoConvertPng(fileToRead);
  }
  const dim = readImageDimensions(fileToRead);
  if (dim) {
    const longEdge = Math.max(dim.width, dim.height);
    if (longEdge > MAX_IMAGE_PX) {
      const out = fileToRead.replace(/(\.[^.]+)$/, "_small$1");
      throw new Error(
        `图片分辨率过大: ${dim.width}x${dim.height}，超过建议上限（最长边 ${MAX_IMAGE_PX}px）\n` +
        `（超大分辨率不提升识别精度，反而易致调用超时）\n` +
        `请先压缩再试（macOS: sips -Z ${MAX_IMAGE_PX} ${fileToRead} --out ${out}；Windows: 用画图/任意图片工具缩放后另存）`
      );
    }
    if (longEdge > PX_4K && !["jpg", "jpeg", "png"].includes(path.extname(fileToRead).toLowerCase().replace(".", ""))) {
      const out = fileToRead.replace(/(\.[^.]+)$/, "_small.jpg");
      throw new Error(
        `图片分辨率 ${dim.width}x${dim.height}（4K 以上）服务端仅支持 jpg/jpeg/png，当前为 ${ext}\n` +
        `请先转换格式（macOS: sips -s format jpeg ${fileToRead} --out ${out}；Windows: 用图片工具转存为 jpg）`
      );
    }
  }
  const data = fs.readFileSync(fileToRead);
  const resultExt = path.extname(fileToRead).toLowerCase().replace(".", "");
  const mimeExt = resultExt in MIME_MAP ? resultExt : ext; // 使用实际文件的扩展名
  const result = `data:image/${MIME_MAP[mimeExt]};base64,${data.toString("base64")}`;
  // 清理缩放/转码产生的临时文件
  if (fileToRead !== resolved) {
    try { fs.unlinkSync(fileToRead); } catch {}
  }
  return result;
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

// API 错误 hint 映射
function hintForStatus(statusCode) {
  if (statusCode === 401 || statusCode === 403) return "：请检查 API Key 是否正确/是否有效";
  if (statusCode === 404) return "：请检查模型名是否正确/已开通，或 BASE_URL 服务地址是否正确";
  if (statusCode === 429) return "：触发限流或额度不足";
  return "";
}

// 网络错误是否可重试
function isRetryableError(e) {
  const retryableCodes = ["ETIMEDOUT", "ECONNRESET", "EPIPE", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"];
  return retryableCodes.includes(e.code);
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
          const err = new Error(`API ${res.statusCode}${hintForStatus(res.statusCode)}: ${extractApiError(data)}`);
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
    req.on("error", (e) => { e.retryable = isRetryableError(e); reject(e); });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时（${TIMEOUT_MS / 1000}s）`)));
    req.write(body);
    req.end();
  });
}

// SSE 流式请求：逐块返回文字。onChunk(text) 对每个 delta 调用；resolve 时返回全文。
// 流式不重试（中途断掉难以恢复），失败时直接抛错由调用方 fallback 非流式。
function requestStream(payload, onChunk) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify({ ...payload, stream: true });
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
      if (res.statusCode >= 400) {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          reject(new Error(`API ${res.statusCode}${hintForStatus(res.statusCode)}: ${extractApiError(data)}`));
        });
        return;
      }
      let fullText = "";
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 最后一个不完整行保留
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              onChunk(delta);
            }
          } catch {} // 解析失败忽略（非 JSON 行）
        }
      });
      res.on("end", () => resolve(fullText));
      res.on("error", (e) => reject(e));
    });
    req.on("error", (e) => { e.retryable = isRetryableError(e); reject(e); });
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
  const payload = {
    model: MODEL,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: imageUrl } },
      { type: "text", text: prompt },
    ]}],
    stream: false,
    max_tokens: MAX_TOKENS,
  };
  if (STREAM) {
    try {
      return await requestStream(payload, (chunk) => process.stdout.write(chunk));
    } catch (e) {
      console.error(`[提示] 流式失败（${e.message.slice(0, 50)}），回退非流式...`);
      return await request(payload);
    }
  }
  return request(payload);
}

// 图片去重 key：对短 URL 用原值，对长 data URL 取首尾采样防 Map 对大字符串全等比较
function dedupKey(url) {
  if (url.length < 200) return url;
  return url.slice(0, 100) + "..." + url.slice(-20);
}
// 自动去重：相同 data URL 的图片只发一次，prompt 中标注关系
async function describeBatch(imageUrls, prompt) {
  // 去重：相同 URL 只保留第一次出现的位置
  const seen = new Map();       // url → firstIndex
  const uniqueUrls = [];        // 去重后的 URL 列表
  const indexMap = [];          // originalIndex → uniqueIndex
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const key = dedupKey(url);
    if (seen.has(key)) {
      indexMap[i] = seen.get(key);
    } else {
      const idx = uniqueUrls.length;
      seen.set(key, idx);
      uniqueUrls.push(url);
      indexMap[i] = idx;
    }
  }
  // 构建 content
  const content = [];
  for (let i = 0; i < uniqueUrls.length; i++) {
    content.push({ type: "image_url", image_url: { url: uniqueUrls[i] } });
    content.push({ type: "text", text: `图片 ${i + 1}` });
  }
  // 最终 prompt（标注去重信息）
  let finalPrompt = prompt;
  if (uniqueUrls.length < imageUrls.length) {
    finalPrompt = `${prompt}\n\n注意：以下图片中有重复，实际仅发送了 ${uniqueUrls.length} 张图片（去重后）。`;
    for (let i = 0; i < imageUrls.length; i++) {
      if (indexMap[i] !== i) {
        finalPrompt += `\n请求中的第 ${i + 1} 张图片与第 ${seen.get(dedupKey(imageUrls[i])) + 1} 张相同。`;
      }
    }
  }
  content.push({ type: "text", text: `${finalPrompt}\n\n请逐一描述以上每张图片的内容，严格按"图片 N："格式标注。` });
  // 合批时动态调整 max_tokens：每张图 1024 token，上限 4096（仍可用 VISION_MAX_TOKENS 显式覆盖）
  const batchTokens = MAX_TOKENS === 1024 && !process.env.VISION_MAX_TOKENS
    ? Math.min(1024 * uniqueUrls.length, 4096)
    : MAX_TOKENS;
  const payload = {
    model: MODEL,
    messages: [{ role: "user", content }],
    stream: false,
    max_tokens: batchTokens,
  };
  if (STREAM) {
    try {
      return await requestStream(payload, (chunk) => process.stdout.write(chunk));
    } catch (e) {
      console.error(`[提示] 流式失败（${e.message.slice(0, 50)}），回退非流式...`);
      return await request(payload);
    }
  }
  return request(payload);
}

// 多图识别：合批优先（一次请求省往返和 token），单图走 describe，合批关闭/失败时 fallback 并发
// opts.json 为 true 时，stdout 只输出 JSON 数组（每张图一个对象），供程序解析
async function runWithConcurrency(tasks, limit, prompt, opts = {}) {
  // 单图：走原 describe()
  if (tasks.length === 1) {
    const { label, resolve } = tasks[0];
    try {
      const imageUrl = await resolve();
      const text = await describe(imageUrl, prompt);
      // 流式已逐字输出，不再重复打印
      if (STREAM) {
        process.stdout.write("\n"); // 换行收尾
        return false;
      }
      if (opts.json) {
        console.log(JSON.stringify([{ ok: true, label, text }]));
      } else {
        console.log(text);
      }
      return false;
    } catch (e) {
      if (opts.json) {
        console.log(JSON.stringify([{ ok: false, label, error: e.message }]));
      } else {
        console.error(`识图失败 (${label}): ${e.message}`);
      }
      return true;
    }
  }

  // 多图：合批优先
  if (BATCH && tasks.length > 1) {
    console.error(`[提示] 多图合批模式，${tasks.length} 张图片合并为 1 次请求...`);
    // 先 resolve 所有图片 URL
    const urls = [];
    let resolveFailed = false;
    for (const t of tasks) {
      try {
        urls.push(await t.resolve());
      } catch (e) {
        urls.push(null);
        resolveFailed = true;
      }
    }
    // 有一张解析失败则 fallback（但这里我们的 tasks 只有 resolveLocalImage 可能抛错，实际上不能 skip）
    // 统一走：能 resolve 的全部参与合批
    const validUrls = urls.filter(Boolean);
    const validTasks = tasks.filter((_, i) => urls[i] !== null);
    if (validUrls.length === 0) {
      // 全部解析失败
      if (opts.json) {
        console.log(JSON.stringify(tasks.map((t, i) => ({ ok: false, label: t.label, error: urls[i] === null ? "解析失败" : "" }))));
      } else {
        for (let i = 0; i < tasks.length; i++) {
          console.error(`识图失败 (${tasks[i].label}): 图片解析失败`);
        }
      }
      return true;
    }
    try {
      // 流式非 JSON：describeBatch 已实时输出，只需换行收尾；其他情况缓冲后输出
      if (!STREAM || opts.json) {
        const text = await describeBatch(validUrls, prompt);
        if (opts.json) {
          console.log(JSON.stringify(validTasks.map(t => ({ ok: true, label: t.label, text }))));
        } else {
          console.log(text);
        }
      } else {
        await describeBatch(validUrls, prompt);
        console.log(""); // 换行收尾
      }
      if (resolveFailed) {
        for (let i = 0; i < tasks.length; i++) {
          if (urls[i] === null) console.error(`识图失败 (${tasks[i].label}): 图片解析失败`);
        }
      }
      return resolveFailed;
    } catch (e) {
      console.error(`合批请求失败（${e.message.slice(0, 80)}），fallback 到逐张并发...`);
      // fall through to concurrent mode below
    }
  }

  // 逐张并发（合批关闭或失败时的 fallback）
  const results = new Array(tasks.length);
  let next = 0;
  let failed = false;
  let completed = 0;
  const total = tasks.length;
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
      completed++;
      if (!opts.json && total > 1) {
        console.error(`[进度] ${completed}/${total} 张已完成`);
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
module.exports = { parseArgs, exceedsImageLimit, isImagePath, readImageDimensions, resolveLocalImage, loadDotEnv, checkRemoteSize, request, runWithConcurrency, describeBatch, autoResizeImage, hintForStatus, isRetryableError, dedupKey };
