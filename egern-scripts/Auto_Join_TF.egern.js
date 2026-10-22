/**
 * 自动加入 TestFlight（Egern 版，单文件）
 *
 * 版本：v2.0.0（2026-10-22）
 * 来源：Loon 插件 Auto_Join_TF（作者 DecoAri / xream，KeLee 插件库分发）移植，
 * 业务流程与原版一致，代码按 Egern 原生 API 重写。
 *
 * 一个文件同时承担模块里的三种触发（与 PingMe 模块同为单文件结构）：
 *   1) http_request 命中 accounts/.../apps → 捕获账号令牌；
 *   2) http_request 命中 testflight.apple.com/join/xxxx → 捕获邀请码；
 *   3) schedule 定时 → 逐个查询 APP_ID 名额，有空位立即加入。
 * 捕获模式下只读请求并写存储，不改请求内容；任何异常都吞掉并放行，
 * 保证 TestFlight 本身的请求永远不被脚本影响。
 *
 * 存储键：key / session_id / session_digest / request_id /
 *         X-Apple-AMD-M / TFUA / APP_ID（英文逗号分隔的邀请码列表）
 *
 * 更新日志：
 *   v2.0.0 2026-10-22 紧急修复：v1 误用了 QX/Surge 的全局变量
 *     （$persistentStore / $httpClient / $notification / $done），这些在
 *     Egern 原生运行时里不存在，捕获脚本一执行就抛错，导致被 MITM 拦截的
 *     accounts/apps 请求失败、TestFlight 无法加载 App。本版改用 Egern 原生
 *     ctx API（ctx.request / ctx.storage / ctx.http / ctx.notify）单文件重写，
 *     并给捕获路径加了全程异常兜底。
 *   v1.0.0 2026-10-22 初版（已废弃，勿用）。
 */

const TOKEN_RE = /^https?:\/\/testflight\.apple\.com\/v3\/accounts\/(.+)\/apps$/;
const JOIN_RE = /^https?:\/\/testflight\.apple\.com\/join\/([^/?#]+)/;
const RU_BASE = 'https://testflight.apple.com/v3/accounts/';
const LOG_TAG = '[自动加入TF] ';

function sGet(ctx, key) {
  try {
    const v = ctx.storage.get(key);
    return v === null || v === undefined ? '' : String(v);
  } catch (e) {
    return '';
  }
}

function sSet(ctx, key, value) {
  try {
    ctx.storage.set(key, value === null || value === undefined ? '' : String(value));
  } catch (e) {
    console.log(LOG_TAG + '存储写入失败(' + key + '): ' + (e && e.message ? e.message : e));
  }
}

function notify(ctx, title, body) {
  try {
    ctx.notify({ title: title, body: body });
  } catch (e) {
    console.log(LOG_TAG + '通知失败（不影响功能）: ' + (e && e.message ? e.message : e));
  }
}

function headerOf(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    try {
      return headers.get(name) || '';
    } catch (e) {
      /* fall through to object scan */
    }
  }
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k] || '';
  }
  return '';
}

function appIds(ctx) {
  return sGet(ctx, 'APP_ID').split(',').map((s) => s.trim()).filter((s) => s);
}

function removeId(ctx, id) {
  sSet(ctx, 'APP_ID', appIds(ctx).filter((x) => x !== id).join(','));
}

/* ---------------- 捕获模式 ---------------- */

function capture(ctx, req, url) {
  const tokenMatch = url.match(TOKEN_RE);
  if (tokenMatch) {
    const headers = req.headers || {};
    const token = {
      key: tokenMatch[1],
      session_id: headerOf(headers, 'X-Session-Id'),
      session_digest: headerOf(headers, 'X-Session-Digest'),
      request_id: headerOf(headers, 'X-Request-Id'),
      amd_m: headerOf(headers, 'X-Apple-AMD-M'),
      ua: headerOf(headers, 'User-Agent'),
    };
    const changed = sGet(ctx, 'request_id') !== token.request_id;
    sSet(ctx, 'key', token.key);
    sSet(ctx, 'session_id', token.session_id);
    sSet(ctx, 'session_digest', token.session_digest);
    sSet(ctx, 'request_id', token.request_id);
    sSet(ctx, 'X-Apple-AMD-M', token.amd_m);
    sSet(ctx, 'TFUA', token.ua);
    if (token.request_id) {
      console.log(LOG_TAG + '令牌获取成功，账号 key=' + token.key);
      if (changed) {
        notify(ctx, '自动加入TF', '信息获取成功，令牌已保存，可在模块里关掉「令牌捕获」');
      }
    } else {
      console.log(LOG_TAG + '未抓到 X-Request-Id，令牌可能不完整');
      notify(ctx, '自动加入TF', '信息获取失败，请确认 MITM 已开启且包含 testflight.apple.com，并重启 TestFlight App');
    }
    return;
  }

  const joinMatch = url.match(JOIN_RE);
  if (joinMatch) {
    const id = joinMatch[1];
    const list = appIds(ctx);
    if (!list.includes(id)) list.push(id);
    const joined = list.join(',');
    sSet(ctx, 'APP_ID', joined);
    console.log(LOG_TAG + '已添加 APP_ID: ' + id + '，当前列表: ' + joined);
    notify(ctx, '自动加入TF', '已添加APP_ID: ' + id + '\n当前所有APP_ID: ' + joined);
  }
}

