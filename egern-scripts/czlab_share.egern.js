/**
 * czlab 兑换码每日分享 —— Egern 脚本
 *
 * 更新日志：
 *   2026-10-12 前十曝光统计改整点版：模块 cron 改为每小时整点运行（站内每小
 *              时随机重排），每次静默记录自己的码是否进前十及具体名次；每天
 *              20:00（CZLAB_REPORT_HOUR 可改）推送一次，汇总昨日完整 00:00–
 *              23:59 与今日截至当前的曝光次数及每次名次。同一小时不重复计，
 *              只保留近 7 天记录
 *   2026-10-11 站点服务端故障（/api/codes 全部返回 HTTP 500 "error code: 1101"，
 *              Cloudflare Worker 抛异常，站长侧问题）：查询遇到 5xx 时直接判
 *              定站点故障并跳过提交（同一后端，提交也会 500），不再做无用尝试；
 *              失败提示明确为"站点服务端故障"，每天 20:00 自动重试，恢复后自愈
 *   2026-10-09 初版
 *
 * 目标站点：https://code.czlab.dev（互相分享 Muse 兑换码的社区站）
 *
 * 原理：兑换码仅在池中公开展示 24 小时。模块每小时整点运行：每次静默记录
 * 自己的码是否进入展示前十（/api/codes 返回顺序的前 10 位）及名次；每天
 * 20:00 做一次提交检查（在池中则跳过，不在则 POST 提交）并推送汇总，含昨日
 * 完整与今日截至当前的曝光次数及每次名次。
 *
 * 接口（2026-10-09 实测）：
 *   GET  /api/codes/<CODE>  → { exists, active, expired, copy_count }
 *   POST /api/codes         → body {"code":"XXXXXX"}，成功 2xx，失败如 400 + { message }
 * 兑换码格式：恰好 6 位英文或数字（与站点前后端 CODE_RE 一致）。
 *
 * 配置（优先级：模块环境变量 > 模块存储 > 脚本内 CONFIG）：
 *   CZLAB_CODE      单个兑换码，例如 WDE0F2
 *   CZLAB_CODES     多个兑换码，逗号/空格/换行分隔，例如 WDE0F2,AB12CD（可选）
 *   CZLAB_BASE_URL  站点地址（可选，默认 https://code.czlab.dev）
 *   CZLAB_POLICY    代理策略名（可选，让请求走代理时用）
 *   CZLAB_TIMEOUT   单次请求超时秒数（可选，默认 20）
 *   CZLAB_REPORT_HOUR 每天几点推送汇总（可选，0–23，默认 20；其余整点静默只记录）
 *
 * 无需登录、无需 MITM。提交的兑换码本来就是公开展示的，不含敏感信息。
 */

const CONFIG = {
  code: "",      // 例："WDE0F2"
  codes: [],     // 例：["WDE0F2", "AB12CD"]
  baseUrl: "https://code.czlab.dev",
  policy: "",
  timeoutSeconds: 20,
};

const CODE_RE = /^[A-Za-z0-9]{6}$/;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/* ---------------- 基础工具 ---------------- */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatTime(d) {
  const t = d || new Date();
  return (
    t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()) +
    " " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds())
  );
}
function log(msg) {
  try {
    if (typeof console !== "undefined" && console.log) console.log("[" + formatTime() + "] " + msg);
  } catch (e) {}
}
function errorMessage(e) {
  return e && typeof e === "object" ? String(e.message || e.error || JSON.stringify(e)) : String(e || "未知错误");
}
function trimString(s) {
  return typeof s === "string" ? s.trim() : "";
}
function notify(ctx, title, body) {
  try {
    ctx.notify({ title: title, body: body });
  } catch (e) {
    log("通知发送失败（不影响提交）: " + errorMessage(e));
  }
}

/* ---------------- 配置读取 ---------------- */
function storeGet(ctx, key) {
  try {
    const v = ctx.storage.get(key);
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}
function storeSet(ctx, key, value) {
  try { ctx.storage.set(key, value); }
  catch (e) { log("存储写入失败: " + errorMessage(e)); }
}
function envGet(ctx, key) {
  const env = (ctx && ctx.env) || {};
  return trimString(env[key]) || trimString(storeGet(ctx, key));
}
function splitCodes(raw) {
  return trimString(raw)
    .split(/[\s,;，；、]+/)
    .map(trimString)
    .filter(Boolean);
}
function collectCodes(ctx) {
  const seen = {};
  const out = [];
  function add(list) {
    list.forEach((c) => {
      const code = trimString(c).toUpperCase();
      if (code && !seen[code]) { seen[code] = true; out.push(code); }
    });
  }
  add(splitCodes(envGet(ctx, "CZLAB_CODE")));
  add(splitCodes(envGet(ctx, "CZLAB_CODES")));
  add(splitCodes(CONFIG.code));
  if (Array.isArray(CONFIG.codes)) add(CONFIG.codes);
  if (!out.length) {
    log("未检测到兑换码配置：请在模块设置中填写 CZLAB_CODE，或在脚本 CONFIG 中填写 code");
  } else {
    log("已读取 " + out.length + " 个兑换码");
  }
  return out;
}
function getRuntimeConfig(ctx) {
  const baseUrl =
    envGet(ctx, "CZLAB_BASE_URL") || trimString(CONFIG.baseUrl) || "https://code.czlab.dev";
  const timeoutRaw = envGet(ctx, "CZLAB_TIMEOUT");
  let timeoutSeconds = Number(timeoutRaw || CONFIG.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) timeoutSeconds = 20;
  const policy = envGet(ctx, "CZLAB_POLICY") || trimString(CONFIG.policy);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutSeconds, policy };
}

