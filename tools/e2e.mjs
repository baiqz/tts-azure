/**
 * e2e.mjs —— 无头 Edge 真机端到端验证
 *
 * 走完整用户流程：加载 → 选音色 → 输入 → 合成 → 校验成品 → 截图。
 * 支持 E2E_LIVE_URL 直打线上网址（部署后必做的一步）。
 *
 * 用法：
 *   node tools/e2e.mjs
 *   E2E_LIVE_URL=https://xxx.github.io/tts-azure/ node tools/e2e.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const LIVE = process.env.E2E_LIVE_URL || "";
const FILE_MODE = process.env.E2E_FILE === "1";
const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const PORT = 5388;
const DBG = 9388;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg", ".png": "image/png", ".ico": "image/x-icon",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const FAILS = [];
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log("  ✓ " + msg); }
  else { FAIL++; FAILS.push(msg); console.log("  ✗ " + msg + (extra ? "  → " + extra : "")); }
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method) for (const fn of this.listeners) fn(m);
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " 超时")); } }, 180000);
    });
  }
}

async function waitDebugger(port, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch { /* 继续等 */ }
    await sleep(250);
  }
  throw new Error("调试端口未就绪");
}

async function main() {
  let server = null;
  let target;
  if (FILE_MODE) {
    target = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
    console.log("模式：本地 file:// 双击打开");
  } else if (LIVE) {
    target = LIVE;
    console.log(`模式：直打线上 ${LIVE}`);
  } else {
    server = await startServer(PORT);
    target = `http://127.0.0.1:${PORT}/index.html`;
    console.log(`[1] 本地服务 http://127.0.0.1:${PORT}`);
  }

  const profile = path.join(os.tmpdir(), `edge-e2e-${Date.now()}`);
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-proxy-server", "--autoplay-policy=no-user-gesture-required",
    `--user-agent=${REAL_UA}`, `--remote-debugging-port=${DBG}`,
    "--user-data-dir=" + profile, "--window-size=1440,1500", "about:blank",
  ], { stdio: "ignore" });

  const errors = [];
  let cdp, sid;
  try {
    const info = await waitDebugger(DBG);
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("连不上调试端口"))); });
    cdp = new CDP(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    sid = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    console.log("[2] 已连接浏览器");

    cdp.on((m) => {
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      }
    });
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false }, sid);

    const ev = async (expr, awaitPromise = true) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, sec, label) => {
      const end = Date.now() + sec * 1000;
      while (Date.now() < end) {
        try { if (await ev(expr, false)) return true; } catch { /* 继续等 */ }
        await sleep(400);
      }
      throw new Error("等待超时：" + label);
    };

    await cdp.send("Page.navigate", { url: target }, sid);
    console.log(`[3] 已打开 ${target}`);
    await waitFor("!!window.__ui", 30, "页面初始化");

    /* --------------------------------------------- 1. 加载与通道 */
    console.log("\n── 加载与通道 ──");
    await waitFor("document.getElementById('channel').className.indexOf('ok')>=0 || document.getElementById('channel').className.indexOf('err')>=0", 40, "通道检测");
    const chan = await ev("document.getElementById('channelText').textContent");
    ok(/通道正常/.test(chan), "语音通道检测通过（" + chan + "）");
    const counts = await ev("({v:document.getElementById('statVoices').textContent, z:document.getElementById('statZh').textContent, n:document.querySelectorAll('#voiceList .voice').length, tabs:document.querySelectorAll('#voiceTabs .tab').length})");
    console.log("   音色总数 " + counts.v + "，中文 " + counts.z + "，列表首屏 " + counts.n + "，分组 " + counts.tabs);
    ok(Number(counts.v) === 958, "内置音色 958 种");
    ok(Number(counts.z) >= 90, "中文音色 ≥ 90");
    ok(counts.n > 0, "音色列表已渲染");
    ok(counts.tabs >= 6, "分组按钮已渲染");

    /* --------------------------------------------- 2. 音色交互 */
    console.log("\n── 音色选择 ──");
    await ev("(function(){var i=document.getElementById('voiceSearch');i.value='云泽';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    await sleep(300);
    const searched = await ev("({n:document.querySelectorAll('#voiceList .voice').length, first:document.querySelector('#voiceList .voice .vname')?document.querySelector('#voiceList .voice .vname').textContent:''})");
    ok(searched.n >= 1, "搜索『云泽』有结果");
    ok(/云泽/.test(searched.first), "搜索首位是云泽（" + searched.first + "）");

    await ev("document.getElementById('voiceList').querySelector('.voice').click()", false);
    await sleep(200);
    const after = await ev("({cur:document.getElementById('curVoice').textContent, styles:document.getElementById('style').options.length, styleHint:document.getElementById('styleCount').textContent})");
    ok(/云泽/.test(after.cur), "已选中云泽：" + after.cur);
    ok(after.styles >= 10, "风格下拉已填充（" + (after.styles - 1) + " 种 + 默认项）");
    ok(/9 种/.test(after.styleHint), "云泽标注 9 种风格：" + after.styleHint);

    // 清空搜索，切到"普通话"分组
    await ev("(function(){var i=document.getElementById('voiceSearch');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    await sleep(250);
    await ev("(function(){var ts=document.querySelectorAll('#voiceTabs .tab');for(var i=0;i<ts.length;i++){if(ts[i].textContent.indexOf('普通话')===0){ts[i].click();return 1}}return 0})()", false);
    await sleep(300);
    const cnTab = await ev("document.querySelector('#voiceTabs .tab.on').textContent");
    ok(/普通话/.test(cnTab), "分组切换成功：" + cnTab);
    const moreVisible = await ev("(function(){var b=document.getElementById('btnMore');var l=document.getElementById('voiceList');return {shown:b.getBoundingClientRect().height>0, outside:!l.contains(b), text:b.textContent}})()");
    ok(moreVisible.outside, "『显示更多』在滚动区之外（不会被埋没）");
    ok(moreVisible.shown, "『显示更多』可见：" + moreVisible.text);

    fs.mkdirSync(path.join(ROOT, "_verify"), { recursive: true });
    const shotV = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(path.join(ROOT, "_verify", "e2e-voices.png"), Buffer.from(shotV.data, "base64"));

    /* --------------------------------------------- 3. 选风格 */
    console.log("\n── 参数 ──");
    await ev("(function(){var i=document.getElementById('voiceSearch');i.value='云泽';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    await sleep(250);
    await ev("document.getElementById('voiceList').querySelector('.voice').click()", false);
    await sleep(150);
    await ev("(function(){var s=document.getElementById('style');s.value='documentary-narration';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()", false);
    await ev("(function(){var r=document.getElementById('rate');r.value='-20';r.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    const rateLabel = await ev("document.getElementById('rateVal').textContent");
    ok(rateLabel === "-20%", "语速标注与实际一致（" + rateLabel + "）");
    const styleVal = await ev("document.getElementById('style').value");
    ok(styleVal === "documentary-narration", "风格已选中：" + styleVal);

    // 语速变化必须影响预估时长
    await ev("(function(){var t=document.getElementById('text');t.value=Array(201).join('测试。');t.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    await sleep(350);
    const tSlow = await ev("document.getElementById('sTime').textContent");
    await ev("(function(){var r=document.getElementById('rate');r.value='100';r.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);
    await sleep(350);
    const tFast = await ev("document.getElementById('sTime').textContent");
    ok(tSlow !== tFast, `语速影响预估时长（-20% → ${tSlow}，+100% → ${tFast}）`);
    await ev("(function(){var r=document.getElementById('rate');r.value='-20';r.dispatchEvent(new Event('input',{bubbles:true}));return 1})()", false);

    /* --------------------------------------------- 4. 试听 */
    console.log("\n── 试听 ──");
    await ev("document.getElementById('btnSample').click()", false);
    await sleep(300);
    const stats = await ev("({c:document.getElementById('sChars').textContent, k:document.getElementById('sChunks').textContent, t:document.getElementById('sTime').textContent})");
    console.log("   示例文本：" + stats.c + " 字 / " + stats.k + " 段 / 约 " + stats.t);
    ok(Number(stats.c.replace(/,/g, "")) > 100, "字数统计工作");
    ok(Number(stats.k) >= 1, "分段统计工作");

    await ev("document.getElementById('btnPreview').click()", false);
    await waitFor("document.getElementById('resultCard').offsetHeight>0 && document.getElementById('audio').src.indexOf('blob:')===0", 90, "试听");
    await waitFor("document.getElementById('btnStart').disabled===false", 90, "试听结束");
    const pv = await ev("({fmt:document.getElementById('resultFormat').textContent, visible:document.getElementById('resultCard').offsetHeight>0, src:document.getElementById('audio').src.slice(0,5), alert:document.getElementById('alert').textContent})");
    ok(pv.visible, "结果卡片真实可见（offsetHeight > 0）");
    ok(pv.src === "blob:", "试听音频已生成 blob");
    ok(/试听/.test(pv.fmt), "标记为试听片段：" + pv.fmt);
    console.log("   提示：" + pv.alert.replace(/\n/g, " / "));

    /* --------------------------------------------- 5. 长文本整篇合成 */
    console.log("\n── 长文本合成（验证不限字数）──");
    const LONG = "这是一段用来验证不限字数的测试文字。工具会把它按句子切开，分几段同时合成，再拼成一条完整的音频。".repeat(24);
    console.log("   输入 " + LONG.length + " 字");
    await ev(`(function(){var t=document.getElementById('text');t.value=${JSON.stringify(LONG)};t.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`, false);
    await sleep(400);
    const longStats = await ev("({c:document.getElementById('sChars').textContent, k:document.getElementById('sChunks').textContent, t:document.getElementById('sTime').textContent, s:document.getElementById('sSize').textContent})");
    console.log("   统计：" + longStats.c + " 字 / " + longStats.k + " 段 / 约 " + longStats.t + " / 约 " + longStats.s);
    ok(Number(longStats.k) > 1, "长文本被切成多段（" + longStats.k + " 段）");

    await ev("document.getElementById('btnStart').click()", false);
    // 合成可能非常快（几秒），必须在它收工前轮询，否则会误判进度条不可见
    let sawProgress = false, maxPercent = 0;
    const pEnd = Date.now() + 60000;
    while (Date.now() < pEnd) {
      const s = await ev("({p:document.getElementById('progressWrap').offsetHeight>0, run:document.getElementById('btnStart').disabled, pc:document.getElementById('progressBar').style.width})", false);
      if (s.p) sawProgress = true;
      const n = parseInt(s.pc, 10);
      if (!isNaN(n) && n > maxPercent) maxPercent = n;
      if (!s.run) break;
      await sleep(100);
    }
    ok(sawProgress, "进度条真实可见");
    console.log("   进度条推进到 " + maxPercent + "%");
    await waitFor("document.getElementById('btnStart').disabled===false", 300, "整篇合成");
    const res = await ev(`(function(){
      var a=document.getElementById('audio');
      var info=document.getElementById('resultInfo').textContent;
      return {visible:document.getElementById('resultCard').offsetHeight>0,
              src:a.src.slice(0,5), duration:a.duration, fmt:document.getElementById('resultFormat').textContent,
              info:info, file:document.getElementById('fileName').textContent,
              alert:document.getElementById('alert').textContent,
              alertKind:document.getElementById('alert').className};
    })()`);
    console.log("   成品：" + res.info);
    console.log("   提示：" + res.alert);
    ok(res.visible, "成品卡片可见");
    ok(res.src === "blob:", "成品音频已生成");
    ok(/MPEG-2/.test(res.fmt), "格式为 MPEG-2：" + res.fmt);
    ok(res.duration > 60, "音频时长合理（" + res.duration.toFixed(1) + " 秒）");
    ok(/good/.test(res.alertKind), "提示为成功态");
    ok(/\.mp3$/.test(res.file), "文件名带 .mp3：" + res.file);

    // 时长与字数是否匹配：本次语速设为 -20%，故预期 = 字数 / 4.6 / 0.8
    const expect = Number(longStats.c.replace(/,/g, "")) / 4.6 / 0.8;
    const diff = Math.abs(res.duration - expect) / expect;
    ok(diff < 0.12, `时长与字数匹配（预期 ~${expect.toFixed(0)}s，实际 ${res.duration.toFixed(0)}s，偏差 ${(diff * 100).toFixed(1)}%）`);

    // 帧数必须与时长自洽（帧数 × 576 / 24000 = 秒）
    const frames = Number(/音频帧\s*([\d,]+)/.exec(res.info)[1].replace(/,/g, ""));
    const byFrames = frames * 576 / 24000;
    ok(Math.abs(byFrames - res.duration) < 1.0, `帧数与时长自洽（${frames} 帧 × 576 / 24000 = ${byFrames.toFixed(1)}s）`);
    const sizeMB = Number(/大小\s*([\d.]+)\s*MB/.exec(res.info)[1]);
    const calcMB = frames * 144 / 1024 / 1024;
    ok(Math.abs(calcMB - sizeMB) < 0.15, `字节数与帧数自洽（${frames} × 144B = ${calcMB.toFixed(2)}MB，界面显示 ${sizeMB}MB）`);

    // 分段数与字数吻合
    const infoChunks = /分段\s*(\d+)\s*段/.exec(res.info);
    ok(infoChunks && Number(infoChunks[1]) === Number(longStats.k), "成品分段数与预估一致（" + (infoChunks ? infoChunks[1] : "?") + "）");

    /* --------------------------------------------- 6. 拼接是否无缝 */
    console.log("\n── 拼接连续性（解码成品查缺口）──");
    const ac = await ev(`(async function(){
      try {
        var a = document.getElementById('audio');
        var resp = await fetch(a.src);
        var ab = await resp.arrayBuffer();
        var AC = window.AudioContext || window.webkitAudioContext;
        var ctx = new AC();
        var buf = await ctx.decodeAudioData(ab);
        var d = buf.getChannelData(0);
        var sr = buf.sampleRate;
        var win = Math.max(1, Math.floor(sr * 0.02)); // 20ms 一格
        var maxSil = 0, cur = 0, peak = 0, sum = 0, n = 0;
        for (var i = 0; i + win <= d.length; i += win) {
          var s = 0;
          for (var j = 0; j < win; j++) { var v = d[i + j]; s += v * v; }
          var r = Math.sqrt(s / win);
          if (r > peak) peak = r;
          sum += r; n++;
          if (r < 0.002) { cur++; if (cur > maxSil) maxSil = cur; } else cur = 0;
        }
        return { ok: true, duration: buf.duration, sr: sr, maxSilence: maxSil * 0.02,
                 peak: peak, avg: sum / n, samples: d.length, framesDecoded: Math.round(buf.duration * sr) };
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    })()`);
    if (!ac.ok) {
      ok(false, "音频可解码", ac.error);
    } else {
      console.log(`   解码：${ac.duration.toFixed(1)}s / ${ac.sr}Hz / 峰值 ${ac.peak.toFixed(3)} / 均值 ${ac.avg.toFixed(4)}`);
      ok(Math.abs(ac.duration - res.duration) < 0.5, `解码时长与播放器一致（${ac.duration.toFixed(1)}s vs ${res.duration.toFixed(1)}s）`);
      ok(ac.peak > 0.05, "音频有实际声音（峰值 " + ac.peak.toFixed(3) + "）");
      ok(ac.avg > 0.005, "整体能量正常（均值 " + ac.avg.toFixed(4) + "）");
      ok(ac.maxSilence < 1.5, `没有异常断层：最长静音 ${ac.maxSilence.toFixed(2)}s（拼接缝未产生空洞）`);
    }

    /* --------------------------------------------- 7. 下载 */
    console.log("\n── 下载 ──");
    const dl = await ev(`(function(){
      var b=document.getElementById('btnDownload');
      return {visible:b.offsetHeight>0, disabled:b.disabled, text:b.textContent};
    })()`);
    ok(dl.visible && !dl.disabled, "下载按钮可用（" + dl.text + "）");

    /* --------------------------------------------- 8. 超大文本压力测试 */
    console.log("\n── 超大文本压力测试 ──");
    const HUGE = "不限字数不是口号，而是这套流程的自然结果：文字被切成小段并行合成，最后按音频帧边界拼成一条，所以长度只影响段数、不影响可行性。".repeat(120);
    console.log("   输入 " + HUGE.length + " 字");
    await ev(`(function(){var t=document.getElementById('text');t.value=${JSON.stringify(HUGE)};t.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`, false);
    await sleep(500);
    const hs = await ev("({c:document.getElementById('sChars').textContent, k:document.getElementById('sChunks').textContent, t:document.getElementById('sTime').textContent, s:document.getElementById('sSize').textContent})");
    console.log("   统计：" + hs.c + " 字 / " + hs.k + " 段 / 约 " + hs.t + " / 约 " + hs.s);
    ok(Number(hs.k) >= 8, "超大文本被切成 ≥8 段（" + hs.k + " 段）");
    const t1 = Date.now();
    await ev("document.getElementById('btnStart').click()", false);
    await waitFor("document.getElementById('btnStart').disabled===false", 420, "超大文本合成");
    const hugeMs = Date.now() - t1;
    // audio.duration 在元数据加载完之前是 NaN，而 NaN 经 CDP 序列化回来会变成 null
    await waitFor("isFinite(document.getElementById('audio').duration) && document.getElementById('audio').duration > 0", 30, "成品元数据");
    const hr = await ev(`(function(){
      var info=document.getElementById('resultInfo').textContent;
      return {info:info, duration:document.getElementById('audio').duration,
              alert:document.getElementById('alert').textContent,
              kind:document.getElementById('alert').className};
    })()`);
    console.log("   成品：" + hr.info);
    console.log("   耗时：" + (hugeMs / 1000).toFixed(1) + " 秒");
    ok(/good/.test(hr.kind), "超大文本合成成功");
    const hChars = Number(hs.c.replace(/,/g, ""));
    const hExpect = hChars / 4.6 / 0.8;
    ok(Math.abs(hr.duration - hExpect) / hExpect < 0.12,
      `超大文本时长匹配（预期 ~${hExpect.toFixed(0)}s，实际 ${hr.duration.toFixed(0)}s）`);
    ok(hugeMs < 120000, "耗时在合理范围（" + (hugeMs / 1000).toFixed(1) + " 秒，约 " + (hChars / (hugeMs / 1000)).toFixed(0) + " 字/秒）");

    /* --------------------------------------------- 9. 读取文件 */
    console.log("\n── 读取文件（真实 File 对象走 change 事件）──");

    // 工具条从 3 个按钮变成 4 个，先确认排版没挤坏
    const toolBtns = await ev(`[].slice.call(document.querySelectorAll('.phead-tools .btn')).map(function(b){
      var r = b.getBoundingClientRect();
      return { text: b.textContent, x: r.x, y: r.y, w: r.width, h: r.height,
               overflow: b.scrollWidth - b.clientWidth };
    })`);
    ok(toolBtns.length === 4, "文本工具条共 4 个按钮（含「读取文件」）");
    ok(toolBtns.some((b) => b.text === "读取文件"), "「读取文件」按钮存在");
    ok(toolBtns.every((b) => b.w > 0 && b.h > 0), "每个按钮都真实可见");
    ok(toolBtns.every((b) => b.overflow <= 1), "按钮文字没有被裁掉");
    let overlap = false;
    for (const a of toolBtns) {
      for (const b of toolBtns) {
        if (a === b) continue;
        if (Math.abs(a.y - b.y) < 2 && a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1) overlap = true;
      }
    }
    ok(!overlap, "工具条按钮之间没有重叠");

    const fixtureB64 = (p) => fs.readFileSync(path.join(ROOT, "tests", "fixtures", p)).toString("base64");

    // 在页面里把 base64 还原成真实 File，塞进 input 并派发 change —— 走的就是用户选文件那条路径
    const putFiles = async (items) => ev(`(async function(){
      var items = ${JSON.stringify(items)};
      function u8(b64){ var bin = atob(b64); var a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
      var dt = new DataTransfer();
      items.forEach(function(it){ dt.items.add(new File([u8(it.b64)], it.name, { type: it.type })); });
      var inp = document.getElementById("fileInput");
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      return dt.files.length;
    })()`);

    await ev(`document.getElementById('btnClear').click()`);
    await sleep(200);

    const sent = await putFiles([
      { b64: fixtureB64("sample_gbk.txt"), name: "GBK文稿.txt", type: "text/plain" },
      { b64: fixtureB64("sample.docx"), name: "合同.docx", type: "" },
    ]);
    ok(sent === 2, "两个文件已通过 change 事件投递");

    await waitFor("document.getElementById('btnFile').disabled===false && document.getElementById('text').value.length>0", 40, "文件读取完成");

    const fr = await ev(`(function(){
      var t = document.getElementById('text').value;
      var a = document.getElementById('alert');
      return {
        text: t,
        chars: document.getElementById('sChars').textContent,
        chunks: document.getElementById('sChunks').textContent,
        alert: a.textContent,
        kind: a.className,
        visible: a.offsetHeight > 0,
        btn: document.getElementById('btnFile').textContent,
        accept: document.getElementById('fileInput').getAttribute('accept')
      };
    })()`);

    ok(fr.text.indexOf("这是一份用来测编码的文稿。") >= 0, "GBK 文本被正确解码读入（没有乱码）");
    ok(fr.text.indexOf("\ufffd") < 0, "读入内容不含替换字符（编码判断正确）");
    ok(fr.text.indexOf("第一段：这是 Word 文档里的正文。") >= 0, "docx 正文被读入");
    ok(fr.text.indexOf("这段是修订删除的内容") < 0, "docx 的修订删除内容没有混进来");
    ok(fr.text.indexOf("<w:") < 0, "docx 没有把 XML 标签带进来");
    ok(/已读入 2 个文件/.test(fr.alert), "提示说明读入数量：" + fr.alert.split("\n")[0]);
    ok(/GBK/.test(fr.alert), "提示标明识别到的编码");
    ok(/Word 文档/.test(fr.alert), "提示标明文件类型");
    ok(fr.visible && /good/.test(fr.kind), "读取结果提示真实可见且为成功态");
    ok(fr.btn === "读取文件", "按钮文案正确");
    ok(fr.accept.indexOf(".docx") >= 0, "accept 已与实际支持列表同步");
    ok(Number(fr.chars.replace(/,/g, "")) > 0, "字数统计已刷新：" + fr.chars);
    ok(Number(fr.chunks) >= 1, "分段统计已刷新：" + fr.chunks);

    // 已有内容时应当是「追加」，不能把用户刚写的东西冲掉
    const lenBefore = fr.text.length;
    await putFiles([{ b64: fixtureB64("sample_utf8.txt"), name: "再读一份.txt", type: "text/plain" }]);
    await waitFor("document.getElementById('btnFile').disabled===false", 40, "第二次读取");
    await sleep(200);
    const appended = await ev(`document.getElementById('text').value`);
    ok(appended.length > lenBefore, "第二次读取是追加而不是覆盖");
    ok((appended.match(/这是一份用来测编码的文稿。/g) || []).length === 2,
      "原有内容仍在，且新内容只加了一次");
    ok(appended.indexOf("合同") < 0, "文件名不会混进正文");

    // 读不了的文件必须说人话，且不能往文本框塞垃圾
    await ev(`document.getElementById('btnClear').click()`);
    await sleep(150);
    await putFiles([{ b64: fixtureB64("sample_utf8.txt"), name: "读不了的.pdf", type: "application/pdf" }]);
    await waitFor("document.getElementById('btnFile').disabled===false", 40, "PDF 处理");
    await sleep(200);
    const bad = await ev(`(function(){
      var a = document.getElementById('alert');
      return { text: a.textContent, visible: a.offsetHeight > 0, box: document.getElementById('text').value };
    })()`);
    ok(bad.visible, "失败提示真实可见");
    ok(/读不了/.test(bad.text), "PDF 给出明确失败原因");
    ok(/另存为|复制/.test(bad.text), "PDF 提示里带了替代办法");
    ok(bad.box === "", "失败时不会往文本框里塞东西");

    // 拖拽路径：dragenter → 提示出现 → drop → 读入
    const drag = await ev(`(function(){
      var enc = new TextEncoder();
      var content = "1\\n00:00:01,000 --> 00:00:04,000\\n第一句台词\\n\\n2\\n00:00:05,000 --> 00:00:09,000\\n第二句台词\\n";
      var dt = new DataTransfer();
      dt.items.add(new File([enc.encode(content)], "字幕.srt", { type: "text/plain" }));
      var panel = document.getElementById('editorPanel');
      var hint = document.getElementById('dropHint');
      panel.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      var during = {
        dragging: panel.classList.contains('dragging'),
        hintClass: hint.className,
        hintH: hint.offsetHeight
      };
      panel.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
      return { during: during, afterDragging: panel.classList.contains('dragging') };
    })()`);

    ok(drag.during.dragging, "拖拽悬停时面板进入拖拽态");
    ok(drag.during.hintH > 0, "拖拽提示真的显示出来了（offsetHeight=" + drag.during.hintH + "）");
    ok(!drag.afterDragging, "松手后拖拽态解除");

    await waitFor("document.getElementById('btnFile').disabled===false && document.getElementById('text').value.length>0", 40, "拖拽读取完成");
    await sleep(200);
    const dropped = await ev(`(function(){
      var t = document.getElementById('text').value;
      var a = document.getElementById('alert');
      return { text: t, alert: a.textContent, hintH: document.getElementById('dropHint').offsetHeight };
    })()`);
    ok(dropped.hintH === 0, "松手后拖拽提示已隐藏");
    ok(dropped.text.indexOf("第一句台词") >= 0 && dropped.text.indexOf("第二句台词") >= 0, "拖入的字幕被读入");
    ok(dropped.text.indexOf("-->") < 0, "字幕时间轴已被剥离");
    ok(/已去时间轴/.test(dropped.alert), "提示标明已去时间轴");

    /* --------------------------------------------- 10. 无异常 */
    console.log("\n── 运行期异常 ──");
    ok(errors.length === 0, "全程无未捕获异常", errors.slice(0, 2).join(" | "));

    /* --------------------------------------------- 截图 */
    fs.mkdirSync(path.join(ROOT, "_verify"), { recursive: true });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sid);
    const shotPath = path.join(ROOT, "_verify", LIVE ? "e2e-live.png" : FILE_MODE ? "e2e-file.png" : "e2e.png");
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("\n[4] 截图 → " + path.relative(ROOT, shotPath));
  } catch (e) {
    FAIL++; FAILS.push("执行中断：" + e.message);
    console.error("\n执行中断：" + e.message);
    if (errors.length) console.error("页面异常：" + errors.join("\n"));
  } finally {
    try { cdp?.ws.close(); } catch { /* 忽略 */ }
    edge.kill();
    server?.close();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log("\n" + "═".repeat(50));
  console.log(`  通过 ${PASS} 项，失败 ${FAIL} 项`);
  console.log("═".repeat(50));
  if (FAIL) { FAILS.forEach((f) => console.log("  · " + f)); process.exit(1); }
}

main();
