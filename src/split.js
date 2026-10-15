/**
 * split.js —— 文本切分
 *
 * 目标：把任意长度的文本切成适合单次合成的块，同时尽量不破坏语言的呼吸节奏。
 * 优先级：段落 > 句子 > 分句 > 硬切。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TextSplit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SENT_END = "。！？!?；;…";
  var SOFT_END = "，,、：:）)】」』”";

  /** 归一化：统一换行、去零宽字符、压缩空白行 */
  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  /** 把一段文字切成句子（保留句末标点） */
  function splitSentences(para) {
    var out = [];
    var buf = "";
    for (var i = 0; i < para.length; i++) {
      var ch = para[i];
      buf += ch;
      if (ch === "\n" || SENT_END.indexOf(ch) >= 0) {
        // 句末连续标点（如 ”！）一起收进来
        while (i + 1 < para.length && (SENT_END.indexOf(para[i + 1]) >= 0 || para[i + 1] === '"' || para[i + 1] === "\u201d")) {
          buf += para[++i];
        }
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /** 超长单句：先找软边界（逗号等），再硬切 */
  function breakLong(sentence, max) {
    var pieces = [];
    var buf = "";
    for (var i = 0; i < sentence.length; i++) {
      buf += sentence[i];
      if (buf.length >= max) {
        // 往前回退到最近的软边界，让切口落在自然停顿处
        var cut = -1;
        for (var k = buf.length - 1; k >= Math.floor(max * 0.6); k--) {
          if (SOFT_END.indexOf(buf[k]) >= 0) { cut = k + 1; break; }
        }
        if (cut > 0) {
          pieces.push(buf.slice(0, cut));
          buf = buf.slice(cut);
        } else {
          pieces.push(buf);
          buf = "";
        }
      }
    }
    if (buf) pieces.push(buf);
    return pieces;
  }

  /**
   * 主入口。
   * @param {string} text
   * @param {object} [opts] {maxChars?:number, minChars?:number}
   * @returns {string[]}
   */
  function split(text, opts) {
    opts = opts || {};
    var max = Math.max(120, opts.maxChars || 800);
    var min = Math.max(20, opts.minChars || Math.floor(max * 0.25));

    var t = normalize(text);
    if (!t) return [];

    var paras = t.split(/\n{2,}/);
    var units = []; // 先展开成"句子"级单元
    for (var p = 0; p < paras.length; p++) {
      var para = paras[p].trim();
      if (!para) continue;
      var sents = splitSentences(para);
      for (var s = 0; s < sents.length; s++) {
        if (sents[s].length <= max) units.push(sents[s]);
        else units = units.concat(breakLong(sents[s], max));
      }
    }
    if (!units.length) return [];

    // 贪心聚合
    var chunks = [];
    var cur = "";
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      if (!cur) { cur = unit; continue; }
      if (cur.length + 1 + unit.length <= max) {
        cur += "\n" + unit;
      } else {
        chunks.push(cur);
        cur = unit;
      }
    }
    if (cur) chunks.push(cur);

    // 尾块过短则并入上一块（避免出现"嗯。"这种碎片块）
    if (chunks.length >= 2 && chunks[chunks.length - 1].length < min) {
      chunks[chunks.length - 2] += "\n" + chunks.pop();
    }
    return chunks;
  }

  /** 统计：字符数（不含空白）、块数、预估时长 */
  function stats(text, opts) {
    var chunks = split(text, opts);
    var chars = 0;
    for (var i = 0; i < chunks.length; i++) {
      chars += chunks[i].replace(/\s/g, "").length;
    }
    // 实测中文语速约 4.7~5.0 字/秒，取 4.6 保守估计
    var seconds = chars / 4.6;
    return {
      chunks: chunks.length,
      chars: chars,
      rawChars: normalize(text).length,
      seconds: seconds,
      bytesEstimate: Math.round(seconds * 6000), // 48kbps ≈ 6KB/s
    };
  }

  return { normalize: normalize, splitSentences: splitSentences, split: split, stats: stats };
});
