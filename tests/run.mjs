/**
 * run.mjs —— 离线单测（签名对齐 / 切分 / 帧拼接 / 音色库）
 *
 * 不依赖网络，直接用真实音频 fixture 与 Python 参考实现产出的向量比对。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const Azure = require("../src/azure.js");
const Mp3 = require("../src/mp3.js");
const Split = require("../src/split.js");
const Voices = require("../src/voices.js");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); console.log("  ✗ " + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }
function section(t) { console.log("\n── " + t + " ──"); }

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));

/* ====================================================== 1. 签名对齐 */
section("签名：与 Python 参考实现逐字节对齐");
for (const v of vectors.sign) {
  const got = await Azure.makeSignature(v.url, { now: v.nowMs, uuid: v.uuid });
  eq(got, v.expect, `向量 ${v.nowMs}/${v.uuid.slice(0, 8)}`);
}
{
  const s = await Azure.makeSignature(Azure.ENDPOINT_URL);
  const parts = s.split("::");
  eq(parts.length, 4, "签名由 3 个 :: 分成 4 段");
  eq(parts[0], "MSTranslatorAndroidApp", "前缀正确");
  eq(parts[1].length, 44, "base64 签名长度 44（32 字节 digest）");
  ok(/^[A-Za-z0-9+/]{43}=$/.test(parts[1]), "签名是合法 base64");
  eq(parts[3].length, 32, "uuid 为 32 位");
  ok(/^[0-9a-f]{32}$/.test(parts[3]), "uuid 为小写 hex");
  ok(/GMT$/.test(parts[2]), "日期以 GMT 结尾");
  ok(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(parts[2]),
    `日期符合 RFC1123（实际 ${parts[2]}）`);
}
{
  // 大小写不敏感性：整串参与签名的消息已 toLowerCase
  const a = await Azure.makeSignature("https://X.COM/Path?A=B", { now: 1792060800000, uuid: "00000000000000000000000000000000" });
  const b = await Azure.makeSignature("https://x.com/Path?A=B", { now: 1792060800000, uuid: "00000000000000000000000000000000" });
  eq(a.split("::")[1], b.split("::")[1], "签名对大小写不敏感（消息已小写化）");
}

/* ====================================================== 2. SSML */
section("SSML 生成与转义");
{
  const s = Azure.buildSsml({ text: "a & b < c > d \" e ' f", voice: "zh-CN-YunzeNeural", locale: "zh-CN", rate: 0, pitch: 0, volume: 0 });
  ok(s.indexOf("&amp;") >= 0, "& 被转义");
  ok(s.indexOf("&lt;") >= 0 && s.indexOf("&gt;") >= 0, "< > 被转义");
  ok(s.indexOf("&quot;") >= 0 && s.indexOf("&apos;") >= 0, "引号被转义");
  ok(s.indexOf("<voice name='zh-CN-YunzeNeural'>") >= 0, "voice 标签正确");
  ok(s.indexOf("xml:lang='zh-CN'") >= 0, "locale 正确");
  ok(s.indexOf("mstts") < 0, "无风格时不引入 mstts 命名空间");
}
{
  const s = Azure.buildSsml({ text: "x", voice: "zh-CN-YunzeNeural", locale: "zh-CN", style: "documentary-narration", rate: 10, pitch: -5, volume: 20 });
  ok(s.indexOf("mstts:express-as") >= 0, "有风格时使用 mstts:express-as");
  ok(s.indexOf("xmlns:mstts='https://www.w3.org/2001/mstts'") >= 0, "mstts 命名空间已声明");
  ok(s.indexOf("rate='+10%'") >= 0, "语速格式化带正号");
  ok(s.indexOf("pitch='-5Hz'") >= 0, "音调格式化带负号");
  ok(s.indexOf("volume='+20%'") >= 0, "音量格式化带正号");
}

