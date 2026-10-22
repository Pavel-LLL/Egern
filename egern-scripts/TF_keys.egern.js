/**
 * 自动加入 TestFlight —— 信息捕获（Egern 版）
 *
 * 版本：v1.0.0（2026-10-22）
 * 来源：Loon 插件 Auto_Join_TF（作者 DecoAri / xream，KeLee 插件库分发）移植。
 * 原插件包含两个 http-request 捕获规则，共用同一个脚本文件：
 *   1) 打开 TestFlight App 时，从 accounts/.../apps 请求里抓账号令牌；
 *   2) 打开 testflight.apple.com/join/xxxx 链接时，抓邀请码（应用ID）。
 * 本文件按 Egern 模块脚本的兼容全局写法实现（$request / $persistentStore /
 * $notification / $done，与 PingMe 等 Egern 模块脚本同一套运行时）。
 *
 * 存储键（与原版一致，cron 脚本 Auto_join_TF.egern.js 读取）：
 *   key / session_id / session_digest / request_id / X-Apple-AMD-M / TFUA / APP_ID
 * 其中 APP_ID 为英文逗号分隔的邀请码列表，也可在 Egern 里手动填写。
 *
 * 更新日志：
 *   v1.0.0 2026-10-22 初版移植。相对原版的两处小调整：
 *     1) 令牌未变化时不再重复推送通知（原版每次打开 TF 都会弹一次）；
 *     2) 邀请码提取时去掉链接尾部的查询参数/多余路径，避免存入脏数据。
 */

const TF_TOKEN_RE = /^https?:\/\/testflight\.apple\.com\/v3\/accounts\/(.+)\/apps$/;
const TF_JOIN_RE = /^https?:\/\/testflight\.apple\.com\/join\/([^/?#]+)/;

function tfHeader(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k] || '';
  }
  return '';
}

function tfRead(key) {
  const v = $persistentStore.read(key);
  return v === null || v === undefined ? '' : String(v);
}

function tfWrite(value, key) {
  $persistentStore.write(value === null || value === undefined ? '' : String(value), key);
}

// 捕获 1：账号令牌
function captureToken(url, headers) {
  const m = url.match(TF_TOKEN_RE);
  if (!m) return;
  const token = {
    key: m[1],
    session_id: tfHeader(headers, 'X-Session-Id'),
    session_digest: tfHeader(headers, 'X-Session-Digest'),
    request_id: tfHeader(headers, 'X-Request-Id'),
    amd_m: tfHeader(headers, 'X-Apple-AMD-M'),
    ua: tfHeader(headers, 'User-Agent'),
  };
  const changed = tfRead('request_id') !== token.request_id;
  tfWrite(token.key, 'key');
  tfWrite(token.session_id, 'session_id');
  tfWrite(token.session_digest, 'session_digest');
  tfWrite(token.request_id, 'request_id');
  tfWrite(token.amd_m, 'X-Apple-AMD-M');
  tfWrite(token.ua, 'TFUA');
  if (token.request_id) {
    console.log('[自动加入TF] 令牌获取成功，账号 key=' + token.key);
    if (changed) {
      $notification.post('自动加入TF', '信息获取成功', '令牌已保存，可在模块里关掉「令牌捕获」');
    }
  } else {
    console.log('[自动加入TF] 未抓到 X-Request-Id，令牌可能不完整');
    $notification.post('自动加入TF', '信息获取失败', '请确认 MITM 已开启且包含 testflight.apple.com，并重启 TestFlight App');
  }
}

// 捕获 2：应用ID（邀请码）
function captureAppId(url) {
  const m = url.match(TF_JOIN_RE);
  if (!m) return;
  const id = m[1];
  const list = tfRead('APP_ID').split(',').map((s) => s.trim()).filter((s) => s);
  if (!list.includes(id)) list.push(id);
  const joined = list.join(',');
  tfWrite(joined, 'APP_ID');
  console.log('[自动加入TF] 已添加 APP_ID: ' + id + '，当前列表: ' + joined);
  $notification.post('自动加入TF', '已添加APP_ID: ' + id, '当前所有APP_ID: ' + joined);
}

(function () {
  const url = (typeof $request !== 'undefined' && $request.url) || '';
  const headers = (typeof $request !== 'undefined' && $request.headers) || {};
  if (TF_TOKEN_RE.test(url)) {
    captureToken(url, headers);
  } else if (TF_JOIN_RE.test(url)) {
    captureAppId(url);
  }
  $done({});
})();
