/**
 * TestFlight 监控 + 自动加入
 *
 * 基础：iBL3ND 的《TestFlight 监控》（IBL3ND/module）——纯定时脚本，
 * 每分钟抓 testflight.apple.com/join/{ID} 网页判断名额并通知，
 * 不走 MITM，所以不影响 TestFlight App 正常打开。
 *
 * 本版新增（v1.0.0，2026-10-22，Muse 扩展）：
 *   探测到「可加入」时，若 Egern 持久化存储里已有 TF 账号令牌，
 *   直接调官方 API 自动加入（GET /v3/accounts/{key}/ru/{ID} 查状态，
 *   非 FULL 即 POST .../accept，流程与 DecoAri/fmz200 原版一致）；
 *   没有令牌时行为与原版监控完全相同（通知你手动点链接加入）。
 *   加入成功会记入存储 tf_autojoin_joined，之后只记日志、不再重复
 *   尝试也不再刷通知；API 返回 404 的邀请码记入 tf_autojoin_dead
 *   只通知一次；加入失败（含 401 令牌失效）的通知按 ID 节流 3 小时。
 *
 * 令牌怎么来（只需一次）：Egern 的 MITM 与 TestFlight App 握手不
 * 兼容（TLS EOF），请用 Quantumult X 的 fmz200 AutoJoinTFKeys.js
 * 抓一次，把字段抄进配套一次性脚本 TF_token_fill.egern.js 运行
 * 写入存储（键：key / session_id / session_digest / request_id /
 * X-Apple-AMD-M / TFUA），本脚本与填入脚本共用同一批键。
 *
 * 环境变量：TF = 要监控的邀请码，多个英文逗号分隔，可带 #备注名，
 * 示例：hmC52rdF,b6X29Sva#某应用
 * Cron：* * * * * ?（每分钟，与原版一致）
 */

const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_7_9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_0_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
];

const FAIL_NOTIFY_INTERVAL = 3 * 3600 * 1000; // 加入失败通知节流：同一 ID 3 小时一次

function sGet(ctx, k) {
  try { return ctx.storage.get(k); } catch (e) { return null; }
}

