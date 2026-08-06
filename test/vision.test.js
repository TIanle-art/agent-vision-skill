const { test, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const { parseArgs, exceedsImageLimit, isImagePath, readImageDimensions, resolveLocalImage, loadDotEnv, checkRemoteSize, locateAttachment } = require("../vision.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-"));
}

// MAX_IMAGE_MB 在模块加载时定值，需带新环境变量重新加载模块
function freshRequireWithMaxMB(mb) {
  const prev = process.env.VISION_MAX_IMAGE_MB;
  process.env.VISION_MAX_IMAGE_MB = String(mb);
  delete require.cache[require.resolve("../vision.js")];
  const mod = require("../vision.js");
  if (prev === undefined) delete process.env.VISION_MAX_IMAGE_MB;
  else process.env.VISION_MAX_IMAGE_MB = prev;
  return mod;
}

// ---------- parseArgs ----------

test("parseArgs: 单图 + 问题", () => {
  const r = parseArgs(["a.png", "描述这张图"]);
  assert.deepStrictEqual(r.images, ["a.png"]);
  assert.strictEqual(r.prompt, "描述这张图");
});

test("parseArgs: 多图逐张", () => {
  const r = parseArgs(["a.jpg", "b.png", "对比两张图"]);
  assert.deepStrictEqual(r.images, ["a.jpg", "b.png"]);
  assert.strictEqual(r.prompt, "对比两张图");
});

test("parseArgs: --url 网络图", () => {
  const r = parseArgs(["--url", "https://example.com/a.png", "描述"]);
  assert.deepStrictEqual(r.urls, ["https://example.com/a.png"]);
  assert.strictEqual(r.prompt, "描述");
});

test("parseArgs: --url 可重复", () => {
  const r = parseArgs(["--url", "https://a.com/1.png", "--url", "https://b.com/2.png"]);
  assert.deepStrictEqual(r.urls, ["https://a.com/1.png", "https://b.com/2.png"]);
});

test("parseArgs: 裸 URL 自动识别为网络图", () => {
  const r = parseArgs(["https://example.com/a.png", "描述"]);
  assert.deepStrictEqual(r.urls, ["https://example.com/a.png"]);
  assert.deepStrictEqual(r.images, []);
  assert.strictEqual(r.prompt, "描述");
});

test("parseArgs: -p 显式问题为基，后续词追加", () => {
  const r = parseArgs(["a.png", "-p", "显式问题", "多余词"]);
  assert.strictEqual(r.prompt, "显式问题 多余词");
});

test("parseArgs: 无问题用默认提示", () => {
  const r = parseArgs(["a.png"]);
  assert.match(r.prompt, /详细描述/);
});

test("parseArgs: --help", () => {
  assert.deepStrictEqual(parseArgs(["--help"]), { help: true });
  assert.deepStrictEqual(parseArgs(["-h"]), { help: true });
});

test("parseArgs: 未知参数报错", () => {
  assert.throws(() => parseArgs(["--nope"]), /未知参数/);
});

test("parseArgs: --url 缺链接报错", () => {
  assert.throws(() => parseArgs(["--url"]), /--url 后面需要跟图片链接/);
});

test("parseArgs: --prompt 缺文字报错", () => {
  assert.throws(() => parseArgs(["--prompt"]), /--prompt 后面需要跟问题文字/);
});

test("parseArgs: --json 开关", () => {
  const r = parseArgs(["a.png", "--json"]);
  assert.strictEqual(r.json, true);
  assert.deepStrictEqual(r.images, ["a.png"]);
});

test("parseArgs: --locate 开关", () => {
  const r = parseArgs(["--locate", "描述这张图"]);
  assert.strictEqual(r.locate, true);
  assert.strictEqual(r.prompt, "描述这张图");
});

test("parseArgs: -l 简写", () => {
  const r = parseArgs(["-l"]);
  assert.strictEqual(r.locate, true);
});

test("parseArgs: 默认 locate 为 false", () => {
  assert.strictEqual(parseArgs(["a.png"]).locate, false);
});

test("parseArgs: --json 与 URL 混用", () => {
  const r = parseArgs(["--json", "https://a.com/1.png", "--url", "https://b.com/2.png"]);
  assert.strictEqual(r.json, true);
  assert.deepStrictEqual(r.urls, ["https://a.com/1.png", "https://b.com/2.png"]);
});

test("parseArgs: 默认非 json", () => {
  assert.strictEqual(parseArgs(["a.png"]).json, false);
});

