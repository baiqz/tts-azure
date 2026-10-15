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
const FileLoader = require("../src/fileloader.js");

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

/* ====================================================== 6. 文件读取 */
section("文件读取与清洗");
const FIXD = path.join(__dirname, "fixtures");
const readFix = (n) => new Uint8Array(fs.readFileSync(path.join(FIXD, n)));

/* 6.1 编码识别 —— Windows 上大量中文 txt 是 GBK，读错就是一屏乱码 */
{
  const u8 = FileLoader.decodeBytes(readFix("sample_utf8.txt"));
  eq(u8.encoding, "UTF-8", "UTF-8 无 BOM 识别");
  ok(u8.text.startsWith("这是一份用来测编码的文稿。"), "UTF-8 内容正确");

  const gbk = FileLoader.decodeBytes(readFix("sample_gbk.txt"));
  eq(gbk.encoding, "GBK / GB18030", "GBK 被正确识别（不会读成乱码）");
  eq(gbk.text, u8.text, "GBK 与 UTF-8 解出同一段文字");

  const bom = FileLoader.decodeBytes(readFix("sample_utf8bom.txt"));
  eq(bom.encoding, "UTF-8 (BOM)", "UTF-8 BOM 识别");
  eq(bom.text, u8.text, "BOM 被剥掉，不残留 \uFEFF");

  const u16 = FileLoader.decodeBytes(readFix("sample_utf16le.txt"));
  eq(u16.encoding, "UTF-16 LE", "UTF-16 LE 识别");
  eq(u16.text, u8.text, "UTF-16 内容正确");
}

/* 6.2 类型判定与路径处理 */
{
  eq(FileLoader.kindOf("a.TXT"), "text", "大写扩展名也认");
  eq(FileLoader.kindOf("a.docx"), "docx", "docx 识别");
  eq(FileLoader.kindOf("a.PDF"), "unsupported-pdf", "PDF 显式标记为不支持");
  eq(FileLoader.kindOf("a.doc"), "unsupported-doc", "老 doc 显式标记为不支持");
  eq(FileLoader.kindOf("无扩展名", "text/plain"), "text", "无扩展名按 MIME 判定");
  eq(FileLoader.kindOf("无扩展名"), "unknown", "无从判断 → unknown（交给内容探测）");
  eq(FileLoader.extOf("a.b/c.d.md"), "md", "extOf 只取后缀");
  eq(FileLoader.baseName("C:\\x\\y\\z.txt"), "z.txt", "baseName 去掉目录");
  eq(FileLoader.baseName("/a/b/c.txt"), "c.txt", "baseName 兼容正斜杠");
  ok(FileLoader.ACCEPT.indexOf(".docx") >= 0, "ACCEPT 含 docx");
  ok(FileLoader.ACCEPT.indexOf(".pdf") >= 0, "ACCEPT 也含 pdf（好让用户选中后看到原因）");
  ok(FileLoader.looksBinary(new Uint8Array([1, 2, 0, 4])), "NUL 字节 → 判为二进制");
  ok(!FileLoader.looksBinary(new Uint8Array("中文".split("").map((c) => c.charCodeAt(0) & 0xff))), "普通文本不误判");
}

/* 6.3 字幕 */
{
  const srt = "1\n00:00:01,000 --> 00:00:04,000\n第一句台词\n\n2\n00:00:04,500 --> 00:00:07,000\n第二句\n接上一行\n";
  const t = FileLoader.stripSubtitles(srt, "srt");
  eq(t, "第一句台词\n\n第二句接上一行", "SRT：去序号与时间轴，块内折行合并");
  ok(t.indexOf("-->") < 0, "时间轴已清除");
  ok(t.indexOf("00:00") < 0, "时间码已清除");

  const vtt = "WEBVTT\n\nNOTE 这是注释\n\n00:00.000 --> 00:02.000\nHello\nworld\n";
  eq(FileLoader.stripSubtitles(vtt, "vtt"), "Hello world", "VTT：去头部与注释，英文之间补空格");

  const ass = "[Script Info]\nTitle: x\n\n[Events]\n" +
    "Format: Layer, Start, End, Style, Name, ML, MR, MV, Effect, Text\n" +
    "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8}上面一句\n" +
    "Dialogue: 0,0:00:04.00,0:00:08.00,Default,,0,0,0,,下面\\N换行\n";
  const a = FileLoader.stripSubtitles(ass, "ass");
  ok(a.indexOf("上面一句") >= 0, "ASS：提取台词");
  ok(a.indexOf("{\\an8}") < 0, "ASS：去掉样式覆盖码");
  ok(a.indexOf("下面\n换行") >= 0, "ASS：\\N 转换行");
  ok(a.indexOf("Title: x") < 0, "ASS：非 Events 段不收录");
}

