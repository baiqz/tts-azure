/**
 * ui.js —— 界面逻辑
 *
 * 只负责"读界面、调引擎、写界面"，不包含任何合成细节。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var PAGE_SIZE = 40;
  var SAMPLE = [
    "云泽的嗓音偏低，语速不快，适合念那种需要人安静听下去的东西。",
    "这一句你可以拿来对比：同样的字，换一个音色，语气就完全变了。",
    "上方的文本框没有字数限制。你把一整本书贴进去也行 —— 工具会先把文字按段落和句子切开，几段同时合成，最后按音频帧边界拼成一整条 MP3，中间不会有断裂感。",
    "试试把语速调慢一点，再选一个纪录片旁白的风格，会有惊喜。"
  ].join("\n\n");

  var st = {
    group: "pinned",
    query: "",
    page: 1,
    voice: "zh-CN-YunzeNeural",
    result: null,
    blobUrl: null,
    running: false,
    timer: null,
  };

  /* ------------------------------------------------------------ 工具 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function alertBox(msg, kind) {
    var a = $("alert");
    if (!msg) { a.style.display = "none"; return; }
    a.className = "alert" + (kind ? " " + kind : "");
    a.textContent = msg;
    a.style.display = "";
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function chunkSize() { return Number($("chunkSize").value) || 800; }

  function groupName(id) {
    for (var i = 0; i < Voices.GROUPS.length; i++) {
      if (Voices.GROUPS[i].id === id) return Voices.GROUPS[i].name;
    }
    return id;
  }

  function savePrefs() {
    try {
      localStorage.setItem("tts-azure-prefs", JSON.stringify({
        voice: st.voice,
        style: $("style").value,
        rate: $("rate").value,
        pitch: $("pitch").value,
        volume: $("volume").value,
        chunkSize: $("chunkSize").value,
        concurrency: $("concurrency").value,
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem("tts-azure-prefs");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /* -------------------------------------------------------- 音色列表 */

  function voiceMeta(v) {
    var bits = [];
    bits.push(v.g === "M" ? "男声" : v.g === "F" ? "女声" : "中性");
    bits.push(v.l);
    if (v.s) bits.push(v.s);
    if (v.st && v.st.length) bits.push(v.st.length + " 种风格");
    return bits.join(" · ");
  }

  function renderTabs() {
    var box = $("voiceTabs");
    box.textContent = "";
    Voices.GROUPS.forEach(function (g) {
      var n = Voices.count(g.id);
      var b = el("button", "tab" + (st.group === g.id ? " on" : ""));
      b.appendChild(document.createTextNode(g.name));
      var cnt = el("span", "n", n);
      b.appendChild(cnt);
      b.onclick = function () {
        st.group = g.id;
        st.page = 1;
        renderTabs();
        renderVoices();
      };
      box.appendChild(b);
    });
  }

  function renderVoices() {
    var all = Voices.list(st.group, st.query);
    var shown = all.slice(0, st.page * PAGE_SIZE);
    var list = $("voiceList");
    list.textContent = "";

    $("voiceListCount").textContent = all.length + " 个";

    if (!all.length) {
      list.appendChild(el("div", "empty",
        st.query ? "「" + st.query + "」在「" + groupName(st.group) + "」里没有匹配，换个分组或清空搜索" : "这个分组暂时没有音色"));
    } else {
      shown.forEach(function (v) {
        var b = el("button", "voice" + (v.n === st.voice ? " on" : ""));
        b.dataset.n = v.n;
        var nameBox = el("span", "vname");
        if (v.n.indexOf("zh-CN-Yunze") === 0) nameBox.appendChild(el("span", "star", "★"));
        nameBox.appendChild(document.createTextNode(v.dn));
        b.appendChild(nameBox);
        b.appendChild(el("span", "vmeta", voiceMeta(v)));
        b.onclick = function () { selectVoice(v.n); };
        list.appendChild(b);
      });
    }

    var more = $("btnMore");
    var rest = all.length - shown.length;
    if (rest > 0) {
      more.style.display = "";
      more.textContent = "显示更多（还有 " + rest + " 个）";
    } else {
      more.style.display = all.length > PAGE_SIZE ? "" : "none";
      more.textContent = all.length > PAGE_SIZE ? "已显示全部 " + all.length + " 个" : "显示更多";
      if (all.length <= PAGE_SIZE) more.style.display = "none";
    }
  }

  function selectVoice(name) {
    st.voice = name;
    var v = Voices.find(name);
    if (!v) return;
    $("curVoice").textContent = v.dn + " · " + voiceMeta(v);
    fillStyles(v);

    var items = $("voiceList").children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("on", items[i].dataset.n === name);
    }
    savePrefs();
  }

  function fillStyles(v) {
    var sel = $("style");
    var keep = sel.value;
    sel.textContent = "";
    var o0 = el("option", null, "默认（不带风格）");
    o0.value = "";
    sel.appendChild(o0);
    (v.st || []).forEach(function (s) {
      var o = el("option", null, Voices.styleLabel(s));
      o.value = s;
      sel.appendChild(o);
    });
    if (keep && (v.st || []).indexOf(keep) >= 0) sel.value = keep;
    $("styleCount").textContent = (v.st && v.st.length)
      ? "（" + v.st.length + " 种）"
      : "（此音色不支持风格）";
    sel.disabled = !(v.st && v.st.length);
    if (!v.st || !v.st.length) sel.value = "";
  }

  /* -------------------------------------------------------- 读取文件 */

  // dragenter/dragleave 会随子元素成对冒泡，用计数器才不会闪
  var dragDepth = 0;

  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === "Files") return true;
    }
    return false;
  }

  async function handleFiles(list) {
    var files = [];
    for (var i = 0; i < list.length; i++) files.push(list[i]);
    if (!files.length) return;

    var cur = $("text").value;
    var btn = $("btnFile");
    btn.disabled = true;
    alertBox("正在读取…", "info");

    try {
      var payload = [];
      for (var j = 0; j < files.length; j++) {
        var f = files[j];
        payload.push({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
      }

      var res = await FileLoader.readAll(payload, function (n, total, name) {
        alertBox("正在读取（" + n + "/" + total + "）：" + name, "info");
      });

      var lines = [];
      var chars = 0;
      if (res.parts.length) {
        res.parts.forEach(function (p) { chars += p.chars; });
        lines.push("已读入 " + res.parts.length + " 个文件，共 " + chars.toLocaleString("zh-CN") + " 字" +
          (cur.trim() ? "，已接在原有文字后面" : "") + "：");
        res.parts.forEach(function (p) {
          lines.push("　· " + p.name + "　" + p.label + " · " + p.note + " · " +
            p.chars.toLocaleString("zh-CN") + " 字");
        });
      }
      if (res.failed.length) {
        if (lines.length) lines.push("");
        lines.push("有 " + res.failed.length + " 个文件读不了：");
        res.failed.forEach(function (f) {
          lines.push("　· " + f.name + "　" + f.message);
        });
      }

      if (res.parts.length) {
        $("text").value = cur.trim() ? cur.replace(/\s+$/, "") + "\n\n" + res.text : res.text;
        updateStats();
        $("text").scrollTop = $("text").scrollHeight;   // 滚到新读入的部分
      }
      alertBox(lines.join("\n"),
        res.failed.length ? (res.parts.length ? "info" : "") : "good");

      return res;
    } catch (e) {
      alertBox("读取失败：" + e.message);
      return null;
    } finally {
      btn.disabled = false;
      $("fileInput").value = "";   // 清掉，才能重复选同一个文件
    }
  }

  /* ------------------------------------------------------------ 统计 */

  function updateStats() {
    var text = $("text").value;
    var s = TextSplit.stats(text, { maxChars: chunkSize() });
    // 预估要跟着语速走：设了 -20% 就是把时长拉长 1.25 倍
    var rate = Number($("rate").value) || 0;
    var factor = 1 / (1 + rate / 100);
    var seconds = s.seconds * factor;
    var bytes = s.bytesEstimate * factor;

    $("sChars").textContent = s.chars.toLocaleString("zh-CN");
    $("sChunks").textContent = s.chunks;
    $("sTime").textContent = Mp3Tool.formatTime(seconds);
    $("sSize").textContent = fmtSize(bytes);

    var hint = $("sHint");
    if (s.chars === 0) {
      hint.textContent = "";
    } else if (bytes > 80 * 1024 * 1024) {
      hint.textContent = "篇幅很大，成品约 " + fmtSize(bytes) + "，请留意内存";
      hint.className = "hint";
    } else {
      hint.textContent = "不限字数";
      hint.className = "hint good";
    }
  }

  function scheduleStats() {
    clearTimeout(st.timer);
    st.timer = setTimeout(updateStats, 180);
  }

  /* -------------------------------------------------------- 合成流程 */

  function setRunning(on) {
    st.running = on;
    $("btnStart").disabled = on;
    $("btnPreview").disabled = on;
    $("btnCancel").style.display = on ? "" : "none";
    $("progressWrap").style.display = on ? "" : "none";
    $("btnStart").textContent = on ? "合成中…" : "开始合成";
  }

  function setProgress(p) {
    $("progressBar").style.width = (p.percent || 0) + "%";
    var phase = {
      synthesizing: "正在合成语音",
      joining: "正在拼接音频",
      done: "完成",
      error: "出错",
      cancelled: "已取消",
      idle: "准备中",
    }[p.phase] || p.phase;
    $("progressPhase").textContent = phase + (p.total ? "（" + p.done + "/" + p.total + " 段）" : "");
    $("progressText").textContent = (p.percent || 0) + "%";
  }

  function opts() {
    var v = Voices.find(st.voice);
    return {
      text: $("text").value,
      voice: st.voice,
      locale: Voices.localeFor(v),
      style: $("style").value || "",
      rate: Number($("rate").value),
      pitch: Number($("pitch").value),
      volume: Number($("volume").value),
      maxChars: chunkSize(),
      concurrency: Number($("concurrency").value),
    };
  }

  async function doPreview() {
    var o = opts();
    if (!o.text.trim()) o.text = SAMPLE;
    alertBox("");
    setRunning(true);
    setProgress({ phase: "synthesizing", percent: 0, done: 0, total: 1 });
    try {
      var r = await TtsEngine.preview(o);
      playBytes(r.bytes);
      alertBox("试听片段：" + r.format + " · " + r.seconds.toFixed(1) + " 秒\n「" + r.text.slice(0, 50) + "…」", "info");
      setProgress({ phase: "done", percent: 100, done: 1, total: 1 });
    } catch (e) {
      alertBox(e.message);
    } finally {
      setRunning(false);
    }
  }

  async function doStart() {
    var o = opts();
    if (!o.text.trim()) { alertBox("请先输入要转换的文字。"); $("text").focus(); return; }
    alertBox("");
    st.result = null;
    setRunning(true);
    setProgress({ phase: "synthesizing", percent: 0, done: 0, total: 1 });
    var t0 = Date.now();
    try {
      var r = await TtsEngine.run({
        text: o.text, voice: o.voice, locale: o.locale, style: o.style,
        rate: o.rate, pitch: o.pitch, volume: o.volume,
        maxChars: o.maxChars, concurrency: o.concurrency,
        onProgress: setProgress,
      });
      st.result = r;
      showResult(r, Date.now() - t0, o);
      alertBox("合成完成：" + r.chunks + " 段，用时 " + ((Date.now() - t0) / 1000).toFixed(1) + " 秒。", "good");
    } catch (e) {
      alertBox(e.message);
      setProgress({ phase: "error", percent: 0, done: 0, total: 0 });
    } finally {
      setRunning(false);
    }
  }

  function showResult(r, ms, o) {
    var v = Voices.find(o.voice) || { dn: o.voice };
    var bytes = r.bytes;
    var blob = new Blob([bytes], { type: "audio/mpeg" });
    if (st.blobUrl) URL.revokeObjectURL(st.blobUrl);
    st.blobUrl = URL.createObjectURL(blob);

    var a = $("audio");
    a.src = st.blobUrl;

    $("resultCard").style.display = "";
    $("resultFormat").textContent = r.format;
    var info = $("resultInfo");
    info.textContent = "";
    [
      ["时长", Mp3Tool.formatTime(r.seconds)],
      ["大小", fmtSize(bytes.length)],
      ["音频帧", r.frames.toLocaleString("zh-CN")],
      ["分段", r.chunks + " 段"],
      ["耗时", (ms / 1000).toFixed(1) + " 秒"],
      ["字数", TextSplit.stats(o.text).chars.toLocaleString("zh-CN")],
    ].forEach(function (kv) {
      var s = el("span");
      s.appendChild(document.createTextNode(kv[0] + " "));
      s.appendChild(el("b", null, kv[1]));
      info.appendChild(s);
    });

    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    var fname = v.dn.replace(/[\\/:*?"<>|·]/g, "").trim() +
      "_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".mp3";
    $("fileName").textContent = fname;
    st.fileName = fname;
  }

  function playBytes(bytes) {
    var blob = new Blob([bytes], { type: "audio/mpeg" });
    var url = URL.createObjectURL(blob);
    var a = $("audio");
    a.src = url;
    $("resultCard").style.display = "";
    $("resultFormat").textContent = "试听片段";
    a.play().catch(function () { /* 用户手势限制 */ });
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  function doDownload() {
    if (!st.result) { alertBox("还没有成品可下载。"); return; }
    var blob = new Blob([st.result.bytes], { type: "audio/mpeg" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = st.fileName || "speech.mp3";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  /* -------------------------------------------------------- 通道检测 */

  async function checkChannel() {
    var box = $("channel");
    box.className = "channel busy";
    $("channelText").textContent = "检测通道…";
    try {
      var r = await TtsEngine.checkChannel();
      box.className = "channel ok";
      $("channelText").textContent = "通道正常 · " + r.region + " · " + r.ms + "ms";
      return true;
    } catch (e) {
      box.className = "channel err";
      $("channelText").textContent = "通道不可用";
      alertBox("语音通道连接失败：" + e.message +
        "\n\n请检查网络（需能访问微软语音服务）。");
      return false;
    }
  }

  /* ------------------------------------------------------------ 绑定 */

  function bindRange(id, valId, fmt) {
    var r = $(id), out = $(valId);
    var sync = function () { out.textContent = fmt(r.value); };
    r.addEventListener("input", function () { sync(); savePrefs(); });
    sync();
  }

  function init() {
    // 顶部统计
    $("statVoices").textContent = Voices.total();
    $("statZh").textContent = Voices.zhCount();

    // 恢复偏好
    var p = loadPrefs();
    if (p) {
      if (p.voice && Voices.find(p.voice)) st.voice = p.voice;
      if (p.rate) $("rate").value = p.rate;
      if (p.pitch) $("pitch").value = p.pitch;
      if (p.volume) $("volume").value = p.volume;
      if (p.chunkSize) $("chunkSize").value = p.chunkSize;
      if (p.concurrency) $("concurrency").value = p.concurrency;
    }

    bindRange("rate", "rateVal", function (v) { return (v > 0 ? "+" : "") + v + "%"; });
    bindRange("pitch", "pitchVal", function (v) { return (v > 0 ? "+" : "") + v + "Hz"; });
    bindRange("volume", "volumeVal", function (v) { return (v > 0 ? "+" : "") + v + "%"; });
    bindRange("chunkSize", "chunkVal", function (v) { return v + " 字"; });
    bindRange("concurrency", "concVal", function (v) { return v; });

    renderTabs();
    renderVoices();
    selectVoice(st.voice);
    if (p && p.style) {
      setTimeout(function () {
        if ([].indexOf.call($("style").options, $("style").querySelector("[value='" + p.style + "']")) >= 0) {
          $("style").value = p.style;
        }
      }, 0);
    }

    // 事件
    $("voiceSearch").addEventListener("input", function (e) {
      st.query = e.target.value;
      st.page = 1;
      renderVoices();
    });
    $("btnMore").addEventListener("click", function () {
      st.page++;
      renderVoices();
    });
    $("style").addEventListener("change", savePrefs);
    $("text").addEventListener("input", scheduleStats);
    $("rate").addEventListener("input", scheduleStats); // 语速变了，预估时长跟着变
    $("chunkSize").addEventListener("input", scheduleStats);

    // ---- 读取文件：按钮 + 拖拽 ----
    $("fileInput").setAttribute("accept", FileLoader.ACCEPT);   // 与引擎里的支持列表保持单一来源
    $("btnFile").addEventListener("click", function () { $("fileInput").click(); });
    $("fileInput").addEventListener("change", function (e) {
      if (e.target.files && e.target.files.length) handleFiles(e.target.files);
    });

    var panel = $("editorPanel");
    panel.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      panel.classList.add("dragging");
    });
    panel.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    panel.addEventListener("dragleave", function (e) {
      if (!hasFiles(e)) return;
      dragDepth--;
      if (dragDepth <= 0) { dragDepth = 0; panel.classList.remove("dragging"); }
    });
    panel.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      panel.classList.remove("dragging");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
    // 拖到页面其他地方松手时，别让浏览器直接把文件当页面打开
    ["dragover", "drop"].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); });
    });

    $("btnPaste").addEventListener("click", async function () {
      try {
        var t = await navigator.clipboard.readText();
        if (t) { $("text").value = t; updateStats(); }
        else alertBox("剪贴板是空的。", "info");
      } catch (e) {
        alertBox("浏览器不允许直接读剪贴板，请手动 Ctrl+V 粘贴。", "info");
      }
    });
    $("btnClear").addEventListener("click", function () {
      $("text").value = "";
      updateStats();
      $("text").focus();
    });
    $("btnSample").addEventListener("click", function () {
      $("text").value = SAMPLE;
      updateStats();
    });

    $("btnPreview").addEventListener("click", doPreview);
    $("btnStart").addEventListener("click", doStart);
    $("btnCancel").addEventListener("click", function () {
      TtsEngine.cancel();
      alertBox("已取消。", "info");
    });
    $("btnDownload").addEventListener("click", doDownload);

    updateStats();
    checkChannel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 供自检使用
  window.__ui = {
    state: st, opts: opts, updateStats: updateStats,
    checkChannel: checkChannel, handleFiles: handleFiles,
  };
})();