test("parseArgs: --url 后跟 --prompt 报错", () => {
  assert.throws(() => parseArgs(["--url", "--prompt", "x"]), /--url 后面需要跟图片链接/);
});

test("parseArgs: -p 与 --prompt 混合，按顺序拼接", () => {
  const r = parseArgs(["a.png", "-p", "显式", "--prompt", "覆盖"]);
  assert.strictEqual(r.prompt, "显式 覆盖");
});

test("parseArgs: --url 后跟非链接报错", () => {
  assert.throws(() => parseArgs(["--url", "foo.png"]), /需要完整/);
});

test("parseArgs: 裸 URL 与 --url 混用", () => {
  const r = parseArgs(["https://a.com/1.png", "--url", "https://b.com/2.png", "c.png", "问"]);
  assert.deepStrictEqual(r.urls, ["https://a.com/1.png", "https://b.com/2.png"]);
  assert.deepStrictEqual(r.images, ["c.png"]);
  assert.strictEqual(r.prompt, "问");
});

// ---------- exceedsImageLimit ----------

test("exceedsImageLimit: 超过上限", () => {
  assert.strictEqual(exceedsImageLimit({ images: ["a.png", "b.png"], urls: [] }, 1), true);
});

test("exceedsImageLimit: 未超过上限", () => {
  assert.strictEqual(exceedsImageLimit({ images: ["a.png"], urls: ["https://x.com/a.png"] }, 2), false);
});

test("exceedsImageLimit: 默认上限 MAX_IMAGES", () => {
  const many = { images: Array.from({ length: 21 }, (_, i) => `${i}.png`), urls: [] };
  assert.strictEqual(exceedsImageLimit(many), true);
});

// ---------- isImagePath ----------

test("isImagePath: 合法扩展名", () => {
  for (const f of ["a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp", "a.bmp", "a.JPG", "dir/a.PNG"]) {
    assert.strictEqual(isImagePath(f), true, f);
  }
});

test("isImagePath: 非法扩展名", () => {
  for (const f of ["a.txt", "a.pdf", "a.png.exe", "noext", "a."]) {
    assert.strictEqual(isImagePath(f), false, f);
  }
});

// ---------- resolveLocalImage ----------