function loadMap(ctx, k) {
  try {
    const v = ctx.storage.getJSON(k);
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}

function buildApiHeaders(ctx) {
  const pairs = [
    ['X-Session-Id', sGet(ctx, 'session_id')],
    ['X-Session-Digest', sGet(ctx, 'session_digest')],
    ['X-Request-Id', sGet(ctx, 'request_id')],
    ['X-Apple-AMD-M', sGet(ctx, 'X-Apple-AMD-M')],
    ['User-Agent', sGet(ctx, 'TFUA')],
  ];
  const h = {};
  for (const [k, v] of pairs) if (v) h[k] = v;
  return h;
}

// 调 API 尝试自动加入；返回 {outcome, apiName?, message?}
// outcome: joined | full | dead | fail | msg（data==null，保留待下轮）
async function tryAutoJoin(ctx, appId, apiHeaders) {
  const accountKey = sGet(ctx, 'key');
  const ruUrl = `https://testflight.apple.com/v3/accounts/${accountKey}/ru/${appId}`;
  const resp = await ctx.http.get(ruUrl, { headers: apiHeaders, timeout: 15000 });
  if (resp.status === 404) return { outcome: 'dead' };
  if (resp.status === 401) return { outcome: 'fail', message: '401：令牌可能已过期（或请求过于频繁），请重新抓取令牌' };
  const json = await resp.json().catch(() => null);
  if (!json || json.data == null) {
    const msg = json && json.messages && json.messages[0] ? json.messages[0].message : `HTTP ${resp.status}`;
    return { outcome: 'msg', message: msg };
  }
  if (json.data.status === 'FULL') return { outcome: 'full' };
  const acc = await ctx.http.post(ruUrl + '/accept', { headers: apiHeaders, timeout: 15000 });
  const accJson = await acc.json().catch(() => null);
  if (acc.status === 200 && accJson && accJson.data && accJson.data.name) {
    return { outcome: 'joined', apiName: accJson.data.name };
  }
  const msg = accJson && accJson.messages && accJson.messages[0] ? accJson.messages[0].message : `HTTP ${acc.status}`;
  return { outcome: 'fail', message: msg };
}

export default async function(ctx) {
  const rawIds = ctx.env.TF || "";
  if (!rawIds.trim()) return;

  const appIds = rawIds.split(/\s*[\n,，;]\s*/).filter(Boolean);
  const getRandomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

  const accountKey = sGet(ctx, 'key');
  const hasToken = !!(accountKey && sGet(ctx, 'session_id'));
  const apiHeaders = hasToken ? buildApiHeaders(ctx) : null;

  const joined = loadMap(ctx, 'tf_autojoin_joined');
  const dead = loadMap(ctx, 'tf_autojoin_dead');
  const failTs = loadMap(ctx, 'tf_autojoin_fail_ts');
  let dirty = false;

  const notifyFail = (appId, label, message) => {
    const now = Date.now();
    if (failTs[appId] && now - failTs[appId] < FAIL_NOTIFY_INTERVAL) {
      console.log(`[TF AutoJoin] ${label} 加入失败（通知节流中）：${message}`);
      return;
    }
    failTs[appId] = now;
    dirty = true;
    ctx.notify({
      title: "TestFlight 自动加入失败",
      subtitle: label,
      body: String(message || '未知错误'),
    });
  };

  console.log(`[TF Monitor] 开始检查：[${appIds}] 自动加入：${hasToken ? '开（已存令牌）' : '关（无令牌，仅监控通知）'}`);

  for (const appIdInfo of appIds) {
    let appId = appIdInfo;
    let appName = "";

    if (appIdInfo.includes("#")) {
      appId = appIdInfo.split("#")[0].trim();
      appName = appIdInfo.split("#")[1].trim();
    }
    const label = appName ? `${appName} (${appId})` : `ID: ${appId}`;

    if (joined[appId]) {
      console.log(`[✓] ${appIdInfo} → 已自动加入，跳过`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    if (dead[appId]) {
      console.log(`[D] ${appIdInfo} → 邀请码不存在（已标记），跳过`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const url = `https://testflight.apple.com/join/${appId}`;

    try {
      const resp = await ctx.http.get(url, {
        headers: { "User-Agent": getRandomUA() },
        timeout: 10000
      });

      if (resp.status === 404) {
        console.log(`[D] ${appIdInfo} → 不存在 ⚠️`);
        continue;
      }

      if (resp.status !== 200) {
        console.log(`[?] ${appIdInfo} → 状态码: ${resp.status}`);
        continue;
      }

      const data = await resp.text();

      if (/版本的测试员已满|This beta is full|此 beta 版已额满/.test(data)) {
        console.log(`[F] ${appIdInfo} → 已满`);
      }
      else if (/版本目前不接受任何新测试员|This beta isn't accepting any new testers/.test(data)) {
        console.log(`[N] ${appIdInfo} → 暂不接受新成员`);
      }
      else if (/要加入 Beta 版|To join the|开始测试|itms-beta:\/\/|join the beta/.test(data)) {
        console.log(`[Y] ${appIdInfo} → 可加入 ✅`);

        if (!hasToken) {
          // 无令牌：与原版监控行为一致，通知手动加入
          ctx.notify({
            title: "TestFlight 有名额了！",
            subtitle: appName ? `${appName} (${appId})` : `ID: ${appId}`,
            body: "🚀 探测到新名额，请立即点击加入测试",
            action: { type: "openUrl", url: url }
          });
        } else {
          try {
            const r = await tryAutoJoin(ctx, appId, apiHeaders);
            if (r.outcome === 'joined') {
              joined[appId] = { name: r.apiName, ts: Date.now() };
              dirty = true;
              console.log(`[✓] ${appIdInfo} → 自动加入成功：${r.apiName}`);
              ctx.notify({
                title: "TestFlight 已自动加入 ✅",
                subtitle: label,
                body: `🎉 已成功加入「${r.apiName}」的测试，可把该 ID 从监控列表移除`,
                action: { type: "openUrl", url: url }
              });
            } else if (r.outcome === 'full') {
              console.log(`[F] ${appIdInfo} → 网页显示可加入但 API 返回 FULL，以 API 为准`);
            } else if (r.outcome === 'dead') {
              dead[appId] = Date.now();
              dirty = true;
              console.log(`[D] ${appIdInfo} → API 返回 404，邀请码不存在，已标记不再尝试`);
              ctx.notify({
                title: "TestFlight 邀请码不存在",
                subtitle: label,
                body: "该邀请码已失效，请从监控列表移除",
              });
            } else if (r.outcome === 'msg') {
              console.log(`[?] ${appIdInfo} → API 返回：${r.message}（保留，下轮重试）`);
            } else {
              notifyFail(appId, label, r.message);
            }
          } catch (e) {
            notifyFail(appId, label, e && e.message);
          }
        }
      } else {
        console.log(`[?] ${appIdInfo} → 状态未知`);
      }

    } catch (e) {
      console.log(`[!] ${appIdInfo} → 请求出错: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (dirty) {
    try {
      ctx.storage.setJSON('tf_autojoin_joined', joined);
      ctx.storage.setJSON('tf_autojoin_dead', dead);
      ctx.storage.setJSON('tf_autojoin_fail_ts', failTs);
    } catch (e) {
      console.log('[TF AutoJoin] 保存状态失败: ' + (e && e.message));
    }
  }
}