/* ---------------- HTTP（Egern ctx.http） ---------------- */
async function apiRequest(ctx, method, url, jsonBody, t) {
  const m = String(method || "GET").toUpperCase();
  const fn = ctx.http[m.toLowerCase()];
  if (typeof fn !== "function") throw new Error("当前工具不支持 HTTP 方法: " + m);
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  let body;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }
  let resp;
  try {
    resp = await fn.call(ctx.http, url, {
      headers,
      body,
      timeout: t.timeoutSeconds * 1000,
      redirect: "manual",
      credentials: "omit",
      policy: t.policy || undefined,
    });
  } catch (e) {
    throw new Error("请求异常: " + errorMessage(e));
  }
  const status = Number(resp.status || 0);
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status, data, text };
}

/* ---------------- 业务逻辑 ---------------- */
function makeResult(code, status, message) {
  log("[" + code + "] " + ({ success: "✅ 成功", already: "🟡 已在池中", fail: "❌ 失败" }[status] || status) + " | " + message);
  return { code, status, message, time: formatTime() };
}

async function queryCode(ctx, t, code) {
  try {
    const r = await apiRequest(ctx, "GET", t.baseUrl + "/api/codes/" + encodeURIComponent(code), undefined, t);
    if (r.status === 200 && r.data && typeof r.data === "object") return { ok: true, data: r.data };
    return { ok: false, status: r.status, detail: "HTTP " + r.status };
  } catch (e) {
    return { ok: false, status: 0, detail: errorMessage(e) };
  }
}

async function submitCode(ctx, t, code) {
  const r = await apiRequest(ctx, "POST", t.baseUrl + "/api/codes", { code: code }, t);
  if (r.status >= 200 && r.status < 300) {
    const msg = r.data && r.data.message ? String(r.data.message) : "";
    return { ok: true, message: msg };
  }
  const msg = r.data && r.data.message
    ? String(r.data.message).replace(/[\r\n]+/g, " ").slice(0, 160)
    : (r.status >= 500 ? "站点服务端故障（HTTP " + r.status + "），请稍后再试" : "HTTP " + r.status);
  return { ok: false, message: msg };
}

async function processOne(ctx, t, code) {
  if (!CODE_RE.test(code)) {
    return makeResult(code, "fail", "格式不正确（必须是 6 位英文或数字），已跳过");
  }
  const q = await queryCode(ctx, t, code);
  if (q.ok && q.data.active) {
    const n = q.data.copy_count;
    return makeResult(code, "already",
      "已在兑换池中展示" + (n != null ? "（已被复制 " + n + " 次）" : "") + "，本次无需重复提交");
  }
  if (!q.ok && q.status >= 500) {
    // 站点服务端故障：查询和提交走同一个后端，提交也会 500，直接跳过不再尝试
    return makeResult(code, "fail",
      "站点服务端故障（HTTP " + q.status + "），已跳过提交；每天 20:00 会自动重试，站点恢复后自动补上");
  }
  if (!q.ok) log("[" + code + "] 查询状态失败（" + q.detail + "），继续尝试提交");
  let s;
  try {
    s = await submitCode(ctx, t, code);
  } catch (e) {
    return makeResult(code, "fail", "提交请求异常: " + errorMessage(e));
  }
  if (s.ok) {
    return makeResult(code, "success",
      "提交成功，兑换码已加入兑换池" + (s.message ? "（" + s.message + "）" : ""));
  }
  return makeResult(code, "fail", "提交失败: " + s.message);
}

function buildSummary(results) {
  return results.map((r) => {
    const icon = r.status === "fail" ? "❌" : r.status === "already" ? "🟡" : "✅";
    return icon + " " + r.code + "\n" + r.message;
  }).join("\n\n");
}

/* ---------------- 前十曝光统计（整点） ---------------- */
// 站内每小时随机重排展示，"前十" = /api/codes 返回顺序的前 10 位。
// 模块 cron 为每小时整点（0 * * * *）：每次运行静默记录命中及名次；
// 每天 CZLAB_REPORT_HOUR 点（默认 20）推送一次，汇总昨日完整与今日截至当前。
const TOP_N = 10;
const TOP10_STATS_KEY = "czlab_top10_stats";
const TOP10_KEEP_DAYS = 7;