test("resolveLocalImage: 正常返回 data URL", () => {
  const dir = tempDir();
  const file = path.join(dir, "test.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  const url = resolveLocalImage(file);
  assert.match(url, /^data:image\/png;base64,/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: 文件不存在报错", () => {
  assert.throws(() => resolveLocalImage("/nonexistent/xyz.png"), /文件不存在/);
});

test("resolveLocalImage: 不支持的格式报错", () => {
  const dir = tempDir();
  const file = path.join(dir, "test.txt");
  fs.writeFileSync(file, "hello");
  assert.throws(() => resolveLocalImage(file), /不支持的图片格式/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: 超限报错", () => {
  const vision = freshRequireWithMaxMB(0.001);
  const dir = tempDir();
  const file = path.join(dir, "big.png");
  fs.writeFileSync(file, Buffer.alloc(2048));
  assert.throws(() => vision.resolveLocalImage(file), /图片过大/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: gif 明确报错", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.gif");
  fs.writeFileSync(file, Buffer.from("GIF89a"));
  assert.throws(() => resolveLocalImage(file), /不支持 GIF/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: 分辨率超过 8K 拦截", () => {
  const dir = tempDir();
  const file = path.join(dir, "huge.png");
  const b = Buffer.alloc(32);
  b.writeUInt8(0x89, 0); b.write("PNG\r\n\x1a\n", 1);
  b.writeUInt32BE(9000, 16);
  b.writeUInt32BE(2000, 20);
  fs.writeFileSync(file, b);
  assert.throws(() => resolveLocalImage(file), /分辨率过大/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: 4K-8K 非 jpg/png 拦截，转换命令用 jpg 后缀", () => {
  const dir = tempDir();
  const file = path.join(dir, "wide.bmp");
  const b = Buffer.alloc(32);
  b.write("BM", 0);
  b.writeInt32LE(5000, 18);
  b.writeInt32LE(3000, 22);
  fs.writeFileSync(file, b);
  assert.throws(() => resolveLocalImage(file), (e) => {
    assert.match(e.message, /4K 以上/);
    assert.match(e.message, /sips -s format jpeg .* --out .*\.jpg/);
    return true;
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveLocalImage: 4K-8K 的 PNG 放行", () => {
  const dir = tempDir();
  const file = path.join(dir, "wide.png");
  const b = Buffer.alloc(32);
  b.writeUInt8(0x89, 0); b.write("PNG\r\n\x1a\n", 1);
  b.writeUInt32BE(5000, 16);
  b.writeUInt32BE(3000, 20);
  fs.writeFileSync(file, b);
  const url = resolveLocalImage(file);
  assert.match(url, /^data:image\/png;base64,/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- readImageDimensions ----------

test("readImageDimensions: PNG 尺寸", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.png");
  const b = Buffer.alloc(32);
  b.writeUInt8(0x89, 0); b.write("PNG\r\n\x1a\n", 1);
  b.writeUInt32BE(640, 16);
  b.writeUInt32BE(480, 20);
  fs.writeFileSync(file, b);
  assert.deepStrictEqual(readImageDimensions(file), { width: 640, height: 480 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readImageDimensions: JPEG SOF 尺寸", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.jpg");
  const b = Buffer.alloc(32);
  b.writeUInt8(0xff, 0); b.writeUInt8(0xd8, 1);
  b.writeUInt8(0xff, 2); b.writeUInt8(0xc0, 3);   // SOF0
  b.writeUInt16BE(11, 4);
  b.writeUInt8(8, 6);
  b.writeUInt16BE(300, 7);
  b.writeUInt16BE(400, 9);
  fs.writeFileSync(file, b);
  assert.deepStrictEqual(readImageDimensions(file), { height: 300, width: 400 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readImageDimensions: GIF/BMP 尺寸", () => {
  const dir = tempDir();
  const gif = path.join(dir, "a.gif");
  const gb = Buffer.alloc(16);
  gb.write("GIF89a", 0);
  gb.writeUInt16LE(100, 6);
  gb.writeUInt16LE(50, 8);
  fs.writeFileSync(gif, gb);
  assert.deepStrictEqual(readImageDimensions(gif), { width: 100, height: 50 });
  const bmp = path.join(dir, "a.bmp");
  const bb = Buffer.alloc(32);
  bb.write("BM", 0);
  bb.writeInt32LE(800, 18);
  bb.writeInt32LE(-600, 22);
  fs.writeFileSync(bmp, bb);
  assert.deepStrictEqual(readImageDimensions(bmp), { width: 800, height: 600 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readImageDimensions: 无法解析返回 null", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.bin");
  fs.writeFileSync(file, Buffer.alloc(32));
  assert.strictEqual(readImageDimensions(file), null);
  assert.strictEqual(readImageDimensions("/nonexistent/xyz.png"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- loadDotEnv ----------

test("loadDotEnv: 文件不存在无副作用", () => {
  assert.doesNotThrow(() => loadDotEnv("/nonexistent/.env"));
});

test("loadDotEnv: 基本读取与引号", () => {
  const dir = tempDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "A=1\nB=\"two\"\nC='three'\n");
  loadDotEnv(envFile);
  assert.strictEqual(process.env.A, "1");
  assert.strictEqual(process.env.B, "two");
  assert.strictEqual(process.env.C, "three");
  delete process.env.A; delete process.env.B; delete process.env.C;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadDotEnv: 注释、空行、无等号行跳过", () => {
  const dir = tempDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "# comment\n\nNOEQ\nD=4\n");
  loadDotEnv(envFile);
  assert.strictEqual(process.env.D, "4");
  assert.strictEqual(process.env.NOEQ, undefined);
  delete process.env.D;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadDotEnv: CRLF 与两侧空格", () => {
  const dir = tempDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "E = 5\r\nF=6\r\n");
  loadDotEnv(envFile);
  assert.strictEqual(process.env.E, "5");
  assert.strictEqual(process.env.F, "6");
  delete process.env.E; delete process.env.F;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadDotEnv: 行内注释被忽略，无空格 # 保留", () => {
  const dir = tempDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "MODEL=qwen3-vl-plus # 增强模型\nKEY=sk-abc#keep\n");
  loadDotEnv(envFile);
  assert.strictEqual(process.env.MODEL, "qwen3-vl-plus");
  assert.strictEqual(process.env.KEY, "sk-abc#keep");
  delete process.env.MODEL; delete process.env.KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadDotEnv: 不覆盖已有环境变量", () => {
  process.env.G = "existing";
  const dir = tempDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "G=fromfile\n");
  loadDotEnv(envFile);
  assert.strictEqual(process.env.G, "existing");
  delete process.env.G;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- checkRemoteSize ----------

function startServer(handler) {
  const http = require("node:http");
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test("checkRemoteSize: 超限 URL 拒绝", async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": "2048" });
    res.end();
  });
  try {
    await assert.rejects(
      checkRemoteSize(`http://127.0.0.1:${port}/img.png`, 100),
      /图片过大/
    );
  } finally {
    server.close();
  }
});

test("checkRemoteSize: 跟随重定向后超限拒绝", async () => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/img.png") {
      res.writeHead(302, { Location: `/real.png` });
      res.end();
    } else {
      res.writeHead(200, { "Content-Length": "2048" });
      res.end();
    }
  });
  try {
    await assert.rejects(
      checkRemoteSize(`http://127.0.0.1:${port}/img.png`, 100),
      /图片过大/
    );
  } finally {
    server.close();
  }
});

test("checkRemoteSize: 无 Content-Length 放行（最佳努力）", async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  try {
    await assert.doesNotReject(checkRemoteSize(`http://127.0.0.1:${port}/img.png`, 100));
  } finally {
    server.close();
  }
});

test("checkRemoteSize: 无法访问的 URL 放行（最佳努力）", async () => {
  await assert.doesNotReject(checkRemoteSize("http://nonexistent-host-xyz.invalid/img.png"));
});

test("checkRemoteSize: Content-Type 为 gif 拦截", async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/gif" });
    res.end();
  });
  try {
    await assert.rejects(
      checkRemoteSize(`http://127.0.0.1:${port}/anim.gif`),
      /不支持 GIF/
    );
  } finally {
    server.close();
  }
});

test("checkRemoteSize: 非 http/https 协议拒绝", async () => {
  await assert.rejects(checkRemoteSize("file:///etc/passwd"), /不支持的图片链接协议/);
  await assert.rejects(checkRemoteSize("data:image/png;base64,AAAA"), /不支持的图片链接协议/);
});

// ---------- request（mock OpenAI 兼容服务器） ----------

// request 在模块加载时定值（BASE_URL/API_KEY/MAX_RETRIES 等），需带环境变量重新加载模块
function freshRequireWithBase(base, extra = {}) {
  const keys = ["DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY", "VISION_MAX_RETRIES", ...Object.keys(extra)];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.DASHSCOPE_BASE_URL = base;
  process.env.DASHSCOPE_API_KEY = "sk-test";
  process.env.VISION_MAX_RETRIES = "3";
  for (const [k, v] of Object.entries(extra)) process.env[k] = String(v);
  delete require.cache[require.resolve("../vision.js")];
  const mod = require("../vision.js");
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

test("request: 5xx 自动重试后成功", async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  });
  try {
    const mod = freshRequireWithBase(`http://127.0.0.1:${port}`);
    const text = await mod.request({ model: "m", messages: [] });
    assert.strictEqual(text, "ok");
    assert.strictEqual(calls, 3);
  } finally {
    server.close();
  }
});

test("request: 429 后尊重 Retry-After 重试成功", async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      res.end(JSON.stringify({ error: { message: "rate limit" } }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  });
  try {
    const mod = freshRequireWithBase(`http://127.0.0.1:${port}`);
    const text = await mod.request({ model: "m", messages: [] });
    assert.strictEqual(text, "ok");
    assert.strictEqual(calls, 2);
  } finally {
    server.close();
  }
});

test("request: 4xx 不重试，且提取 error.message", async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls++;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "模型未开通" } }));
  });
  try {
    const mod = freshRequireWithBase(`http://127.0.0.1:${port}`);
    await assert.rejects(mod.request({ model: "m", messages: [] }), /模型未开通/);
    assert.strictEqual(calls, 1);
  } finally {
    server.close();
  }
});

