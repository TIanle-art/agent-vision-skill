const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseArgs, isImagePath, resolveLocalImage, loadDotEnv, checkRemoteSize } = require("../vision.js");

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
