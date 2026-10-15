/**
 * build.js —— 把 src/ 内联成仓库根目录的单文件 index.html
 *
 * 交付物是「双击即用」的单文件：无外链、无前导斜杠路径，可离线保存、可直接放 Pages。
 * 构建时自带静态自检，几秒钟抓出致命拼写错误。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "index.html");

// 顺序有依赖：数据 → 纯工具 → 通道 → 音色 → 引擎 → 界面
const JS_ORDER = [
  "voices-data.js",
  "mp3.js",
  "split.js",
  "fileloader.js",
  "azure.js",
  "voices.js",
  "engine.js",
  "ui.js",
];

const read = (p) => fs.readFileSync(p, "utf8");

function build() {
  const html = read(path.join(SRC, "index.html"));
  const css = read(path.join(SRC, "style.css"));
  const jsParts = JS_ORDER.map((f) => {
    const code = read(path.join(SRC, f));
    return `/* ==================== ${f} ==================== */\n${code}`;
  });
  const js = jsParts.join("\n");

  if (!html.includes("/*__CSS__*/")) throw new Error("模板缺少 /*__CSS__*/ 占位");
  if (!html.includes("/*__JS__*/")) throw new Error("模板缺少 /*__JS__*/ 占位");

  const out = html.replace("/*__CSS__*/", css).replace("/*__JS__*/", js);
  fs.writeFileSync(OUT, out, "utf8");
  fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
  return out;
}

/* ------------------------------------------------------------ 自检 */

const problems = [];
const notes = [];

function check(out) {
  // 1. 不得残留外链资源
  const ext = out.match(/<script[^>]+src=/gi) || [];
  if (ext.length) problems.push(`产物里仍有 ${ext.length} 处 <script src=`);
  const links = out.match(/<link[^>]+href=/gi) || [];
  if (links.length) problems.push(`产物里仍有 ${links.length} 处 <link href=`);

  // 2. 不得有前导斜杠绝对路径（放子目录/GitHub Pages 会 404）
  const abs = out.match(/(?:src|href)=["']\/[^"']*/gi) || [];
  if (abs.length) problems.push(`产物里有 ${abs.length} 处前导斜杠绝对路径：${abs.slice(0, 3).join(", ")}`);

  // 3. 占位符必须已被替换
  if (out.includes("/*__CSS__*/") || out.includes("/*__JS__*/")) problems.push("占位符未被替换");

  // 4. JS 里引用的每个 DOM id 都必须在 HTML 里存在
  const ids = new Set();
  for (const m of out.matchAll(/\bid="([^"]+)"/g)) {
    if (ids.has(m[1])) problems.push(`HTML 里 id 重复：${m[1]}`);
    ids.add(m[1]);
  }
  const used = new Set();
  for (const m of out.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]);
  for (const m of out.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]);
  const missing = [...used].filter((i) => !ids.has(i));
  if (missing.length) problems.push(`JS 引用了 HTML 中不存在的 id：${missing.join(", ")}`);
  notes.push(`DOM id 自检：JS 引用 ${used.size} 个，HTML 定义 ${ids.size} 个，全部命中`);

  // 5. 关键模块必须都在产物里
  for (const key of ["AzureVoicesData", "Mp3Tool", "TextSplit", "FileLoader", "AzureChannel", "TtsEngine", "MSTranslatorAndroidApp"]) {
    if (!out.includes(key)) problems.push(`产物缺少关键模块/常量：${key}`);
  }

  // 6. 关键行为不得被误删
  if (!/referrerPolicy:\s*"no-referrer"/.test(out)) {
    problems.push("缺少 referrerPolicy:'no-referrer'（服务端会因 Referer 返回 401）");
  }
  if (!/new DecompressionStream\("deflate-raw"\)/.test(out)) {
    problems.push("缺少 docx 解压（DecompressionStream deflate-raw）");
  }
}

const out = build();
check(out);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("构建完成 →", path.relative(ROOT, OUT));
console.log("  HTML 总大小 " + kb(Buffer.byteLength(out, "utf8")));
console.log("  其中 JS     " + kb(Buffer.byteLength(JS_ORDER.map((f) => read(path.join(SRC, f))).join(""), "utf8")));
console.log("  其中 CSS    " + kb(Buffer.byteLength(read(path.join(SRC, "style.css")), "utf8")));
notes.forEach((n) => console.log("  · " + n));

if (problems.length) {
  console.error("\n自检未通过：");
  problems.forEach((p) => console.error("  ✗ " + p));
  process.exit(1);
}
console.log("\n自检通过。");