test("request: BASE_URL 带完整 endpoint 自动剥离后缀", async () => {
  let gotPath = "";
  const { server, port } = await startServer((req, res) => {
    gotPath = req.url;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    const mod = freshRequireWithBase(`http://127.0.0.1:${port}/v1/chat/completions`);
    const text = await mod.request({ model: "m", messages: [] });
    assert.strictEqual(text, "ok");
    assert.strictEqual(gotPath, "/v1/chat/completions");
  } finally {
    server.close();
  }
});

// ---------- runWithConcurrency ----------

test("runWithConcurrency: 按并发上限执行、结果按输入顺序输出", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { server, port } = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const url = JSON.parse(body).messages[0].content[0].image_url.url;
      const idx = url.match(/img(\d)/)[1];
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `描述${idx}` } }] }));
      }, 30);
    });
  });
  try {
    const log = mock.method(console, "log");
    try {
      const mod = freshRequireWithBase(`http://127.0.0.1:${port}`, { VISION_CONCURRENCY: 2, VISION_BATCH: "0", VISION_STREAM: "0" });
      const tasks = [1, 2, 3].map(i => ({
        label: `img${i}.png`,
        resolve: () => Promise.resolve(`http://x/img${i}.png`),
      }));
      const failed = await mod.runWithConcurrency(tasks, 2, "描述");
      assert.strictEqual(failed, false);
      assert.strictEqual(maxInFlight, 2);
      const printed = log.mock.calls.map(c => String(c.arguments[0]));
      const idxOrder = printed.filter(t => /^描述\d/.test(t)).map(t => t.replace("描述", ""));
      assert.deepStrictEqual(idxOrder, ["1", "2", "3"]);
    } finally {
      mock.restoreAll();
    }
  } finally {
    server.close();
  }
});

