/**
 * azure.js —— 语音通道（签名 + 换 token + 合成端点）
 *
 * 引擎与界面分离：浏览器与 Node 共用同一份代码，纯逻辑可离线单测。
 * 浏览器端必须用 referrerPolicy:"no-referrer" —— 服务端见到 Referer 会直接 401。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AzureChannel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ 常量 */

  // 通道内置密钥（base64 原始字节，参与 HMAC-SHA256）
  var APP_KEY_B64 =
    "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==";
  var ENDPOINT_URL = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  var AWS_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

  // 服务端输出固定为 MPEG-2 Layer III / 24kHz / 48kbps / 单声道
  var OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
  var FRAME_BYTES = 144; // 576 采样/帧 ÷ 8 × 48000 ÷ 24000

  /* ------------------------------------------------------------ 字节工具 */

  function b64ToBytes(b64) {
    if (typeof atob === "function") {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64")); // Node 兜底
  }

  function bytesToB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === "function") return btoa(bin);
    return Buffer.from(bytes).toString("base64");
  }

  function strToBytes(s) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, "utf-8"));
  }

  function bytesToStr(bytes) {
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString("utf-8");
  }

  function randomHex32() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "");
    }
    var s = "";
    for (var i = 0; i < 32; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    return s;
  }

  async function hmacSha256(keyBytes, msgBytes) {
    var key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
  }

  /* --------------------------------------------------------------- 签名 */

  /**
   * 生成 X-MT-Signature。
   * 格式：MSTranslatorAndroidApp::<base64签名>::<RFC1123 UTC 时间>::<32位hex>
   * @param {string} url 完整请求地址
   * @param {{now?:number|Date, uuid?:string}} [opts] 便于测试注入
   */
  async function makeSignature(url, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now) : new Date();
    var uid = opts.uuid || randomHex32();
    var date = now.toUTCString(); // "Thu, 15 Oct 2026 11:59:38 GMT"（与 RFC1123 一致）
    var encoded = encodeURIComponent(url.split("://")[1]);
    var msg = ("MSTranslatorAndroidApp" + encoded + date + uid).toLowerCase();
    var sig = await hmacSha256(b64ToBytes(APP_KEY_B64), strToBytes(msg));
    return "MSTranslatorAndroidApp::" + bytesToB64(sig) + "::" + date + "::" + uid;
  }

  /* ----------------------------------------------------------- token 管理 */

  var _cache = { token: null, region: null, expMs: 0 };
  var _inflight = null;
  var REFRESH_AHEAD_MS = 180 * 1000; // 提前 3 分钟续期

  function jwtExpMs(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var json = bytesToStr(b64ToBytes(part));
      var exp = JSON.parse(json).exp;
      if (exp) return exp * 1000;
    } catch (e) { /* 解析失败走兜底 */ }
    return Date.now() + 30 * 60 * 1000;
  }

  async function requestEndpoint() {
    var sig = await makeSignature(ENDPOINT_URL);
    var res = await fetch(ENDPOINT_URL, {
      method: "POST",
      referrerPolicy: "no-referrer", // ★ 关键：带 Referer 会被判 401
      headers: {
        "Accept-Language": "zh-Hans",
        "X-ClientVersion": "4.0.530a 5fe1dc6c",
        "X-UserId": "0f04d16a175c411e",
        "X-HomeGeographicRegion": "zh-Hans-CN",
        "X-ClientTraceId": randomHex32(),
        "X-MT-Signature": sig,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    if (!res.ok) {
      var detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
      throw new Error("获取语音通道失败（HTTP " + res.status + "）" + (detail ? "：" + detail : ""));
    }
    var data = await res.json();
    if (!data || !data.t || !data.r) throw new Error("语音通道返回数据不完整");
    _cache = { token: data.t, region: data.r, expMs: jwtExpMs(data.t) };
    return _cache;
  }

  /** 取当前可用的 token（缓存 + 单例锁，避免并发重复请求） */
  async function getToken(force) {
    var now = Date.now();
    if (!force && _cache.token && now < _cache.expMs - REFRESH_AHEAD_MS) return _cache;
    if (_inflight) return _inflight;
    _inflight = requestEndpoint();
    try {
      return await _inflight;
    } finally {
      _inflight = null;
    }
  }

  function peekCache() {
    return { hasToken: !!_cache.token, region: _cache.region, expMs: _cache.expMs };
  }

  function resetCache() {
    _cache = { token: null, region: null, expMs: 0 };
    _inflight = null;
  }

  /* --------------------------------------------------------------- 合成 */

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * 拼一段 SSML。
   * @param {object} o {text, voice, locale, style, rate, pitch, volume}
   */
  function buildSsml(o) {
    var locale = o.locale || "zh-CN";
    var prosody =
      "<prosody rate='" + pct(o.rate) + "' pitch='" + hz(o.pitch) + "' volume='" + pct(o.volume) + "'>" +
      escapeXml(o.text) +
      "</prosody>";
    var body = o.style
      ? "<mstts:express-as style='" + escapeXml(o.style) + "'>" + prosody + "</mstts:express-as>"
      : prosody;
    var ns = o.style ? " xmlns:mstts='https://www.w3.org/2001/mstts'" : "";
    return (
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'" + ns +
      " xml:lang='" + locale + "'>" +
      "<voice name='" + escapeXml(o.voice) + "'>" + body + "</voice>" +
      "</speak>"
    );
  }

  function pct(v) {
    var n = Number(v) || 0;
    return (n >= 0 ? "+" : "") + n.toFixed(0) + "%";
  }

  function hz(v) {
    var n = Number(v) || 0;
    return (n >= 0 ? "+" : "") + n.toFixed(0) + "Hz";
  }

  /**
   * 合成一段文本，返回 Uint8Array(MP3)。
   * @param {string} text
   * @param {object} opts {voice, locale, style, rate, pitch, volume}
   */
  async function synthesize(text, opts) {
    var o = Object.assign({}, opts, { text: text });
    var ssml = buildSsml(o);
    var lastErr = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      var cred = await getToken(attempt > 0); // 失败重试时强制换 token
      var url = "https://" + cred.region + ".tts.speech.microsoft.com/cognitiveservices/v1";
      var res;
      try {
        res = await fetch(url, {
          method: "POST",
          referrerPolicy: "no-referrer",
          headers: {
            Authorization: cred.token,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          },
          body: ssml,
        });
      } catch (e) {
        lastErr = new Error("网络请求失败：" + e.message);
        continue;
      }
      if (res.ok) {
        var buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 0) return buf;
        lastErr = new Error("服务端返回了空音频（该音色可能已下架）");
        continue;
      }
      var msg = "";
      try { msg = (await res.text()).slice(0, 300); } catch (e2) { /* 忽略 */ }
      if (res.status === 401 || res.status === 403) {
        resetCache();
        lastErr = new Error("语音通道鉴权失效（HTTP " + res.status + "）");
        continue;
      }
      if (res.status === 429) {
        lastErr = new Error("请求过于频繁被限流（HTTP 429），请稍后重试或减少并发");
        await sleep(800 * (attempt + 1));
        continue;
      }
      lastErr = new Error("合成失败（HTTP " + res.status + "）" + (msg ? "：" + msg : ""));
      if (/not support|unsupported|voice/i.test(msg)) break; // 音色不支持，重试无意义
    }
    throw lastErr || new Error("合成失败");
  }

  /** 拉取服务端音色清单（同一通道） */
  async function listVoices() {
    var cred = await getToken();
    var url = "https://" + cred.region + ".tts.speech.microsoft.com/cognitiveservices/voices/list";
    var res = await fetch(url, {
      method: "GET",
      referrerPolicy: "no-referrer",
      headers: { Authorization: cred.token },
    });
    if (!res.ok) throw new Error("获取音色清单失败（HTTP " + res.status + "）");
    return await res.json();
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* --------------------------------------------------------------- 导出 */

  return {
    ENDPOINT_URL: ENDPOINT_URL,
    APP_KEY_B64: APP_KEY_B64,
    OUTPUT_FORMAT: OUTPUT_FORMAT,
    FRAME_BYTES: FRAME_BYTES,
    UA: AWS_UA,
    makeSignature: makeSignature,
    getToken: getToken,
    peekCache: peekCache,
    resetCache: resetCache,
    buildSsml: buildSsml,
    escapeXml: escapeXml,
    synthesize: synthesize,
    listVoices: listVoices,
    jwtExpMs: jwtExpMs,
    b64ToBytes: b64ToBytes,
    bytesToB64: bytesToB64,
    strToBytes: strToBytes,
  };
});
