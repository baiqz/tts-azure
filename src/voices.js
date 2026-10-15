/**
 * voices.js —— 音色访问层
 *
 * 数据来自 Azure 官方 voices/list（离线内置）。中文显示名优先采用官方 LocalName，
 * 官方只给英文名的 HD / MAI 系列则用「拼音段 · 系列」，不做人肉翻译。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./voices-data.js"));
  else root.Voices = factory(root.AzureVoicesData);
})(typeof self !== "undefined" ? self : this, function (DATA) {
  "use strict";

  var ALL = (DATA && DATA.voices) || [];

  /* --------------------------------------------------- 情感风格中文名 */

  var STYLE_CN = {
    "general": "通用", "calm": "平静", "cheerful": "愉快", "sad": "悲伤",
    "angry": "愤怒", "fearful": "恐惧", "disgruntled": "不满", "serious": "严肃",
    "depressed": "沮丧", "documentary-narration": "纪录片旁白", "newscast": "新闻播报",
    "assistant": "智能助手", "chat": "闲聊", "chat-casual": "随意聊天",
    "customerservice": "客服", "affectionate": "亲切", "gentle": "温和",
    "lyrical": "抒情", "poetry-reading": "诗歌朗诵", "friendly": "友好",
    "whispering": "耳语", "excited": "兴奋", "embarrassed": "尴尬",
    "empathetic": "共情", "encouraging": "鼓励", "hopeful": "充满希望",
    "sports-commentary": "体育解说", "sports-commentary-excited": "体育解说（激昂）",
    "narrative": "叙事", "story-telling": "讲故事", "sorry": "道歉",
    "comforting": "安慰", "anxious": "焦虑", "curious": "好奇",
    "surprised": "惊讶", "sentimental": "感伤", "tired": "疲惫",
    "strict": "严厉", "shy": "害羞", "disappointed": "失望", "guilty": "愧疚",
    "lonely": "孤独", "debating": "辩论", "voice-assistant": "语音助手",
    "customer-service": "客服", "angry-refusing": "愤怒拒绝",
  };

  function styleLabel(s) {
    return STYLE_CN[s] ? STYLE_CN[s] + " (" + s + ")" : s;
  }

  /* --------------------------------------------------------- 推荐排序 */

  // 用户点名要的云泽置顶，其后是常用音色
  var PINNED = [
    "zh-CN-YunzeNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-Xiaoxiao:DragonHDFlashLatestNeural",
    "zh-CN-Yunhan:DragonHDFlashLatestNeural",
  ];

  /* ------------------------------------------------------------- 分类 */

  var GROUPS = [
    { id: "pinned", name: "推荐" },
    { id: "cn", name: "普通话" },
    { id: "dialect", name: "方言" },
    { id: "hmt", name: "港澳台" },
    { id: "multi", name: "多语言" },
    { id: "hd", name: "高清 HD / 新模型" },
    { id: "all", name: "全部语言" },
  ];

  function isMulti(v) { return /多语言|Multilingual/.test(v.n + v.dn); }
  function isDialect(v) { return v.l.indexOf("zh-CN-") === 0; }
  function isHMT(v) { return v.l === "zh-HK" || v.l === "zh-TW"; }
  function isHD(v) { return !!v.s; }

  function match(v, group) {
    switch (group) {
      case "pinned": return PINNED.indexOf(v.n) >= 0;
      case "cn": return v.l === "zh-CN";
      case "dialect": return isDialect(v);
      case "hmt": return isHMT(v);
      case "multi": return isMulti(v);
      case "hd": return isHD(v);
      default: return true;
    }
  }

  /** 列出某分组下的音色（已排序） */
  function list(group, query, limit, offset) {
    var q = (query || "").trim().toLowerCase();
    var out = [];
    for (var i = 0; i < ALL.length; i++) {
      var v = ALL[i];
      if (!match(v, group || "pinned")) continue;
      if (q) {
        var hay = (v.n + " " + v.dn + " " + v.l).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(v);
    }
    out.sort(function (a, b) {
      var pa = PINNED.indexOf(a.n), pb = PINNED.indexOf(b.n);
      if (pa >= 0 || pb >= 0) {
        if (pa < 0) return 1;
        if (pb < 0) return -1;
        return pa - pb;
      }
      var za = a.l.indexOf("zh") === 0 ? 0 : 1;
      var zb = b.l.indexOf("zh") === 0 ? 0 : 1;
      if (za !== zb) return za - zb;
      if (a.l !== b.l) return a.l < b.l ? -1 : 1;
      return a.dn < b.dn ? -1 : a.dn > b.dn ? 1 : 0;
    });
    if (offset || limit) return out.slice(offset || 0, (offset || 0) + (limit || out.length));
    return out;
  }

  function count(group) {
    var n = 0;
    for (var i = 0; i < ALL.length; i++) if (match(ALL[i], group)) n++;
    return n;
  }

  function find(shortName) {
    for (var i = 0; i < ALL.length; i++) if (ALL[i].n === shortName) return ALL[i];
    return null;
  }

  /** 中文音色数（含方言 / 港澳台） */
  function zhCount() {
    var n = 0;
    for (var i = 0; i < ALL.length; i++) if (ALL[i].l.indexOf("zh") === 0) n++;
    return n;
  }

  /** 合成时实际使用的 locale（个别音色 locale 只有 "zh"，做兜底） */
  function localeFor(v) {
    if (!v) return "zh-CN";
    return v.l && v.l.indexOf("-") > 0 ? v.l : "zh-CN";
  }

  /** 把服务端返回的原始清单转成本地结构，用于在线刷新 */
  function fromServer(rawList) {
    return (rawList || []).map(function (v) {
      var sn = v.ShortName;
      var series = "";
      if (sn.indexOf(":") >= 0) {
        series = sn.split(":")[1].replace(/Neural$/, "").replace(/Latest$/, "")
          .replace("DragonHD", "Dragon HD ").replace("Dragon", "Dragon ").trim();
      }
      return {
        n: sn,
        dn: v.LocalName || v.DisplayName || sn,
        g: (v.Gender || "F").charAt(0),
        l: v.Locale || "",
        s: series,
        st: v.StyleList || [],
        p: (v.VoiceTag && v.VoiceTag.VoicePersonalities) || [],
      };
    });
  }

  function replaceAll(newList) {
    if (newList && newList.length) ALL = newList;
  }

  return {
    GROUPS: GROUPS,
    all: function () { return ALL; },
    list: list,
    count: count,
    find: find,
    zhCount: zhCount,
    localeFor: localeFor,
    styleLabel: styleLabel,
    STYLE_CN: STYLE_CN,
    fromServer: fromServer,
    replaceAll: replaceAll,
    total: function () { return ALL.length; },
    generatedAt: (DATA && DATA.generatedAt) || "",
  };
});
