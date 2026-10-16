// AppStore 美区限免小组件（优化版 v2）
// 基于 IBL3ND/App_Store_Widget.JS 重写
//
// 更新日志：
//   2026-10-16 内购限免检测修复版：上一版两个 bug——①手机 UA 被 301 到
//              itms-appss:// 致 Egern 报 400；②用 </dl> 做段结束但实际是 </dd>。
//              改用桌面 UA 抓页、修正解析（>标题< 到 </dd>，提 <span>名/价</span>），
//              Duolingo 美区/国区真实页面验证通过。只保留至少 1 个内购现价为 0 的 App。
//   2026-10-11 展示排序改为"最新发现优先"：之前直接按 Apple lookup 返回顺序
//              展示（乱序），现在按 AppRaven 发现顺序（最新在前）组装
//   2026-10-10 数据链路重写：AppRaven 只做"发现"（过滤 priceTierTo == 0 的
//              真降到免费条目），再用 Apple iTunes Lookup 批量验证美区现价，
//              只有 price == 0 的才展示（防"已涨回去"）；标题改为"美区限免"
//   2026-10-10 初版：替换已失效的两个原数据源（见下），三源并行+缓存兜底
//   2026-10-11 配色移植：Bright AI 仪表盘配色（奶油底 #FAF6F0 + 主蓝 #3070F0 +
//              橘 #E07050 + 墨黑文字），限免徽标用橘色、可点击箭头用蓝色，
 //              深色模式为同色系暖黑变体
//
//
// 原版只有两个数据源，且都已失效：
// 1. api.zxki.cn/api/appfree —— 已下线，现在 302 跳转到一张 JPG 图片
// 2. api.03k.org/app/free —— 域名已无法连接
//
// （2026-10-10 实测）
// 1. AppRaven GraphQL 取近期调价动态（appsOnSale）
// 注意：这个接口返回的是"降价"动态，不全是免费，必须过滤 priceTierTo == 0
// 2. 用 Apple 官方 iTunes Lookup 接口批量验证美区现价（一次请求最多 200 个 ID）
// 只有 country=US 下 price == 0 的才算真限免 —— 防止展示"已涨回去"的应用
// 3. 全部失败时读 24 小时缓存兜底
//
// 用法：把本文件传到你的 GitHub 仓库，用 raw 链接替换 Egern 小组件的脚本 URL。

// Bright AI 配色移植（2026-10-11）：奶油底 + 白卡片 + 主蓝 + 橘点缀 + 墨黑文字
// 深色模式为同色系暖黑变体；所有色值唯一、无棕色
const THEME = {
bg:        { light: '#FAF6F0', dark: '#161310' }, // 页面奶油底 / 暖黑底
ink:       { light: '#1B1B1F', dark: '#F5F1E8' }, // 主文字
secondary: { light: '#8E8E93', dark: '#A39E93' }, // 次级文字
blue:      { light: '#3070F0', dark: '#7AA5FF' }, // 主色（可点击元素）
orange:    { light: '#E07050', dark: '#F0927A' }, // 点缀色（限免徽标）
divider:   { light: '#EAE3D8', dark: '#38322A' }, // 分隔线
};

export default async function(ctx) {
const widgetFamily = ctx.widgetFamily || 'systemMedium';

let maxItems = 7;
if (widgetFamily === 'systemLarge') {
maxItems = 12;
}
maxItems = parseInt(ctx.env?.maxItems) || maxItems;

if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
return {
type: 'widget',
padding: 16,
backgroundColor: THEME.bg,
children: [{
type: 'text',
text: '请使用中号或大号组件',
font: { size: 'callout'},
textColor: THEME.ink,
textAlign: 'center'
}]
};
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CACHE_KEY = 'appfree_us_v2';
const CACHE_TIME_KEY = 'appfree_us_v2_time';
const CACHE_TTL = 24 * 60 * 60 * 1000;

let apps = [];
let fromCache = false;
let cacheTime = 0;

try {
apps = await fetchVerifiedFreeApps(ctx, UA, 'US');
console.log(`美区限免：验证通过 ${apps.length} 款`);
} catch (e) {
console.log('主链路失败:', e.message);
}

if (apps.length > 0) {
try {
ctx.storage.setJSON(CACHE_KEY, apps);
ctx.storage.set(CACHE_TIME_KEY, Date.now().toString());
} catch (e) { /* ignore */}
} else {
const cached = readCache(ctx, CACHE_KEY, CACHE_TIME_KEY, CACHE_TTL);
if (cached) {
apps = cached.apps;
fromCache = true;
cacheTime = cached.time;
console.log(`使用缓存，共 ${apps.length} 款`);
}
}

return buildWidget(apps.slice(0, maxItems), fromCache, cacheTime, '🎁 美区限免');
};