test("runWithConcurrency: 单图失败不中断其他，返回失败标记", async () => {
  const { server, port } = await startServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "描述B" } }] }));
  });
  try {
    const log = mock.method(console, "log");
    const err = mock.method(console, "error");
    try {
      const mod = freshRequireWithBase(`http://127.0.0.1:${port}`, { VISION_BATCH: "0", VISION_STREAM: "0" });
      const tasks = [
        { label: "missing.png", resolve: () => resolveLocalImage("/nonexistent/xyz.png") },
        { label: "b.png", resolve: () => Promise.resolve("data:image/png;base64,AAAA") },
      ];
      const failed = await mod.runWithConcurrency(tasks, 2, "描述");
      assert.strictEqual(failed, true);
      assert.ok(log.mock.calls.some(c => String(c.arguments[0]).includes("描述B")));
      assert.ok(err.mock.calls.some(c => String(c.arguments[0]).includes("识图失败 (missing.png)")));
    } finally {
      mock.restoreAll();
    }
  } finally {
    server.close();
  }
});

test("runWithConcurrency: 单图直接输出文字，无分隔头", async () => {
  const { server, port } = await startServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "结果文本" } }] }));
  });
  try {
    const log = mock.method(console, "log");
    try {
      const mod = freshRequireWithBase(`http://127.0.0.1:${port}`, { VISION_STREAM: "0" });
      const tasks = [{ label: "a.png", resolve: () => Promise.resolve("http://x/a.png") }];
      const failed = await mod.runWithConcurrency(tasks, 3, "q");
      assert.strictEqual(failed, false);
      assert.strictEqual(log.mock.calls.length, 1);
      assert.strictEqual(String(log.mock.calls[0].arguments[0]), "结果文本");
    } finally {
      mock.restoreAll();
    }
  } finally {
    server.close();
  }
});

test("runWithConcurrency: --json 输出数组，单图也数组", async () => {
  const { server, port } = await startServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "描述A" } }] }));
  });
  try {
    const log = mock.method(console, "log");
    try {
      const mod = freshRequireWithBase(`http://127.0.0.1:${port}`, { VISION_STREAM: "0" });
      const tasks = [{ label: "a.png", resolve: () => Promise.resolve("http://x/a.png") }];
      const failed = await mod.runWithConcurrency(tasks, 3, "q", { json: true });
      assert.strictEqual(failed, false);
      assert.strictEqual(log.mock.calls.length, 1);
      const out = JSON.parse(String(log.mock.calls[0].arguments[0]));
      assert.deepStrictEqual(out, [{ ok: true, label: "a.png", text: "描述A" }]);
    } finally {
      mock.restoreAll();
    }
  } finally {
    server.close();
  }
});

test("runWithConcurrency: --json 失败项带 error 字段", async () => {
  const { server, port } = await startServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "描述B" } }] }));
  });
  try {
    const log = mock.method(console, "log");
    try {
      const mod = freshRequireWithBase(`http://127.0.0.1:${port}`, { VISION_BATCH: "0", VISION_STREAM: "0" });
      const tasks = [
        { label: "missing.png", resolve: () => resolveLocalImage("/nonexistent/xyz.png") },
        { label: "b.png", resolve: () => Promise.resolve("data:image/png;base64,AAAA") },
      ];
      const failed = await mod.runWithConcurrency(tasks, 2, "q", { json: true });
      assert.strictEqual(failed, true);
      const out = JSON.parse(String(log.mock.calls[0].arguments[0]));
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[0].ok, false);
      assert.match(out[0].error, /文件不存在/);
      assert.deepStrictEqual(out[1], { ok: true, label: "b.png", text: "描述B" });
    } finally {
      mock.restoreAll();
    }
  } finally {
    server.close();
  }
});

