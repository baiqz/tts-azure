# -*- coding: utf-8 -*-
"""从 Azure 官方 voices/list 抓取结果生成 src/voices-data.js

零编造原则：中文显示名不靠人肉翻译，而是先从「官方 LocalName 已是中文」的
标准音色里反推 拼音→中文 映射，再套用到同名的 HD / 多语言版本上。
映射表里没有的拼音（如 Yunxiao / Bo / Lan）一律保留原文，不硬编。

注意：映射源必须排除方言音色（zh-CN-sichuan-YunxiNeural 的官方名是「云希 四川」，
若参与映射会把标准音色 zh-CN-YunxiNeural 的「云希」覆盖掉）。
"""
import json, io, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "tests", "azure_voices_raw.json")
OUT = os.path.join(HERE, "..", "src", "voices-data.js")

SERIES_MAP = {
    "DragonHDFlashLatestNeural": "Dragon HD Flash",
    "DragonHDLatestNeural": "Dragon HD",
    "DragonHDOmniLatestNeural": "Dragon HD Omni",
    "DragonLatestNeural": "Dragon",
}


def head_of(shortname):
    return shortname.split(":", 1)[0]


def locale_of(shortname):
    """zh-CN-liaoning-XiaobeiNeural -> zh-CN-liaoning ；zh-CN-XiaoxiaoNeural -> zh-CN"""
    head = head_of(shortname)
    head = re.sub(r"(Multilingual)?Neural$", "", head)
    parts = head.split("-")
    return "-".join(parts[:-1]) if len(parts) >= 2 else head


def tail_of(shortname):
    """人名段：zh-CN-XiaoxiaoNeural -> Xiaoxiao ；zh-CN-XiaoxiaoMultilingualNeural -> Xiaoxiao"""
    head = head_of(shortname)
    tail = re.sub(r"(Multilingual)?Neural$", "", head).split("-")[-1]
    return tail


def is_standard(shortname):
    """标准音色 = 无系列冒号、非多语言、locale 无方言段（zh-CN-Xxx 恰三节）"""
    if ":" in shortname or "Multilingual" in shortname:
        return False
    return len(re.sub(r"Neural$", "", head_of(shortname)).split("-")) == 3


def pretty_series(series):
    if not series:
        return ""
    if series in SERIES_MAP:
        return SERIES_MAP[series]
    return re.sub(r"Neural$", "", re.sub(r"Latest$", "", series)).replace("-", " ").strip()


def main():
    slim = json.load(io.open(SRC, encoding="utf-8"))

    # ---- 1. 反推 拼音→中文（只认标准音色里官方名本身就是中文的）----
    pinyin2cn = {}
    for v in slim:
        sn = v["n"]
        if not sn.startswith("zh") or not is_standard(sn):
            continue
        if re.search(r"[\u4e00-\u9fff]", v["d"]):
            pinyin2cn[tail_of(sn)] = v["d"]

    # ---- 2. 生成条目 ----
    items = []
    for v in slim:
        sn = v["n"]
        tail = tail_of(sn)
        series = pretty_series(sn.split(":", 1)[1] if ":" in sn else "")
        multi = "Multilingual" in sn
        cn = pinyin2cn.get(tail, "")
        raw = str(v["d"]).strip()
        if sn.startswith("zh") and re.search(r"[\u4e00-\u9fff]", raw):
            # 官方 LocalName 本身就是准确的中文名（云泽 / 云希 四川 / 晓晓 多语言）—— 原样采用
            dn = raw
        else:
            name = cn or tail
            extras = []
            if series:
                extras.append(series)
            if multi:
                extras.append("多语言")
            dn = name + (" · " + " ".join(extras) if extras else "")
        items.append({
            "n": sn,
            "dn": dn,
            "g": v["g"],
            "l": locale_of(sn) if sn.startswith("zh") else v["l"],
            "s": series,
            "st": v["s"],
            "p": v["p"],
        })

    zh = [x for x in items if str(x["l"]).startswith("zh")]
    named = [x for x in zh if re.search(r"[\u4e00-\u9fff]", x["dn"])]
    items_js = json.dumps(items, ensure_ascii=False, separators=(",", ":"))

    js = (
        "/* 自动生成，请勿手改 —— 由 tools/gen_voices_data.py 产出 */\n"
        "(function (root, factory) {\n"
        "  if (typeof module === \"object\" && module.exports) module.exports = factory();\n"
        "  else root.AzureVoicesData = factory();\n"
        "})(typeof self !== \"undefined\" ? self : this, function () {\n"
        "  return { generatedAt: \"2026-10-15\", total: %d, voices: %s };\n"
        "});\n"
    ) % (len(items), items_js)

    io.open(OUT, "w", encoding="utf-8", newline="\n").write(js)

    print("写入", os.path.normpath(OUT), "大小 %.1f KB" % (len(js.encode("utf-8")) / 1024))
    print("音色总数 %d ；中文 %d（其中 %d 个有官方中文名）" % (len(items), len(zh), len(named)))
    print("\n拼音→中文映射 %d 条：%s" % (len(pinyin2cn), json.dumps(pinyin2cn, ensure_ascii=False)))
    print("\n无中文名（保留拼音原名，未编造）:")
    for x in zh:
        if x not in named:
            print("   %-44s %s" % (x["n"], x["dn"]))
    print("\n关键样例:")
    for n in ("zh-CN-YunzeNeural", "zh-CN-YunxiNeural", "zh-CN-sichuan-YunxiNeural",
              "zh-CN-Xiaoxiao:DragonHDFlashLatestNeural", "zh-CN-Yunxia:DragonHDFlashLatestNeural",
              "zh-CN-XiaoxiaoMultilingualNeural", "zh-CN-Bo:MAI-Voice-2-Flash",
              "zh-CN-liaoning-XiaobeiNeural", "en-US-Ava:DragonHDLatestNeural"):
        for x in items:
            if x["n"] == n:
                print("   %-44s %s" % (n, x["dn"]))


if __name__ == "__main__":
    main()