function readCache(ctx, key, timeKey, ttl) {
try {
const cached = ctx.storage.getJSON(key);
const t = parseInt(ctx.storage.get(timeKey) || '0');
if (cached && cached.length > 0 && t && Date.now() - t < ttl) {
return { apps: cached, time: t};
}
} catch (e) { /* ignore */}
return null;
}

// ============ 数据链路 ============

// 拉取 AppRaven 调价动态 → 过滤降到免费 → iTunes Lookup 批量验证现价
async function fetchVerifiedFreeApps(ctx, UA, country) {
const query = `query WidgetSale($page: Int!, $pageSize: Int!) {
appsOnSale(rareOnly: false, miniFilter: {ratingCount: 10}, page: $page, pageSize: $pageSize) {
content {
id
timestamp
app { id title ITunesId}
... on AppActivityPriceChange { priceChangeType: type priceTierFrom priceTierTo}
}
}
}`;

// 两页并行拉取近期动态
const pages = await Promise.all([0, 1, 2].map(page =>
ctx.http.post('https://appraven.net/appraven/graphql', {
timeout: 12000,
headers: {
'Content-Type': 'application/json',
'Accept': 'application/json',
'User-Agent': UA,
},
body: JSON.stringify({ query, variables: { page, pageSize: 30}}),
}).then(async (resp) => {
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('AppRaven HTTP ' + status);
const json = await resp.json();
if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors).slice(0, 100));
const items = json?.data?.appsOnSale?.content;
return Array.isArray(items)? items: [];
})
));

// 只保留"降到免费"（priceTierTo == 0）的条目，去重
const seen = new Set();
const freeIds = [];
for (const items of pages) {
for (const it of items) {
if (it.priceTierTo!== 0) continue; // 只是降价、没免费 → 不要
const app = it.app || {};
const tid = app.ITunesId? String(app.ITunesId): '';
if (tid &&!seen.has(tid)) {
seen.add(tid);
freeIds.push(tid);
}
}
}
if (freeIds.length === 0) return [];
console.log(`AppRaven 发现降到免费: ${freeIds.length} 款`);

// Apple 官方接口批量验证该区现价（一次最多 200 个）
const resp = await ctx.http.get(
`https://itunes.apple.com/lookup?id=${freeIds.slice(0, 100).join(',')}&country=${country}`,
{ timeout: 12000, headers: { 'Accept': 'application/json', 'User-Agent': UA}}
);
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('iTunes Lookup HTTP ' + status);
const data = await resp.json();

// 按发现顺序（最新在前）组装：lookup 返回的顺序是乱的，必须按 ids 的顺序取
const byId = {};
for (const r of (data.results || [])) {
byId[String(r.trackId)] = r;
}
const apps = [];
for (const tid of freeIds.slice(0, 100)) {
const r = byId[tid];
if (!r) continue; // 该区未上架 → 不要
if (Number(r.price)!== 0) continue; // 已涨回去 → 不要
const name = (r.trackName || '').trim(); 
if (!name) continue;
apps.push({
name: name.length > 50? name.substring(0, 50).trim() + '...': name,
url: r.trackViewUrl || `https://apps.apple.com/app/id${r.trackId}`,
kind: 'app',
tid: tid,
});
}
return await filterByFreeIAP(ctx, UA, apps, 'US');
}