/* ---------------- 定时模式 ---------------- */

async function httpJson(ctx, method, url, headers) {
  const fn = ctx.http[method.toLowerCase()];
  const resp = await fn.call(ctx.http, url, { headers: headers, timeout: 30000 });
  const status = Number(resp.status || 0);
  const text = await resp.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  return { status: status, data: data, text: text };
}

async function tryJoin(ctx, id, headers, accountKey) {
  const infoUrl = RU_BASE + accountKey + '/ru/' + id;
  let info;
  try {
    info = await httpJson(ctx, 'GET', infoUrl, headers);
  } catch (e) {
    const err = String((e && e.message) || e);
    if (err.indexOf('-1012') !== -1) {
      notify(ctx, '自动加入TF', '令牌已失效，请重新打开 TestFlight App 获取令牌');
    }
    console.log(LOG_TAG + id + ' 查询出错: ' + err);
    return;
  }

  if (info.status === 404) {
    removeId(ctx, id);
    notify(ctx, '自动加入TF', id + ' 不存在该TF，已自动删除该 APP_ID');
    console.log(LOG_TAG + id + ' 不存在该TF，已自动删除该 APP_ID');
    return;
  }

  if (info.status === 401 || info.status === 403) {
    notify(ctx, '自动加入TF', '令牌已失效，请重新打开 TestFlight App 获取令牌');
    console.log(LOG_TAG + id + ' 令牌失效，HTTP ' + info.status);
    return;
  }

  const payload = info.data;
  if (!payload || payload.data === null || payload.data === undefined) {
    const msg =
      payload && payload.messages && payload.messages[0]
        ? payload.messages[0].message
        : '接口无数据（HTTP ' + info.status + '）';
    console.log(LOG_TAG + id + ': ' + msg);
    return;
  }

  if (payload.data.status === 'FULL') {
    const fullName = (payload.data.app && payload.data.app.name) || id;
    console.log(LOG_TAG + fullName + ' (' + id + '): ' + (payload.data.message || '名额已满'));
    return;
  }

  let acc;
  try {
    acc = await httpJson(ctx, 'POST', infoUrl + '/accept', headers);
  } catch (e) {
    console.log(LOG_TAG + id + ' 加入请求出错: ' + String((e && e.message) || e));
    return;
  }
  const appName = acc.data && acc.data.data && acc.data.data.name ? acc.data.data.name : '';
  if (!appName) {
    console.log(LOG_TAG + id + ' 加入返回异常，保留待重试: ' + String(acc.text || '').slice(0, 120));
    return;
  }
  removeId(ctx, id);
  notify(ctx, '自动加入TF', '🎉 ' + appName + ' TestFlight 加入成功');
  console.log(LOG_TAG + '🎉 ' + appName + ' (' + id + ') TestFlight 加入成功');
}

async function runCron(ctx) {
  const accountKey = sGet(ctx, 'key');
  const ids = appIds(ctx);
  if (ids.length === 0) {
    console.log(LOG_TAG + 'APP_ID 列表为空，无待加入的 TF');
    return;
  }
  if (!accountKey || !sGet(ctx, 'session_id')) {
    notify(ctx, '自动加入TF', '已有待加入的 APP_ID，但尚未捕获令牌，请先打开 TestFlight App');
    console.log(LOG_TAG + '已有 APP_ID 但令牌缺失，跳过本轮');
    return;
  }
  const headers = {
    'X-Session-Id': sGet(ctx, 'session_id'),
    'X-Session-Digest': sGet(ctx, 'session_digest'),
    'X-Request-Id': sGet(ctx, 'request_id'),
    'X-Apple-AMD-M': sGet(ctx, 'X-Apple-AMD-M'),
    'User-Agent': sGet(ctx, 'TFUA'),
  };
  for (const id of ids) {
    await tryJoin(ctx, id, headers, accountKey);
  }
}

/* ---------------- 入口 ---------------- */

export default async function (ctx) {
  const req = ctx && ctx.request ? ctx.request : null;
  const url = req && req.url ? String(req.url) : '';
  if (url) {
    // 捕获模式：只读不改；异常一律吞掉，保证原请求正常放行
    try {
      capture(ctx, req, url);
    } catch (e) {
      console.log(LOG_TAG + '捕获异常（已忽略）: ' + (e && e.message ? e.message : e));
    }
    return;
  }
  await runCron(ctx);
}
