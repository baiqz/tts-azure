/**
 * mp3.js —— MP3 帧级解析与拼接
 *
 * 服务端对每个请求返回一段独立编码的 MPEG-2 Layer III / 24kHz / 48kbps / 单声道音频，
 * 帧长恒定（144 字节）。同构块可直接按帧边界字节拼接，无需重编码。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Mp3Tool = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BITRATE = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  var SAMPLE_RATE = {
    3: [44100, 48000, 32000], // MPEG-1
    2: [22050, 24000, 16000], // MPEG-2
    0: [11025, 12000, 8000],  // MPEG-2.5
  };

  /**
   * 读一个帧头，返回帧信息；不是合法帧头则返回 null。
   * @param {Uint8Array} b
   * @param {number} o 偏移
   */
  function readHeader(b, o) {
    if (o + 4 > b.length) return null;
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;

    var verBits = (b[o + 1] >> 3) & 0x03;  // 3=MPEG-1, 2=MPEG-2, 0=MPEG-2.5
    var layerBits = (b[o + 1] >> 1) & 0x03; // 1=Layer III
    var brIdx = (b[o + 2] >> 4) & 0x0f;
    var srIdx = (b[o + 2] >> 2) & 0x03;
    var pad = (b[o + 2] >> 1) & 0x01;

    if (verBits === 1) return null;          // 保留值
    if (layerBits === 0) return null;        // 保留值
    if (brIdx === 0 || brIdx === 15) return null; // 自由格式 / 非法
    if (srIdx === 3) return null;            // 保留值

    var ver = verBits === 3 ? 1 : 2;
    var layer = 4 - layerBits;               // 3=LayerI → 1, 1=LayerIII → 3
    var table = ver === 1 ? BITRATE[1] : BITRATE[2];
    var bitrate = table[brIdx] * 1000;
    var sampleRate = SAMPLE_RATE[verBits][srIdx];

    // 帧长：Layer I 以 4 字节槽为单位，Layer II/III 用 144(MPEG-1)/72(MPEG-2) 系数
    var length;
    if (layer === 1) {
      length = Math.floor((12 * bitrate / sampleRate + pad) * 4);
    } else {
      length = Math.floor((ver === 1 ? 144 : 72) * bitrate / sampleRate) + pad;
    }
    // 每帧承载的采样数（用于时长换算）
    var samples = layer === 1 ? 384 : (layer === 2 ? 1152 : (ver === 1 ? 1152 : 576));

    return {
      offset: o,
      version: ver === 1 ? 1 : 2,
      layer: layer,
      bitrate: bitrate,
      sampleRate: sampleRate,
      padding: pad,
      channels: ((b[o + 3] >> 6) & 0x03) === 3 ? 1 : 2,
      length: length,
      samples: samples,
    };
  }

  /**
   * 扫描一段数据，定位第一个有效帧头，并按帧前进到最后一个完整帧的结束位置。
   * @returns {{start:number,end:number,frames:number,info:object|null}}
   */
  function scan(b) {
    var start = -1, info = null;
    var limit = Math.min(b.length - 4, 4096); // 前导若有 ID3/垃圾，最多找 4KB
    for (var i = 0; i <= limit; i++) {
      var h = readHeader(b, i);
      if (h && h.length >= 24) {
        // 双帧校验，避免误判
        var h2 = readHeader(b, i + h.length);
        if (h2 && h2.length >= 24) { start = i; info = h; break; }
        if (i + h.length + 4 > b.length) { start = i; info = h; break; }
      }
    }
    if (start < 0) return { start: -1, end: -1, frames: 0, info: null };

    var pos = start, frames = 0;
    while (true) {
      var f = readHeader(b, pos);
      if (!f || pos + f.length > b.length) break;
      pos += f.length;
      frames++;
    }
    // 若只有一帧（极短文本），仍返回该帧
    if (frames === 0) {
      var single = readHeader(b, start);
      if (single && start + single.length <= b.length) {
        return { start: start, end: start + single.length, frames: 1, info: single };
      }
      return { start: -1, end: -1, frames: 0, info: null };
    }
    return { start: start, end: pos, frames: frames, info: info };
  }

  /** 去掉前导垃圾与尾部残帧，只留完整帧 */
  function toFrames(b) {
    var s = scan(b);
    if (s.start < 0) return { bytes: new Uint8Array(0), frames: 0, info: null };
    return { bytes: b.subarray(s.start, s.end), frames: s.frames, info: s.info };
  }

  /**
   * 把多段 MP3 按帧边界拼成一段。
   * @param {Uint8Array[]} chunks 顺序与播放顺序一致
   * @returns {{bytes:Uint8Array, frames:number, info:object|null, skipped:number[]}}
   */
  function concat(chunks) {
    var parts = [];
    var total = 0, frames = 0, info = null;
    var skipped = [];
    for (var i = 0; i < chunks.length; i++) {
      var r = toFrames(chunks[i]);
      if (r.frames === 0) { skipped.push(i); continue; }
      if (!info) info = r.info;
      parts.push(r.bytes);
      total += r.bytes.length;
      frames += r.frames;
    }
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
    }
    return { bytes: out, frames: frames, info: info, skipped: skipped };
  }

  /** 估算时长（秒） */
  function durationSec(bytesOrFrames, isFrames) {
    var frames = isFrames ? bytesOrFrames : Math.floor(bytesOrFrames / 144);
    return (frames * 576) / 24000;
  }

  /** 格式描述，便于诊断与断言 */
  function describe(info) {
    if (!info) return "未知";
    return (
      "MPEG-" + info.version + " Layer" +
      (info.layer === 3 ? "III" : info.layer === 2 ? "II" : "I") +
      " / " + (info.bitrate / 1000) + "kbps / " + info.sampleRate + "Hz / " +
      (info.channels === 1 ? "单声道" : "立体声") + " / 帧长" + info.length + "B"
    );
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  return {
    readHeader: readHeader,
    scan: scan,
    toFrames: toFrames,
    concat: concat,
    durationSec: durationSec,
    describe: describe,
    formatTime: formatTime,
  };
});