// ============ 内购限免检测 ============
// iTunes Lookup 无内购字段；抓 apps.apple.com 应用页（桌面 UA，服务端渲染 HTML
// 内含内购名/价格）。只保留"至少 1 个内购现价为 0"的 App。
// 注意：手机 UA 会被 301 到 itms-appss://，必须用桌面 UA。
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IAP_SECTION_TITLES = ['In-App Purchases', 'App内购买'];
const IAP_CACHE_TTL = 6 * 60 * 60 * 1000; // 内购页按应用缓存 6 小时
function parseIAPPrice(s) {
if (!s) return NaN;
const t = String(s).trim();
if (/^(free|\u514d\u8d39)$/i.test(t)) return 0;
const n = parseFloat(t.replace(/[^0-9.]/g, ''));
return isNaN(n) ? NaN : n;
}
function extractIAPPairs(html) {
for (const title of IAP_SECTION_TITLES) {
const dtIdx = html.indexOf('>' + title + '<');
if (dtIdx < 0) continue;
const endIdx = html.indexOf('</dd>', dtIdx);
if (endIdx < 0) continue;
const section = html.slice(dtIdx, endIdx);
const pairs = [];
const re = /<span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g;
let m;
while ((m = re.exec(section)) !== null) {
pairs.push({ name: m[1].trim(), price: m[2].trim() });
}
if (pairs.length) return pairs;
}
return [];
}
async function appHasFreeIAP(ctx, UA, app, country) {
const tid = app.tid || app.url || app.name;
const cacheKey = `iap_${country}_${tid}`;
try {
const c = ctx.storage.getJSON(cacheKey);
if (c && c.time && Date.now() - c.time < IAP_CACHE_TTL && Array.isArray(c.pairs)) {
return c.pairs.some(p => parseIAPPrice(p.price) === 0);
}
} catch (e) { /* ignore */ }
let pairs = [];
try {
const resp = await ctx.http.get(app.url, {
timeout: 15000,
headers: { 'Accept': 'text/html', 'User-Agent': UA_DESKTOP },
});
if (Number(resp.status || 0) === 200) {
const html = await resp.text();
pairs = extractIAPPairs(html);
} else {
throw new Error('HTTP ' + resp.status);
}
} catch (e) {
console.log(`内购页抓取失败 ${app.name}: ${e.message}`);
}
try {
ctx.storage.setJSON(cacheKey, { pairs, time: Date.now() });
} catch (e) { /* ignore */ }
return pairs.some(p => parseIAPPrice(p.price) === 0);
}
async function filterByFreeIAP(ctx, UA, apps, country) {
if (!apps.length) return [];
const results = await Promise.all(apps.map(async (app) => {
try {
return (await appHasFreeIAP(ctx, UA, app, country)) ? app : null;
} catch (e) {
return null;
}
}));
const kept = results.filter(Boolean);
console.log(`内购限免过滤(${country}): ${apps.length} → ${kept.length} 款`);
return kept;
}

// ============ 构建组件 ============

function buildWidget(apps, fromCache, cacheTime, title) {
const children = [];

const t = fromCache && cacheTime? new Date(cacheTime): new Date();
const timeStr = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
const timeLabel = fromCache? `缓存 ${timeStr}`: timeStr;

children.push({
type: 'stack',
direction: 'row',
alignItems: 'center',
padding: [0, 0, 6, 0],
children: [
{
type: 'text',
text: `${title} · ${apps.length}款`,
font: { size: 'subheadline', weight: 'bold'},
textColor: THEME.ink,
flex: 1
},
{
type: 'stack',
direction: 'row',
alignItems: 'center',
gap: 4,
children: [
{
type: 'image',
src: 'sf-symbol:arrow.clockwise',
width: 14,
height: 14,
color: THEME.secondary
},
{
type: 'text',
text: timeLabel,
font: { size: 'caption2'},
textColor: THEME.secondary
}
]
}
]
});

if (apps.length === 0) {
children.push({
type: 'text',
text: '暂无限免应用\n\n请检查网络或稍后再试',
font: { size: 'callout'},
textColor: THEME.secondary,
textAlign: 'center',
padding: [20, 0]
});
} else {
apps.forEach((app, i) => {
if (i > 0) {
children.push({
type: 'stack',
height: 0.5,
backgroundColor: THEME.divider,
margin: [4, 0]
});
}
children.push({
type: 'stack',
direction: 'row',
alignItems: 'center',
gap: 10,
url: app.url,
padding: [4, 0],
children: [
{
type: 'text',
text: app.name,
font: { size: 'subheadline'},
textColor: THEME.ink,
flex: 1,
maxLines: 2,
minScale: 0.85
},
{
type: 'text',
text: '限免',
font: { size: 'caption2', weight: 'semibold'},
textColor: THEME.orange,
maxLines: 1
},
{
type: 'image',
src: 'sf-symbol:chevron.right',
width: 12,
height: 12,
color: THEME.blue
}
]
});
});
}

return {
type: 'widget',
padding: [10, 12, 10, 12],
gap: 4,
backgroundColor: THEME.bg,
refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
children: children
};
}