// ---------- locateAttachment ----------

function makeOpencodeDb(dir, rows) {
  const dbPath = path.join(dir, "opencode.db");
  const fn = path.join(dir, "mkdb.sql");
  fs.writeFileSync(fn, [
    "CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);",
    ...rows.map(r => `INSERT INTO part VALUES ${r};`),
    "",
  ].join("\n"));
  execSync(`sqlite3 "${dbPath}" < "${fn}"`, { stdio: "pipe" });
  return dbPath;
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("locateAttachment: 数据库不存在返回 null", () => {
  const dir = tempDir();
  assert.strictEqual(locateAttachment({ dbPath: path.join(dir, "none.db"), tmpDir: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("locateAttachment: 无图片附件返回 null", () => {
  const dir = tempDir();
  const dbPath = makeOpencodeDb(dir, [`('p1','s1',1,'{"type":"tool","tool":"bash"}')`]);
  assert.strictEqual(locateAttachment({ dbPath, tmpDir: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("locateAttachment: 取最新图片附件并解码", () => {
  const dir = tempDir();
  const b64 = PNG_1PX.toString("base64");
  const dbPath = makeOpencodeDb(dir, [
    `('p1','s1',100,'{"type":"file","mime":"image/png","filename":"clipboard","url":"data:image/png;base64,${b64}"}')`,
    `('p2','s2',200,'{"type":"file","mime":"image/png","filename":"clipboard","url":"data:image/png;base64,${b64}"}')`,
  ]);
  const found = locateAttachment({ dbPath, tmpDir: dir });
  assert.ok(found);
  assert.match(found.source, /opencode/);
  const bytes = fs.readFileSync(found.file);
  assert.deepStrictEqual(bytes, PNG_1PX);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("locateAttachment: VISION_OPENCODE_SESSION 限定会话", () => {
  const dir = tempDir();
  const b64 = PNG_1PX.toString("base64");
  const dbPath = makeOpencodeDb(dir, [
    `('p1','ses_a',300,'{"type":"file","mime":"image/png","filename":"clipboard","url":"data:image/png;base64,${b64}"}')`,
    `('p2','ses_b',400,'{"type":"file","mime":"image/jpeg","filename":"clipboard","url":"data:image/jpeg;base64,${b64}"}')`,
  ]);
  const prev = process.env.VISION_OPENCODE_SESSION;
  process.env.VISION_OPENCODE_SESSION = "ses_a";
  try {
    const found = locateAttachment({ dbPath, tmpDir: dir });
    assert.ok(found);
    assert.match(found.file, /\.png$/);
  } finally {
    if (prev === undefined) delete process.env.VISION_OPENCODE_SESSION;
    else process.env.VISION_OPENCODE_SESSION = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("locateAttachment: 损坏的 JSON 数据返回 null", () => {
  const dir = tempDir();
  const dbPath = makeOpencodeDb(dir, [
    `('p1','s1',100,'this is not json')`,
  ]);
  assert.strictEqual(locateAttachment({ dbPath, tmpDir: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("locateAttachment: url 字段不是 data URI 返回 null", () => {
  const dir = tempDir();
  const dbPath = makeOpencodeDb(dir, [
    `('p1','s1',100,'{"type":"file","mime":"image/png","filename":"clipboard","url":"https://example.com/img.png"}')`,
  ]);
  assert.strictEqual(locateAttachment({ dbPath, tmpDir: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("locateAttachment: jpeg MIME 扩展名规范化为 jpg", () => {
  const dir = tempDir();
  const b64 = PNG_1PX.toString("base64");
  const dbPath = makeOpencodeDb(dir, [
    `('p1','s1',100,'{"type":"file","mime":"image/jpeg","filename":"clipboard","url":"data:image/jpeg;base64,${b64}"}')`,
  ]);
  const found = locateAttachment({ dbPath, tmpDir: dir });
  assert.ok(found);
  assert.match(found.file, /\.jpg$/);
  fs.rmSync(dir, { recursive: true, force: true });
});
