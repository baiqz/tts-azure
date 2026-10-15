# -*- coding: utf-8 -*-
"""生成离线测试向量：签名对齐 + 真实音频 fixture

签名向量用「固定时间戳 + 固定 uuid」，让 JS 实现与 Python 参考实现逐字节对齐。
"""
import base64, hmac, hashlib, uuid, datetime, json, ssl, urllib.request, urllib.error, urllib.parse, io, os

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
os.makedirs(FIX, exist_ok=True)

KEY = base64.b64decode("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==")
EU = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0"
W = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def utc_date_from_ms(ms):
    n = datetime.datetime.fromtimestamp(ms / 1000.0, datetime.timezone.utc)
    return "%s, %02d %s %d %02d:%02d:%02d GMT" % (
        W[n.weekday()], n.day, M[n.month - 1], n.year, n.hour, n.minute, n.second)


def sign(url, ms, uid):
    enc = urllib.parse.quote(url.split("://", 1)[1], safe="!'()*-._~")
    date = utc_date_from_ms(ms)
    msg = ("MSTranslatorAndroidApp%s%s%s" % (enc, date, uid)).lower()
    return "MSTranslatorAndroidApp::%s::%s::%s" % (
        base64.b64encode(hmac.new(KEY, msg.encode("utf-8"), hashlib.sha256).digest()).decode(), date, uid)


# ---------------------------------------------------------------- 签名向量
CASES = [
    (1792060800000, "0123456789abcdef0123456789abcdef"),   # 2026-10-15 12:00:00Z
    (1792060800000, "ffffffffffffffffffffffffffffffff"),
    (1000000000000, "abcdefabcdefabcdefabcdefabcdefab"),
    (2000000000000, "00000000000000000000000000000000"),
]
sign_vectors = [{
    "url": EU, "nowMs": ms, "uuid": uid, "date": utc_date_from_ms(ms), "expect": sign(EU, ms, uid),
} for ms, uid in CASES]

# ---------------------------------------------------------------- 音频 fixture
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"


def rq(url, method="GET", data=None, hd=None, t=90):
    h = {"User-Agent": UA}
    if hd: h.update(hd)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    with op.open(r, timeout=t) as x:
        return x.status, x.read()


st, b = rq(EU, "POST", b"", {"Accept-Language": "zh-Hans", "X-ClientVersion": "4.0.530a 5fe1dc6c",
                             "X-UserId": "0f04d16a175c411e", "X-HomeGeographicRegion": "zh-Hans-CN",
                             "X-ClientTraceId": uuid.uuid4().hex, "X-MT-Signature": sign(EU, int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000), uuid.uuid4().hex),
                             "Content-Type": "application/json; charset=utf-8", "Content-Length": "0"})
d = json.loads(b.decode()); T = d["t"]; R = d["r"]
url = "https://%s.tts.speech.microsoft.com/cognitiveservices/v1" % R


def ssml(voice, text, locale="zh-CN", style=None, rate=0, pitch=0, volume=0):
    inner = "<prosody rate='%+d%%' pitch='%+dHz' volume='%+d%%'>%s</prosody>" % (rate, pitch, volume, text)
    body = "<mstts:express-as style='%s'>%s</mstts:express-as>" % (style, inner) if style else inner
    ns = " xmlns:mstts='https://www.w3.org/2001/mstts'" if style else ""
    return ("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'%s xml:lang='%s'>"
            "<voice name='%s'>%s</voice></speak>") % (ns, locale, voice, body)


def synth(voice, text, **kw):
    st, b = rq(url, "POST", ssml(voice, text, **kw).encode("utf-8"),
               {"Authorization": T, "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"})
    if st != 200:
        raise SystemExit("合成失败 %s %s %s" % (voice, st, b[:200]))
    return b


parts = {
    "part_a.mp3": synth("zh-CN-YunzeNeural", "第一段测试音频，用来验证帧级拼接。"),
    "part_b.mp3": synth("zh-CN-XiaoxiaoNeural", "第二段测试音频，内容不同。"),
    "part_c.mp3": synth("zh-CN-YunzeNeural", "第三段，换个音色再来一次。", style="documentary-narration"),
}
info = {}
for name, data in parts.items():
    io.open(os.path.join(FIX, name), "wb").write(data)
    # 数帧
    i, n = 0, 0
    while i + 4 <= len(data):
        if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
            f = (data[i + 2] >> 4) & 0x0F
            ver = (data[i + 1] >> 3) & 3
            br = {3: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
                  2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]}[ver][f] * 1000
            sr = {3: [44100,48000,32000], 2: [22050,24000,16000]}[ver][(data[i + 2] >> 2) & 3]
            fl = (144 if ver == 3 else 72) * br // sr + ((data[i + 2] >> 1) & 1)
            n += 1; i += fl
        else:
            i += 1
    info[name] = {"bytes": len(data), "frames": n, "head": data[:4].hex()}

total_frames = sum(v["frames"] for v in info.values())
vectors = {
    "sign": sign_vectors,
    "mp3": {
        "fixtures": info,
        "expectedTotalFrames": total_frames,
        "expectedSeconds": round(total_frames * 576 / 24000, 3),
        "expectedFrameBytes": 144,
    },
}
io.open(os.path.join(HERE, "vectors.json"), "w", encoding="utf-8", newline="\n").write(
    json.dumps(vectors, ensure_ascii=False, indent=2))
print("签名向量:", len(sign_vectors))
print("音频 fixture:", json.dumps(info, ensure_ascii=False))
print("合计帧数 %d → %.2f 秒" % (total_frames, total_frames * 576 / 24000))
print("写入 tests/vectors.json")
