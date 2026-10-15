/**
 * engine.js —— 合成调度
 *
 * 切分 → 并发合成 → 帧级拼接。不限文字量的关键在这里：
 * 块与块之间相互独立，任何长度的文本都只是"多一点块"，不改变单次请求的大小。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./azure.js"), require("./mp3.js"), require("./split.js"));
  } else {
    root.TtsEngine = factory(root.AzureChannel, root.Mp3Tool, root.TextSplit);
  }
})(typeof self !== "undefined" ? self : this, function (Azure, Mp3, TextSplit) {
  "use strict";

  var state = {
    running: false,
    cancelled: false,
    done: 0,
    total: 0,
    phase: "idle",
  };

  function snap() {
    return {
      running: state.running, phase: state.phase,
      done: state.done, total: state.total,
      percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    };
  }

  /** 固定并发度的任务池，保证结果按原顺序返回 */
  async function pool(size, count, worker) {
    var next = 0;
    var runners = [];
    for (var i = 0; i < Math.min(size, count); i++) {
      runners.push((async function () {
        while (true) {
          if (state.cancelled) return;
          var idx = next++;
          if (idx >= count) return;
          await worker(idx);
        }
      })());
    }
    await Promise.all(runners);
  }

  /**
   * 合成长文本。
   * @param {object} opts
   *   text, voice, locale, style, rate, pitch, volume,
   *   maxChars, concurrency, onProgress
   * @returns {Promise<{bytes:Uint8Array, frames:number, seconds:number, chunks:number, format:string}>}
   */
  async function run(opts) {
    var o = opts || {};
    var chunks = TextSplit.split(o.text, { maxChars: o.maxChars || 800 });
    if (!chunks.length) throw new Error("没有可合成的内容，请先输入文字");

    state.running = true;
    state.cancelled = false;
    state.done = 0;
    state.total = chunks.length;
    state.phase = "synthesizing";
    var onProgress = o.onProgress || function () {};

    var parts = new Array(chunks.length);
    var failures = [];

    var voiceOpts = {
      voice: o.voice, locale: o.locale, style: o.style,
      rate: o.rate, pitch: o.pitch, volume: o.volume,
    };

    function report(extra) {
      var s = snap();
      s.chunkChars = chunks.length;
      if (extra) for (var k in extra) s[k] = extra[k];
      onProgress(s);
    }
    report();

    try {
      await pool(Math.max(1, Math.min(o.concurrency || 3, 6)), chunks.length, async function (idx) {
        if (state.cancelled) return;
        var lastErr = null;
        for (var t = 0; t < 2; t++) { // engine 层再兜两轮
          try {
            parts[idx] = await Azure.synthesize(chunks[idx], voiceOpts);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (state.cancelled) return;
            if (t === 0) await new Promise(function (r) { setTimeout(r, 600); });
          }
        }
        if (lastErr) {
          failures.push({
            index: idx,
            total: chunks.length,
            preview: chunks[idx].slice(0, 40).replace(/\n/g, " "),
            message: lastErr.message,
          });
          // 失败也要计入进度，否则进度条会永远卡住
          state.done++;
          report({ lastError: lastErr.message });
          return;
        }
        state.done++;
        report();
      });

      if (state.cancelled) throw new Error("已取消");

      if (failures.length) {
        var f = failures.sort(function (a, b) { return a.index - b.index; })[0];
        var tail = failures.length > 1 ? "（共 " + failures.length + " 个片段失败）" : "";
        var err = new Error(
          "第 " + (f.index + 1) + "/" + f.total + " 段合成失败" + tail + "：" + f.message +
          "\n失败片段开头：「" + f.preview + "…」"
        );
        err.failures = failures;
        throw err;
      }

      state.phase = "joining";
      report();
      var joined = Mp3.concat(parts.filter(function (p) { return p && p.length; }));
      if (!joined.frames) throw new Error("合成结果为空，请检查音色是否可用");

      state.phase = "done";
      state.running = false;
      report();
      return {
        bytes: joined.bytes,
        frames: joined.frames,
        seconds: Mp3.durationSec(joined.frames, true),
        chunks: chunks.length,
        format: Mp3.describe(joined.info),
        skipped: joined.skipped.length,
        chunkList: chunks,
      };
    } catch (e) {
      state.running = false;
      state.phase = "error";
      report({ lastError: e.message });
      throw e;
    }
  }

  /** 试听：只合成开头一小段，快速确认音色与风格 */
  async function preview(opts) {
    var o = opts || {};
    var text = String(o.text || "").trim();
    if (!text) throw new Error("请先输入文字");
    var head = TextSplit.split(text, { maxChars: o.previewChars || 60 })[0] || text.slice(0, 60);
    var bytes = await Azure.synthesize(head, {
      voice: o.voice, locale: o.locale, style: o.style,
      rate: o.rate, pitch: o.pitch, volume: o.volume,
    });
    var r = Mp3.toFrames(bytes);
    return {
      bytes: r.bytes, frames: r.frames,
      seconds: Mp3.durationSec(r.frames, true),
      format: Mp3.describe(r.info),
      text: head,
    };
  }

  function cancel() {
    if (state.running) {
      state.cancelled = true;
      state.phase = "cancelled";
    }
  }

  /** 只换 token，测通道连通性 */
  async function checkChannel() {
    var t0 = Date.now();
    var cred = await Azure.getToken(true);
    return { region: cred.region, ms: Date.now() - t0, expMs: cred.expMs };
  }

  return { run: run, preview: preview, cancel: cancel, state: snap, checkChannel: checkChannel };
});