function dayKey(d) {
  const t = d || new Date();
  return t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate());
}
function hourLabel(d) {
  const t = d || new Date();
  return pad2(t.getHours()) + ":00";
}
function loadTop10Stats(ctx) {
  try {
    const raw = ctx.storage.get(TOP10_STATS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
function saveTop10Stats(ctx, stats) {
  storeSet(ctx, TOP10_STATS_KEY, JSON.stringify(stats));
}
function pruneTop10Stats(stats) {
  const cutoff = dayKey(new Date(Date.now() - TOP10_KEEP_DAYS * 86400000));
  Object.keys(stats).forEach((code) => {
    const days = stats[code];
    if (!days || typeof days !== "object" || Array.isArray(days)) { delete stats[code]; return; }
    Object.keys(days).forEach((d) => { if (d < cutoff) delete days[d]; });
    if (!Object.keys(days).length) delete stats[code];
  });
}
function reportHour(ctx) {
  const raw = envGet(ctx, "CZLAB_REPORT_HOUR");
  const h = Number(raw);
  if (raw !== "" && Number.isFinite(h) && h >= 0 && h <= 23) return Math.floor(h);
  return 20;
}
// 整点静默记录：命中则记下时间与名次（同一小时不重复计）
async function recordTop10Exposure(ctx, t, codes) {
  let topCodes;
  try {
    const r = await apiRequest(ctx, "GET", t.baseUrl + "/api/codes", undefined, t);
    if (r.status >= 500) { log("前十曝光：站点服务端故障，跳过本次记录"); return; }
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.codes)) {
      log("前十曝光：列表接口异常（HTTP " + r.status + "），跳过本次记录");
      return;
    }
    topCodes = r.data.codes.slice(0, TOP_N).map((c) => String((c && c.code) || "").toUpperCase());
  } catch (e) {
    log("前十曝光：查询异常，跳过本次记录: " + errorMessage(e));
    return;
  }
  const now = new Date();
  const day = dayKey(now), hm = hourLabel(now);
  const stats = loadTop10Stats(ctx);
  codes.forEach((code) => {
    const pos = topCodes.indexOf(code);
    if (pos < 0) return;
    if (!stats[code] || typeof stats[code] !== "object" || Array.isArray(stats[code])) stats[code] = {};
    if (!Array.isArray(stats[code][day])) stats[code][day] = [];
    const list = stats[code][day];
    if (!list.some((e) => e && e.t === hm)) {
      list.push({ t: hm, pos: pos + 1 });
      log("[" + code + "] 前十曝光：第 " + (pos + 1) + " 位（" + hm + ")");
    }
  });
  pruneTop10Stats(stats);
  saveTop10Stats(ctx, stats);
}
function fmtExposureDay(stats, codes, day, label) {
  const parts = [];
  codes.forEach((code) => {
    const days = stats[code];
    const list = (days && Array.isArray(days[day])) ? days[day] : [];
    if (!list.length) return;
    const sorted = list.slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    parts.push(code + " " + list.length + "次（" + sorted.map((e) => e.t + "第" + e.pos + "位").join("、") + "）");
  });
  if (!parts.length) return label + "：未进前十";
  return label + "：\n" + parts.join("\n");
}
function buildExposureDigest(ctx, codes) {
  const stats = loadTop10Stats(ctx);
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86400000));
  return "🏆 前十曝光\n" +
    fmtExposureDay(stats, codes, yesterday, "昨日 " + yesterday.slice(5)) + "\n" +
    fmtExposureDay(stats, codes, today, "今日截至 " + hourLabel(now));
}

/* ---------------- 入口（Egern Schedule 脚本，每小时整点） ---------------- */
export default async function (ctx) {
  try {
    log("czlab 兑换码分享运行");
    const t = getRuntimeConfig(ctx);
    const codes = collectCodes(ctx);
    const rh = reportHour(ctx);
    const isReport = new Date().getHours() === rh;
    if (!codes.length) {
      const msg = "未检测到兑换码配置：请在模块设置中填写 CZLAB_CODE（6 位兑换码），或在脚本 CONFIG 中填写 code";
      log(msg);
      if (isReport) notify(ctx, "czlab 兑换码分享失败", msg);
      return;
    }
    // 每次整点：静默记录前十曝光
    await recordTop10Exposure(ctx, t, codes);
    if (!isReport) {
      log("非推送时段（每天 " + rh + ":00 推送），本次仅记录曝光");
      return;
    }
    // 推送时段：提交检查 + 曝光汇总
    const results = [];
    for (const c of codes) {
      results.push(await processOne(ctx, t, c));
    }
    const body = buildSummary(results) + "\n\n" + buildExposureDigest(ctx, codes);
    notify(ctx, "czlab 兑换码分享", body);
  } catch (e) {
    log("脚本异常: " + errorMessage(e));
    if (new Date().getHours() === reportHour(ctx)) {
      notify(ctx, "czlab 兑换码分享异常", errorMessage(e));
    }
  }
}
