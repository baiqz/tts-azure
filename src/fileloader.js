/**
 * fileloader.js —— 把本地文件读成纯文本
 *
 * 支持：
 *   纯文本类  txt / md / csv / tsv / json / log / ini…… —— 自动判别 UTF-8 / GBK / UTF-16 编码
 *   字幕      srt / vtt / ass / ssa —— 剥掉序号与时间轴，只留台词
 *   网页      html / htm / xml —— 剥掉标签，只留正文
 *   文档      docx —— 解 zip 取正文，用浏览器原生 DecompressionStream，不引第三方库
 * 不支持：
 *   pdf / doc（老二进制格式）—— 明确报错并给替代办法，而不是静默读出乱码
 *
 * 设计原则：所有解析逻辑纯粹、不碰 DOM，因此可以在 Node 里直接做单测。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FileLoader = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------ 常量 */

  // 单文件上限。只是防呆（有人拖进来一个 500MB 的日志），不是能力上限。
  var MAX_BYTES = 24 * 1024 * 1024;

  var KIND_BY_EXT = {
    txt: "text", text: "text", log: "text", ini: "text", cfg: "text",
    csv: "text", tsv: "text", json: "text", jsonl: "text",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    html: "html", htm: "html", xhtml: "html", xml: "html", rss: "html",
    srt: "subtitle", vtt: "subtitle", ass: "subtitle", ssa: "subtitle",
    docx: "docx",
    doc: "unsupported-doc", pdf: "unsupported-pdf",
  };

  // 给 <input type=file accept> 用。把不支持的类型也列进去 —— 好让用户能选中它、
  // 进而看到"为什么不行 + 怎么办"，而不是被系统文件框直接挡住、一头雾水。
  var ACCEPT = [
    ".txt", ".text", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".ini", ".cfg",
    ".srt", ".vtt", ".ass", ".ssa", ".html", ".htm", ".xml",
    ".docx", ".doc", ".pdf",
  ].join(",");

  var KIND_LABEL = {
    text: "纯文本", markdown: "Markdown", html: "网页/XML",
    subtitle: "字幕", docx: "Word 文档",
  };

  /* ------------------------------------------------------------ 小工具 */

  function extOf(name) {
    var m = /\.([^.\\/]+)$/.exec(String(name == null ? "" : name));
    return m ? m[1].toLowerCase() : "";
  }

  function baseName(name) {
    return String(name == null ? "" : name).replace(/^.*[\\/]/, "");
  }

  /** 按扩展名 / MIME 判断文件种类 */
  function kindOf(name, mime) {
    var e = extOf(name);
    if (KIND_BY_EXT[e]) return KIND_BY_EXT[e];
    var m = String(mime || "");
    if (/officedocument\.wordprocessingml|vnd\.openxmlformats.*word/i.test(m)) return "docx";
    if (m === "application/pdf") return "unsupported-pdf";
    if (m === "application/msword") return "unsupported-doc";
    if (/^text\//.test(m) || m === "application/json" || m === "application/xml") return "text";
    return "unknown"; // 交给内容探测
  }

  /** 靠 NUL 字节判断是不是二进制（无扩展名文件 / 误改后缀的文件走这里） */
  function looksBinary(bytes, limit) {
    var n = Math.min(bytes.length, limit || 4096);
    for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }

  /** 解码 XML/HTML 实体 */
  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
        return safeCp(parseInt(h, 16));
      })
      .replace(/&#(\d+);/g, function (_, d) {
        return safeCp(parseInt(d, 10));
      })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&hellip;/g, "…")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&amp;/g, "&"); // 必须最后替换
  }

  function safeCp(n) {
    if (!isFinite(n) || n < 0 || n > 0x10ffff) return "";
    try { return String.fromCodePoint(n); } catch (e) { return ""; }
  }

  function tidy(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* ------------------------------------------------------------ 编码 */

  /**
   * 把字节解成字符串，自动判别编码。
   * 顺序：BOM → 严格按 UTF-8 试（fatal）→ 失败则 GBK → 再失败退回宽松 UTF-8。
   * Windows 上大量中文 txt 是 GBK，这一步不判会读出一屏「锟斤拷」。
   */
  function decodeBytes(bytes) {
    var b = bytes;
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      return { text: dec("utf-8", b.subarray(3)), encoding: "UTF-8 (BOM)" };
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      return { text: dec("utf-16le", b.subarray(2)), encoding: "UTF-16 LE" };
    }
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      return { text: dec("utf-16be", b.subarray(2)), encoding: "UTF-16 BE" };
    }
    try {
      return { text: strictDecode("utf-8", b), encoding: "UTF-8" };
    } catch (e) {
      // 不是合法 UTF-8 → 中文环境里绝大多数是 GBK
    }
    try {
      var g = dec("gbk", b);
      // GBK 解出来仍有替换字符，说明也不是 GBK
      if (g.indexOf("\ufffd") < 0) return { text: g, encoding: "GBK / GB18030" };
    } catch (e2) { /* 运行时不支持 gbk，往下走 */ }
    return { text: dec("utf-8", b), encoding: "UTF-8（含无法识别字符）" };
  }

  function dec(enc, bytes) {
    return new TextDecoder(enc).decode(bytes);
  }

  function strictDecode(enc, bytes) {
    return new TextDecoder(enc, { fatal: true }).decode(bytes);
  }

  /* ------------------------------------------------------------ 各格式清洗 */

  /** 字幕：去掉序号行与 --> 时间轴，只留台词 */
  function stripSubtitles(raw, kind) {
    var t = String(raw).replace(/\r\n?/g, "\n");
    if (kind === "ass" || /^\[Script Info\]/im.test(t)) return stripAss(t);

    var lines = t.split("\n");
    var blocks = [];
    var cur = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var s = line.trim();
      if (!s) {
        if (cur.length) { blocks.push(cur); cur = []; }
        continue;
      }
      if (/^WEBVTT/i.test(s)) continue;                       // vtt 头
      if (/^NOTE\b/i.test(s)) continue;                       // vtt 注释
      if (/^\d+$/.test(s)) continue;                          // srt 序号
      if (/-->/.test(s)) continue;                            // 时间轴
      if (/^(Kind|Language|Style|Region|STYLE|REGION)\s*:/i.test(s)) continue;
      cur.push(s.replace(/<[^>]+>/g, ""));                    // 去 vtt 内联标签
    }
    if (cur.length) blocks.push(cur);

    return tidy(blocks.map(function (b) { return joinLines(b); }).join("\n\n"));
  }

  function stripAss(t) {
    var lines = t.split("\n");
    var out = [];
    var inEvents = false;
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (/^\[/.test(s)) { inEvents = /^\[Events\]/i.test(s); continue; }
      if (!inEvents) continue;
      if (/^Format\s*:/i.test(s)) continue;
      var m = /^Dialogue\s*:\s*(.*)$/i.exec(s);
      if (!m) continue;
      var parts = m[1].split(",");
      var text = parts.slice(9).join(",").trim();             // 第 10 段起是台词
      text = text.replace(/\{[^}]*\}/g, "").replace(/\\N|\\n/g, "\n").trim();
      if (text) out.push(text);
    }
    return tidy(out.join("\n"));
  }

  /** 同一字幕块内的折行合并：中文直接接，英文之间补空格 */
  function joinLines(lines) {
    var out = "";
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s) continue;
      if (!out) { out = s; continue; }
      var a = out[out.length - 1];
      var b = s[0];
      var asciiA = /[A-Za-z0-9,.;:!?'")\]]/.test(a);
      var asciiB = /[A-Za-z0-9('"[]/.test(b);
      out += (asciiA && asciiB ? " " : "") + s;
    }
    return out;
  }

  /** 网页 / XML：剥标签留正文 */
  function stripHtml(raw) {
    var t = String(raw);
    t = t.replace(/<!--[\s\S]*?-->/g, "");
    t = t.replace(/<(script|style|head|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    t = t.replace(/<\/t[dh]\s*>/gi, "\t");                          // 表格单元格（必须在通用闭合标签之前）
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = t.replace(/<hr\s*\/?>/gi, "\n");
    t = t.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|figcaption|table|ul|ol)\s*>/gi, "\n");
    t = t.replace(/<[^>]+>/g, "");
    return tidy(decodeEntities(t));
  }

  /** Markdown：只清"看着就碍事"的排版标记，不碰正文语义 */
  function stripMarkdown(raw) {
    var t = String(raw).replace(/\r\n?/g, "\n");
    t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");           // 代码块留内容去围栏
    t = t.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, "$1");
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");             // 图片 → alt 文字
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");              // 链接 → 链接文字
    t = t.replace(/^\s{0,3}> ?/gm, "");                         // 引用
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");                   // 标题
    t = t.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");              // 列表标记
    t = t.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");               // 水平线
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");                  // 粗体
    t = t.replace(/__([^_\n]+)__/g, "$1");
    t = t.replace(/`([^`\n]+)`/g, "$1");                        // 行内代码
    t = t.replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, "");             // 表格分隔行
    t = t.replace(/^\s*\|(.+)\|\s*$/gm, function (_, inner) {   // 表格行
      return inner.split("|").map(function (c) { return c.trim(); }).filter(Boolean).join(" ");
    });
    return tidy(decodeEntities(t));
  }

  /* ------------------------------------------------------------ docx */

  function findEocd(buf) {
    var min = Math.max(0, buf.length - 66000);
    for (var i = buf.length - 22; i >= min; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
    }
    return -1;
  }

  /** 读 zip 中央目录，列出条目 */
  function listEntries(buf) {
    var eocd = findEocd(buf);
    if (eocd < 0) throw new Error("不是有效的 docx（找不到 zip 中央目录）");
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var count = view.getUint16(eocd + 10, true);
    var cdOff = view.getUint32(eocd + 16, true);
    if (cdOff <= 0 || cdOff >= buf.length) throw new Error("docx 中央目录位置异常");

    var out = [], p = cdOff;
    for (var i = 0; i < count; i++) {
      if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014b50) break;
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var cmtLen = view.getUint16(p + 32, true);
      out.push({
        name: dec("utf-8", buf.subarray(p + 46, p + 46 + nameLen)),
        method: view.getUint16(p + 10, true),
        compSize: view.getUint32(p + 20, true),
        localOff: view.getUint32(p + 42, true),
      });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  /** 取出某个条目的原始内容（method 0 直取，8 走原生 deflate-raw 解压） */
  async function readEntry(buf, entry) {
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var lo = entry.localOff;
    if (lo + 30 > buf.length || view.getUint32(lo, true) !== 0x04034b50) {
      throw new Error("docx 局部文件头损坏");
    }
    var nameLen = view.getUint16(lo + 26, true);
    var extraLen = view.getUint16(lo + 28, true);
    var start = lo + 30 + nameLen + extraLen;

    // 用了 data descriptor 的 zip 在中央目录里 size 已修正，但 local 头里可能是 0；
    // 这里以中央目录的 compSize 为准，超出边界就直接认错。
    if (start + entry.compSize > buf.length) throw new Error("docx 条目长度越界");
    var data = buf.subarray(start, start + entry.compSize);

    if (entry.method === 0) return data;
    if (entry.method === 8) return await inflateRaw(data);
    throw new Error("docx 使用了不支持的压缩方式（method=" + entry.method + "）");
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持解压 docx，请改用 txt 或在 Chrome/Edge 里打开");
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** document.xml → 纯文本 */
  function docxXmlToText(xml) {
    var s = String(xml || "");
    s = s.replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "");  // 修订删除的内容不要
    s = s.replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, ""); // 域代码（页码之类）
    s = s.replace(/<w:tab\b[^>]*\/?>/g, "\t");
    s = s.replace(/<w:br\b[^>]*\/?>/g, "\n");
    s = s.replace(/<w:cr\b[^>]*\/?>/g, "\n");
    s = s.replace(/<\/w:p>/g, "\n");     // 段落 → 换行
    s = s.replace(/<\/w:tr>/g, "\n");    // 表格行
    s = s.replace(/<\/w:tc>/g, "\t");    // 单元格
    s = s.replace(/<[^>]+>/g, "");       // 其余标签全去掉，剩下的就是文字
    return tidy(decodeEntities(s));
  }

  /** 解析 docx 字节 → 正文 */
  async function parseDocx(bytes) {
    var entries = listEntries(bytes);
    var target =
      entries.filter(function (e) { return e.name === "word/document.xml"; })[0] ||
      entries.filter(function (e) { return /^word\/document\d*\.xml$/.test(e.name); })[0];
    if (!target) {
      throw new Error("这个 docx 里没有正文（word/document.xml 缺失），可能是改后缀得到的假 docx");
    }
    var xml = dec("utf-8", await readEntry(bytes, target));
    var text = docxXmlToText(xml);
    if (!text) throw new Error("docx 正文是空的");
    return text;
  }

  /* ------------------------------------------------------------ 主流程 */

  /**
   * 读单个文件。
   * @param {{name:string, bytes:Uint8Array|ArrayBuffer, mime?:string}} file
   * @returns {Promise<{name:string,kind:string,label:string,text:string,encoding:string,chars:number,note:string}>}
   */
  async function readOne(file) {
    var name = baseName(file && file.name);
    var bytes = toU8(file && file.bytes);
    if (!bytes || !bytes.length) throw new Error("文件是空的：" + name);
    if (bytes.length > MAX_BYTES) {
      throw new Error(name + " 太大（" + mb(bytes.length) + "），单文件请控制在 " + mb(MAX_BYTES) + " 以内");
    }

    var kind = kindOf(name, file && file.mime);
    var encoding = "";
    var text = "";

    if (kind === "unsupported-pdf") {
      throw new Error("PDF 暂时读不了。请先在阅读器里全选复制，或用「另存为 txt / Word」，再读进来。");
    }
    if (kind === "unsupported-doc") {
      throw new Error("这是老版 .doc 二进制格式，读不了。用 Word 另存为 .docx 或 .txt 即可。");
    }

    if (kind === "docx") {
      text = await parseDocx(bytes);
      encoding = "UTF-8";
    } else {
      // 未知类型或无扩展名：靠 NUL 字节判断是不是二进制
      if (kind === "unknown" && looksBinary(bytes)) {
        throw new Error("这个文件像是二进制格式，读不成文字：" + name);
      }
      var d = decodeBytes(bytes);
      encoding = d.encoding;
      var raw = d.text;

      if (kind === "subtitle") {
        var lower = baseName(name).toLowerCase();
        var isAss = lower.endsWith(".ass") || lower.endsWith(".ssa");
        text = stripSubtitles(raw, isAss ? "ass" : "srt");
      } else if (kind === "html") text = stripHtml(raw);
      else if (kind === "markdown") text = stripMarkdown(raw);
      else text = tidy(raw);
      if (kind === "unknown") kind = "text";
    }

    if (!text) throw new Error(name + " 里没读出文字（可能是空文档或纯图片）");

    var notes = [];
    if (encoding) notes.push(encoding);
    if (kind === "subtitle") notes.push("已去时间轴");
    else if (kind === "html") notes.push("已去标签");
    else if (kind === "markdown") notes.push("已清标记");

    return {
      name: name,
      kind: kind,
      label: KIND_LABEL[kind] || "文本",
      text: text,
      encoding: encoding,
      chars: text.replace(/\s/g, "").length,
      note: notes.join(" · "),
    };
  }

  /**
   * 读一批文件，按给定顺序合并。
   * @returns {Promise<{text:string, parts:Array, failed:Array}>}
   */
  async function readAll(files, onProgress) {
    var parts = [], failed = [];
    for (var i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i + 1, files.length, files[i].name);
      try {
        parts.push(await readOne(files[i]));
      } catch (e) {
        failed.push({ name: baseName(files[i].name), message: e.message });
      }
    }
    return {
      text: parts.map(function (p) { return p.text; }).join("\n\n"),
      parts: parts,
      failed: failed,
    };
  }

  function toU8(v) {
    if (!v) return null;
    if (v instanceof Uint8Array) return v;
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) return new Uint8Array(v);
    if (v.buffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    return null;
  }

  function mb(n) {
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  return {
    ACCEPT: ACCEPT,
    MAX_BYTES: MAX_BYTES,
    KIND_LABEL: KIND_LABEL,
    extOf: extOf,
    baseName: baseName,
    kindOf: kindOf,
    looksBinary: looksBinary,
    decodeBytes: decodeBytes,
    stripSubtitles: stripSubtitles,
    stripHtml: stripHtml,
    stripMarkdown: stripMarkdown,
    docxXmlToText: docxXmlToText,
    listEntries: listEntries,
    readEntry: readEntry,
    parseDocx: parseDocx,
    readOne: readOne,
    readAll: readAll,
    tidy: tidy,
    decodeEntities: decodeEntities,
  };
});
