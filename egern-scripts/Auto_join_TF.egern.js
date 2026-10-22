/**
 * 自动加入 TestFlight —— 定时自动加入（Egern 版）
 *
 * 版本：v1.0.0（2026-10-22）
 * 来源：Loon 插件 Auto_Join_TF（作者 DecoAri / xream，KeLee 插件库分发）移植，
 * 业务逻辑与原版 cron 脚本一致，用 Egern 兼容全局写法重写
 * （$persistentStore / $httpClient / $notification / $done）。
 *
 * 逻辑：读 APP_ID 列表（英文逗号分隔的邀请码），逐个查询名额状态：
 *   - 接口 404        → 邀请码不存在，从列表删除并通知；
 *   - data 为空       → 记录接口返回的 message，保留待下轮重试；
 *   - status == FULL  → 名额已满，只记日志，保留待下轮重试；
 *   - 其他状态        → POST accept 加入，成功后从列表删除并通知。
 * 令牌由 TF_keys.egern.js 捕获写入（key / session_id / session_digest /
 * request_id / X-Apple-AMD-M / TFUA）。
 *
 * 更新日志：
 *   v1.0.0 2026-10-22 初版移植。相对原版的三处修正：
 *     1) 原版请求头误用 X-Apple-AMD-X 且读取的存储键从未被写入，改为捕获时
 *        实际保存的 X-Apple-AMD-M；
 *     2) 原版靠 Surge $httpAPI 自动关闭模块避免空转通知，Egern 无此接口，
 *        改为 APP_ID 为空时只记日志、不推送，避免每分钟重复打扰；
 *     3) accept 返回解析失败时保留邀请码并记日志（原版会直接抛错中断）。
 */

function tfRead(key) {
  const v = $persistentStore.read(key);
  return v === null || v === undefined ? '' : String(v);
}

function tfWrite(value, key) {
  $persistentStore.write(value === null || value === undefined ? '' : String(value), key);
}

function tfHeaders() {
  return {
    'X-Session-Id': tfRead('session_id'),
    'X-Session-Digest': tfRead('session_digest'),
    'X-Request-Id': tfRead('request_id'),
    'X-Apple-AMD-M': tfRead('X-Apple-AMD-M'),
    'User-Agent': tfRead('TFUA'),
  };
}

function tfGet(url, headers) {
  return new Promise((resolve) => {
    $httpClient.get({ url: url, headers: headers }, function (error, resp, data) {
      resolve({ error: error, resp: resp, data: data });
    });
  });
}

function tfPost(url, headers) {
  return new Promise((resolve) => {
    $httpClient.post({ url: url, headers: headers }, function (error, resp, data) {
      resolve({ error: error, resp: resp, data: data });
    });
  });
}

function tfAppIds() {
  return tfRead('APP_ID').split(',').map((s) => s.trim()).filter((s) => s);
}

function tfRemoveId(id) {
  const rest = tfAppIds().filter((x) => x !== id);
  tfWrite(rest.join(','), 'APP_ID');
  return rest;
}

function tfErrText(error) {
  if (!error) return '';
  return String(error.message || error);
}

async function tfTryJoin(id, headers, accountKey) {
  const infoUrl = 'https://testflight.apple.com/v3/accounts/' + accountKey + '/ru/' + id;
  const res = await tfGet(infoUrl, headers);

  if (res.error) {
    const err = tfErrText(res.error);
    if (/timed out/i.test(err)) {
      console.log('[自动加入TF] ' + id + ' 查询超时，跳过本轮');
    } else if (err.indexOf('-1012') !== -1) {
      $notification.post('自动加入TF', '令牌已失效', '请重新打开 TestFlight App 获取令牌');
      console.log('[自动加入TF] ' + id + ' 令牌失效(-1012): ' + err);
    } else {
      $notification.post('自动加入TF', id + ' 查询出错', err);
      console.log('[自动加入TF] ' + id + ' 查询出错: ' + err);
    }
    return;
  }

  if (res.resp && res.resp.status === 404) {
    tfRemoveId(id);
    $notification.post('自动加入TF', id + ' 不存在该TF', '已自动删除该 APP_ID');
    console.log('[自动加入TF] ' + id + ' 不存在该TF，已自动删除该 APP_ID');
    return;
  }

  let json = null;
  try {
    json = JSON.parse(res.data || '');
  } catch (e) {
    console.log('[自动加入TF] ' + id + ' 返回无法解析，保留待重试');
    return;
  }

  if (!json || json.data === null || json.data === undefined) {
    const msg = json && json.messages && json.messages[0] ? json.messages[0].message : '未知返回';
    console.log('[自动加入TF] ' + id + ': ' + msg);
    return;
  }

  if (json.data.status === 'FULL') {
    const fullName = (json.data.app && json.data.app.name) || id;
    console.log('[自动加入TF] ' + fullName + ' (' + id + '): ' + (json.data.message || '名额已满'));
    return;
  }

  const acc = await tfPost(infoUrl + '/accept', headers);
  if (acc.error) {
    console.log('[自动加入TF] ' + id + ' 加入请求出错: ' + tfErrText(acc.error));
    return;
  }
  let appName = '';
  try {
    const accJson = JSON.parse(acc.data || '');
    appName = (accJson.data && accJson.data.name) || '';
  } catch (e) {
    appName = '';
  }
  if (!appName) {
    console.log('[自动加入TF] ' + id + ' 加入返回异常，保留待重试: ' + String(acc.data || '').slice(0, 120));
    return;
  }
  tfRemoveId(id);
  $notification.post('自动加入TF', '🎉 ' + appName, 'TestFlight 加入成功');
  console.log('[自动加入TF] 🎉 ' + appName + ' (' + id + ') TestFlight 加入成功');
}

(async function () {
  const accountKey = tfRead('key');
  const ids = tfAppIds();
  if (!accountKey || !tfRead('session_id')) {
    console.log('[自动加入TF] 尚未捕获令牌，请先打开 TestFlight App');
    $notification.post('自动加入TF', '尚未捕获令牌', '请先打开 TestFlight App 完成令牌捕获');
    $done();
    return;
  }
  if (ids.length === 0) {
    console.log('[自动加入TF] APP_ID 列表为空，无待加入的 TF');
    $done();
    return;
  }
  const headers = tfHeaders();
  for (const id of ids) {
    await tfTryJoin(id, headers, accountKey);
  }
  $done();
})();