/* 6.4 HTML */
{
  const html = "<html><head><title>网页标题不该被读进来</title><style>a{color:red}</style></head><body>" +
    "<h1>标题</h1><p>第一段 &amp; 转义</p><p>第二段<br>换行</p>" +
    "<ul><li>项目一</li><li>项目二</li></ul><script>var x=1;</script></body></html>";
  const t = FileLoader.stripHtml(html);
  ok(t.indexOf("var x=1") < 0, "script 内容被剔除");
  ok(t.indexOf("color:red") < 0, "style 内容被剔除");
  ok(t.indexOf("网页标题") < 0, "head 内容被剔除");
  ok(t.indexOf("<") < 0, "无标签残留");
  ok(t.indexOf("第一段 & 转义") >= 0, "实体正确解码");
  ok(t.indexOf("第二段\n换行") >= 0, "br → 换行");
  ok(t.split("\n").indexOf("项目一") >= 0, "列表项各自成行");
}

/* 6.5 Markdown */
{
  const md = "# 标题\n\n这是**粗体**和`代码`。\n\n- 列表一\n- 列表二\n\n" +
    "[链接文字](https://example.com)\n\n![图](a.png)\n\n> 引用行\n\n```\n代码块内容\n```\n";
  const t = FileLoader.stripMarkdown(md);
  ok(t.indexOf("#") < 0, "标题井号已去");
  ok(t.indexOf("这是粗体和代码。") >= 0, "强调与行内代码标记已去");
  ok(t.indexOf("列表一") >= 0 && t.indexOf("- 列表") < 0, "列表标记已去、内容保留");
  ok(t.indexOf("链接文字") >= 0 && t.indexOf("https://") < 0, "链接保留文字、去掉 URL");
  ok(t.indexOf("代码块内容") >= 0, "代码块保留内容");
  ok(t.indexOf("引用行") >= 0, "引用标记已去");
}

/* 6.6 docx（真 zip 容器） */
{
  const docx = await FileLoader.parseDocx(readFix("sample.docx"));
  ok(docx.indexOf("第一段：这是 Word 文档里的正文。") >= 0, "docx：正文段落读到");
  ok(docx.indexOf("第二段有特殊字符 & <尖括号>") >= 0, "docx：命名实体与尖括号正确解码");
  ok(docx.indexOf("和 中文字。") >= 0, "docx：十六进制实体 &#x4E2D; 解码为「中」");
  ok(docx.indexOf("行A\n行B") >= 0, "docx：w:br 转换行");
  ok(docx.indexOf("制表\t后面") >= 0, "docx：w:tab 转制表符");
  ok(docx.indexOf("修订删除") < 0, "docx：w:delText（修订删除）被忽略");
  ok(docx.indexOf("PAGE") < 0, "docx：域代码被忽略");
  ok(docx.indexOf("最后一段。") >= 0, "docx：末段正常");
  ok(docx.indexOf("<w:") < 0, "docx：无 XML 标签残留");

  const stored = await FileLoader.parseDocx(readFix("sample_stored.docx"));
  eq(stored, docx, "未压缩（method=0）的 docx 解出同样内容");
}

/* 6.7 失败要给人话，不能静默读出乱码 */
{
  let m = "";
  try { await FileLoader.parseDocx(readFix("fake.docx")); } catch (e) { m = e.message; }
  ok(/不是有效的 docx|没有正文/.test(m), "假 docx 给出明确原因：" + m);

  const catchMsg = async (f) => { try { await FileLoader.readOne(f); return ""; } catch (e) { return e.message; } };
  const u8 = readFix("sample_utf8.txt");

  ok(/PDF 暂时读不了/.test(await catchMsg({ name: "x.pdf", bytes: u8 })), "PDF 报错并给出替代办法");
  ok(/另存为/.test(await catchMsg({ name: "x.doc", bytes: u8 })), "老 doc 报错并给出替代办法");
  ok(/文件是空的/.test(await catchMsg({ name: "空.txt", bytes: new Uint8Array(0) })), "空文件报错");
  ok(/二进制/.test(await catchMsg({ name: "无后缀", bytes: new Uint8Array([0, 1, 2, 3, 0, 5]) })),
    "无后缀的二进制内容被识别并拒绝");
}

/* 6.8 批量读取：一个失败不拖累其余 */
{
  const r = await FileLoader.readAll([
    { name: "a.txt", bytes: readFix("sample_utf8.txt") },
    { name: "b.txt", bytes: readFix("sample_gbk.txt") },
    { name: "bad.pdf", bytes: readFix("sample_utf8.txt") },
  ]);
  eq(r.parts.length, 2, "成功 2 个");
  eq(r.failed.length, 1, "失败 1 个（不阻断其余）");
  eq(r.failed[0].name, "bad.pdf", "失败项带文件名");
  eq(r.parts[0].name, "a.txt", "结果带文件名");
  eq(r.parts[0].kind, "text", "结果带类型");
  eq(r.parts[0].label, "纯文本", "结果带中文类型名");
  ok(r.parts[0].note.indexOf("UTF-8") >= 0, "note 标明编码");
  ok(r.parts[1].note.indexOf("GBK") >= 0, "note 标明 GBK");
  eq(r.parts[0].chars, r.parts[0].text.replace(/\s/g, "").length, "字数统计自洽（不含空白）");
  ok(r.text.indexOf("\n\n") > 0, "多文件以空行分隔合并");

  const r2 = await FileLoader.readOne({ name: "s.srt", bytes: new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\n台词\n") });
  ok(r2.note.indexOf("已去时间轴") >= 0, "字幕 note 标明已去时间轴");
  eq(r2.kind, "subtitle", "字幕类型");
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