/* ====================================================== 3. 切分 */
section("文本切分");
{
  eq(Split.split("").length, 0, "空文本 → 0 块");
  eq(Split.split("   \n\n  ").length, 0, "纯空白 → 0 块");
  eq(Split.split("短句。").length, 1, "短句 → 1 块");
  eq(Split.normalize("a\r\nb\rc"), "a\nb\nc", "换行归一化");
  eq(Split.normalize("a\u200bb"), "ab", "零宽字符移除");
}
{
  const long = "这是一句测试。".repeat(3000); // 21000 字
  const chunks = Split.split(long, { maxChars: 500 });
  ok(chunks.length > 1, `长文本被切分（${chunks.length} 块）`);
  const over = chunks.filter((c) => c.length > 500);
  eq(over.length, 0, "没有超过上限的块");
  eq(chunks.join("").replace(/\n/g, ""), long, "切分后可无损还原原文");
}
{
  const chunks = Split.split("甲".repeat(3000), { maxChars: 400 });
  eq(chunks.length, 8, "无标点超长文本被硬切为 8 块");
  eq(chunks[0].length, 400, "硬切块长度为上限");
  eq(chunks.join(""), "甲".repeat(3000), "硬切无损");
}
{
  const s = Split.stats("这是测试。".repeat(100));
  eq(s.chars, 500, "统计字符数（不含空白）");
  ok(s.chunks >= 1, "统计块数");
  ok(Math.abs(s.seconds - 500 / 4.6) < 0.01, "预估时长按 4.6 字/秒");
}
{
  const t = "第一段。\n\n第二段。\n\n第三段。";
  const chunks = Split.split(t, { maxChars: 800 });
  eq(chunks.length, 1, "短段落被合并成一块");
  ok(chunks[0].indexOf("\n") >= 0, "段间保留换行（合成时形成自然停顿）");
}
{
  const t = "甲。".repeat(10) + "乙";
  const chunks = Split.split(t, { maxChars: 30, minChars: 10 });
  ok(chunks[chunks.length - 1].length >= 1, "尾块非空");
}

/* ====================================================== 4. MP3 帧 */
section("MP3 帧解析与拼接");
const fx = {};
for (const name of Object.keys(vectors.mp3.fixtures)) {
  fx[name] = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", name)));
}
{
  const a = fx["part_a.mp3"];
  const h = Mp3.readHeader(a, 0);
  ok(!!h, "首帧可解析");
  eq(h.version, 2, "MPEG-2");
  eq(h.layer, 3, "Layer III");
  eq(h.bitrate, 48000, "48kbps");
  eq(h.sampleRate, 24000, "24kHz");
  eq(h.channels, 1, "单声道");
  eq(h.length, vectors.mp3.expectedFrameBytes, "帧长 144 字节");
}
for (const name of Object.keys(fx)) {
  const r = Mp3.scan(fx[name]);
  eq(r.start, 0, `${name} 首帧偏移为 0（无 ID3）`);
  eq(r.frames, vectors.mp3.fixtures[name].frames, `${name} 帧数`);
  eq(r.end, fx[name].length, `${name} 无尾部残帧`);
}
{
  const joined = Mp3.concat([fx["part_a.mp3"], fx["part_b.mp3"], fx["part_c.mp3"]]);
  eq(joined.frames, vectors.mp3.expectedTotalFrames, "拼接后总帧数");
  eq(joined.bytes.length, joined.frames * 144, "拼接后长度 = 帧数 × 144");
  eq(joined.skipped.length, 0, "没有块被跳过");
  // 逐帧校验拼接结果全部是合法帧
  let pos = 0, n = 0, bad = 0;
  while (pos < joined.bytes.length) {
    const hh = Mp3.readHeader(joined.bytes, pos);
    if (!hh || hh.length !== 144) { bad++; break; }
    pos += hh.length; n++;
  }
  eq(bad, 0, "拼接结果每一帧都合法");
  eq(n, joined.frames, "逐帧走完正好等于总帧数");
  eq(Mp3.describe(joined.info), "MPEG-2 LayerIII / 48kbps / 24000Hz / 单声道 / 帧长144B", "格式描述");
}
{
  eq(Math.round(Mp3.durationSec(vectors.mp3.expectedTotalFrames, true) * 1000) / 1000,
    vectors.mp3.expectedSeconds, "时长换算（帧数 → 秒）");
  eq(Mp3.formatTime(125), "2:05", "时间格式化");
  eq(Mp3.formatTime(0), "0:00", "时间格式化 0");
}
{
  eq(Mp3.scan(new Uint8Array(0)).frames, 0, "空数据 → 0 帧");
  eq(Mp3.scan(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).frames, 0, "垃圾数据 → 0 帧");
  const withJunk = Mp3.concat([new Uint8Array([9, 9, 9]), new Uint8Array(0)]);
  eq(withJunk.frames, 0, "全无效输入 → 0 帧");
  eq(withJunk.skipped.length, 2, "无效块被记录");
  // 前导垃圾 + 真实帧
  const padded = new Uint8Array(7 + fx["part_b.mp3"].length);
  padded.set([0, 0, 0, 0, 0, 0, 0], 0);
  padded.set(fx["part_b.mp3"], 7);
  const r2 = Mp3.scan(padded);
  eq(r2.start, 7, "能跳过前导垃圾找到帧头");
  eq(r2.frames, vectors.mp3.fixtures["part_b.mp3"].frames, "跳过后帧数正确");
}

/* ====================================================== 5. 音色库 */
section("音色库");
{
  eq(Voices.total(), 958, "内置音色总数");
  const y = Voices.find("zh-CN-YunzeNeural");
  ok(!!y, "云泽存在");
  eq(y.dn, "云泽", "云泽中文名来自官方数据");
  eq(y.l, "zh-CN", "云泽 locale");
  ok(y.st.indexOf("documentary-narration") >= 0, "云泽支持纪录片旁白风格");
  ok(y.st.indexOf("cheerful") >= 0, "云泽支持愉快风格");
  eq(y.g, "M", "云泽为男声");
}
{
  ok(Voices.zhCount() >= 90, `中文音色 ≥ 90（实际 ${Voices.zhCount()}）`);
  ok(Voices.count("pinned") > 0, "推荐组非空");
  ok(Voices.count("cn") >= 70, `普通话组 ≥ 70（实际 ${Voices.count("cn")}）`);
  ok(Voices.count("dialect") >= 6, `方言组 ≥ 6（实际 ${Voices.count("dialect")}）`);
  ok(Voices.count("hmt") >= 6, `港澳台组 ≥ 6（实际 ${Voices.count("hmt")}）`);
  eq(Voices.count("all"), 958, "全部语言 = 总数");
  const list = Voices.list("pinned");
  eq(list[0].n, "zh-CN-YunzeNeural", "推荐组第一位是云泽");
  eq(Voices.list("cn", "云泽", 5)[0].dn, "云泽", "按中文名可搜到");
  eq(Voices.list("cn", "yunze", 5)[0].n, "zh-CN-YunzeNeural", "按 ShortName 小写可搜到");
  eq(Voices.localeFor(Voices.find("zh-CN-YunzeNeural")), "zh-CN", "合成 locale");
  eq(Voices.localeFor(null), "zh-CN", "空音色兜底 locale");
  eq(Voices.styleLabel("documentary-narration"), "纪录片旁白 (documentary-narration)", "风格中文标签");
  eq(Voices.styleLabel("unknown-style"), "unknown-style", "未知风格原样返回");
}
{
  const raw = [{ ShortName: "xx-YY-TestNeural", LocalName: "Test", Gender: "Female", Locale: "xx-YY", StyleList: ["calm"], VoiceTag: { VoicePersonalities: ["Nice"] } }];
  const conv = Voices.fromServer(raw);
  eq(conv[0].n, "xx-YY-TestNeural", "服务端清单转换：ShortName");
  eq(conv[0].g, "F", "服务端清单转换：性别取首字母");
  eq(conv[0].st.length, 1, "服务端清单转换：风格列表");
}

/* ====================================================== 汇总 */
console.log("\n" + "═".repeat(48));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log("═".repeat(48));
if (fail) {
  console.log("\n失败明细：");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
