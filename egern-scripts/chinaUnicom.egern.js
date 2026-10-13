/* ============================================================
 * 中国联通签到 —— Egern 移植版 v1.0.8
 * 由 QingLong Python 版 (YaoHuo8648, v1.0.8) 完整移植
 *
 * 功能：首页签到 / 联通祝福 / 天天领现金 / 权益超市 / 安全管家 /
 *       联通云盘 / 联通阅读 / 联通爱听 / 沃云手机 / 区域专区
 *
 * 使用：Egern 模块 Schedule 类型引用本脚本，环境变量配置：
 *   UNICOM_COOKIE   账号配置（必填），格式与青龙版 chinaUnicomCookie 一致：
 *                   手机号#密码 ｜ token#appId ｜ token，多账号用 & 或换行隔开
 *   以下为可选（默认值见 globalConfig）：
 *   UNICOM_ENABLE_SIGN / UNICOM_ENABLE_TTLXJ / ... 各模块总开关 (true/false)
 *   UNICOM_GRAB_AMOUNT  抢兑面额，默认 5
 *   UNICOM_TEST_MODE    设为 query 则仅查询不执行任务
 *
 * 更新日志：
 *   2026-10-13 v1.0.0：完整移植 Python v1.0.8（7124 行 / 282 函数）；
 *     纯 JS 加密库（MD5/HMAC-SHA256/AES-CBC/RSA）经 Python/Node/OpenSSL 交叉验证；
 *     签名算法（wocare/aiting/yunnan）逐字节对照通过；全量 node --check 通过。
 *   2026-10-13 v1.0.1：修复 Egern 报错“Cannot declare a function that shadows
 *     'fmtYmdHms14'”——去重顶层函数定义（移入骨架）。
 *   2026-10-13 v1.0.2：修复日志空白——blog()/this.log() 只写 blogLines 数组
 *     从不输出，改为同步 console.log（与现有 Egern 脚本一致）；
 *     修复 ctxStorage 从未注入导致 token 缓存失效；storageGetJSON/SetJSON
 *     改用 ctx.storage.get/set（Egern 实际 API）。
 *   2026-10-13 v1.0.3：修复云盘清理 400——rawRequest 的 opts.json 改用
 *     jsonDumpsAscii（对应 Python ensure_ascii=True，中文转 \uXXXX）；
 *     沃云手机加 businessHall 返回 data 调试日志；
 *     修复爱听 access_token 硬编码抄错一位（32 vs 33 字符）；
 *     aiting_login_flow 加 mobile 兜底。
 * ============================================================ */

// ---------------- 基础工具 ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 由最终 export 函数在运行入口赋值（脚本加载时为空，env() 此时返回默认值）
var ctxEnv = {};
var ctxStorage = null;

function env(name, defVal) {
  try {
    const v = ctxEnv ? ctxEnv[name] : undefined;
    return (v === undefined || v === null || v === "") ? defVal : v;
  } catch (e) { return defVal; }
}
function envBool(name, defVal) {
  const v = env(name, undefined);
  if (v === undefined) return defVal;
  return String(v).toLowerCase() === "true";
}
function envInt(name, defVal) {
  const v = parseInt(env(name, ""), 10);
  return isNaN(v) ? defVal : v;
}
function envFloat(name, defVal) {
  const v = parseFloat(env(name, ""));
  return isNaN(v) ? defVal : v;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtTime(d) { d = d || new Date(); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
function fmtDateTime(d) { d = d || new Date(); return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()) + " " + fmtTime(d); }
function fmtDateSlash(d) { d = d || new Date(); return d.getFullYear() + "/" + pad2(d.getMonth()+1) + "/" + pad2(d.getDate()); }
function fmtYmdHms(d) { // Python: '%Y%m%d%H%M%S' + 毫秒3位
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth()+1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + String(d.getMilliseconds()).padStart(3, "0");
}

function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function randFloat(a, b) { return a + Math.random() * (b - a); }
function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomString(len, chars) {
  chars = chars || "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function uuid32() {
  return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random()*16).toString(16));
}
function safeInt(v, defVal) {
  try { const n = parseInt(String(v).trim(), 10); return isNaN(n) ? (defVal||0) : n; }
  catch (e) { return defVal || 0; }
}
function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }

function mask_str(s) {
  try {
    s = String(s);
    if (s.length === 11 && /^\d+$/.test(s)) return s.slice(0,3) + "****" + s.slice(7);
    if (s.indexOf("enc_") === 0) return s;
    if (s.length > 11) return s.slice(0,6) + "******" + s.slice(-6);
    return s;
  } catch (e) { return s; }
}

// ---------------- 字节 / UTF-8 / Base64 / Hex（纯 JS，不依赖运行环境） ----------------
function utf8Bytes(s) {
  s = String(s);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i+1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}
function utf8Decode(bytes) {
  let s = "", i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f)); }
    else if (c < 0xf0) { s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)); }
    else {
      const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return s;
}
const B64ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i+1 < bytes.length ? bytes[i+1] : 0, b2 = i+2 < bytes.length ? bytes[i+2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    s += B64ABC[(n >> 18) & 63] + B64ABC[(n >> 12) & 63] + (i+1 < bytes.length ? B64ABC[(n >> 6) & 63] : "=") + (i+2 < bytes.length ? B64ABC[n & 63] : "=");
  }
  return s;
}
function b64decode(s) {
  s = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  const rev = {};
  for (let i = 0; i < 64; i++) rev[B64ABC[i]] = i;
  for (let i = 0; i < s.length; i += 4) {
    const n = (rev[s[i]] << 18) | (rev[s[i+1]] << 12) | ((rev[s[i+2]] || 0) << 6) | (rev[s[i+3]] || 0);
    out.push((n >> 16) & 255);
    if (s[i+2] !== "=") out.push((n >> 8) & 255);
    if (s[i+3] !== "=") out.push(n & 255);
  }
  return out;
}
function hexBytes(hex) {
  hex = String(hex).replace(/\s+/g, "");
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}
function bytesToHex(bytes) {
  return bytes.map((b) => ("0" + (b & 255).toString(16)).slice(-2)).join("");
}
function concatBytes() {
  const out = [];
  for (let i = 0; i < arguments.length; i++) {
    const a = arguments[i];
    for (let j = 0; j < a.length; j++) out.push(a[j] & 255);
  }
  return out;
}

// ---------------- MD5（纯 JS） ----------------
const MD5_T = [];
for (let i = 0; i < 64; i++) MD5_T.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
const MD5_S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
               5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
               4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
               6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
function md5Bytes(input) {
  const msg = input.slice();
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 0; i < 8; i++) msg.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 255);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const add = (x, y) => (x + y) >>> 0;
  for (let off = 0; off < msg.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M.push((msg[off+i*4] | (msg[off+i*4+1] << 8) | (msg[off+i*4+2] << 16) | (msg[off+i*4+3] << 24)) >>> 0);
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7*i) % 16; }
      F = add(add(add(F, A), MD5_T[i]), M[g]);
      A = D; D = C; C = B;
      B = add(B, rol(F, MD5_S[i]));
    }
    a = add(a, A); b = add(b, B); c = add(c, C); d = add(d, D);
  }
  const out = [];
  [a, b, c, d].forEach((w) => { for (let i = 0; i < 4; i++) out.push((w >>> (i*8)) & 255); });
  return out;
}
function md5(s) { return bytesToHex(md5Bytes(typeof s === "string" ? utf8Bytes(s) : s)); }

// ---------------- SHA256（纯 JS，常量程序化生成） ----------------
function firstPrimes(n) {
  const ps = []; let c = 2;
  while (ps.length < n) { let ok = true; for (const p of ps) { if (p*p > c) break; if (c % p === 0) { ok = false; break; } } if (ok) ps.push(c); c++; }
  return ps;
}
const SHA256_K = firstPrimes(64).map((p) => Math.floor((Math.cbrt(p) % 1) * 4294967296) >>> 0);
const SHA256_H0 = firstPrimes(8).map((p) => Math.floor((Math.sqrt(p) % 1) * 4294967296) >>> 0);
function sha256Bytes(input) {
  const msg = input.slice();
  const bitLenHi = Math.floor(msg.length / 0x20000000), bitLenLo = (msg.length * 8) >>> 0;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  msg.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255,
           (bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const add = (...xs) => xs.reduce((a, b) => (a + b) >>> 0, 0);
  let H = SHA256_H0.slice();
  for (let off = 0; off < msg.length; off += 64) {
    const W = [];
    for (let i = 0; i < 16; i++) W.push(((msg[off+i*4] << 24) | (msg[off+i*4+1] << 16) | (msg[off+i*4+2] << 8) | msg[off+i*4+3]) >>> 0);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
      W.push(add(W[i-16], s0, W[i-7], s1));
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = add(h, S1, ch, SHA256_K[i], W[i]);
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = add(S0, maj);
      h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
    }
    H = [add(H[0],a), add(H[1],b), add(H[2],c), add(H[3],d), add(H[4],e), add(H[5],f), add(H[6],g), add(H[7],h)];
  }
  const out = [];
  H.forEach((w) => { out.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255); });
  return out;
}
function sha256(s) { return bytesToHex(sha256Bytes(typeof s === "string" ? utf8Bytes(s) : s)); }
function hmacSha256Bytes(key, msg) {
  let kb = typeof key === "string" ? utf8Bytes(key) : key.slice();
  const mb = typeof msg === "string" ? utf8Bytes(msg) : msg;
  if (kb.length > 64) kb = sha256Bytes(kb);
  while (kb.length < 64) kb.push(0);
  const ipad = kb.map((b) => b ^ 0x36), opad = kb.map((b) => b ^ 0x5c);
  return sha256Bytes(concatBytes(opad, sha256Bytes(concatBytes(ipad, mb))));
}
function hmacSha256(key, msg) {
  return bytesToHex(hmacSha256Bytes(key, msg));
}

// ---------------- AES（纯 JS，S 盒程序化生成，支持 128/192/256） ----------------
const AES_SBOX = new Array(256), AES_INV_SBOX = new Array(256);
(function buildSbox() {
  const xt = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255;
  const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
  const inv = (a) => { if (!a) return 0; for (let b = 1; b < 256; b++) if (mul(a, b) === 1) return b; return 0; };
  for (let i = 0; i < 256; i++) {
    const v = inv(i);
    const s = v ^ ((v << 1) | (v >> 7)) ^ ((v << 2) | (v >> 6)) ^ ((v << 3) | (v >> 5)) ^ ((v << 4) | (v >> 4)) ^ 0x63;
    AES_SBOX[i] = s & 255;
    AES_INV_SBOX[s & 255] = i;
  }
})();
function aesKeyExpand(keyBytes) {
  const nk = keyBytes.length / 4, nr = nk + 6, nb = 4;
  const w = [];
  for (let i = 0; i < nk; i++) w.push((keyBytes[4*i] << 24) | (keyBytes[4*i+1] << 16) | (keyBytes[4*i+2] << 8) | keyBytes[4*i+3]);
  let rcon = 1;
  for (let i = nk; i < nb * (nr + 1); i++) {
    let t = w[i-1];
    if (i % nk === 0) {
      t = ((AES_SBOX[(t >> 16) & 255] << 24) | (AES_SBOX[(t >> 8) & 255] << 16) | (AES_SBOX[t & 255] << 8) | AES_SBOX[(t >>> 24)]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1b : 0)) & 255;
    } else if (nk > 6 && i % nk === 4) {
      t = (AES_SBOX[(t >>> 24)] << 24) | (AES_SBOX[(t >> 16) & 255] << 16) | (AES_SBOX[(t >> 8) & 255] << 8) | AES_SBOX[t & 255];
    }
    w.push((w[i-nk] ^ t) >>> 0);
  }
  return { w, nr };
}
function aesAddRoundKey(s, w, round) {
  for (let c = 0; c < 4; c++) {
    const k = w[round*4 + c];
    s[c*4] ^= (k >>> 24) & 255; s[c*4+1] ^= (k >>> 16) & 255; s[c*4+2] ^= (k >>> 8) & 255; s[c*4+3] ^= k & 255;
  }
}
function aesSubBytes(s, inv) { const box = inv ? AES_INV_SBOX : AES_SBOX; for (let i = 0; i < 16; i++) s[i] = box[s[i]]; }
function aesShiftRows(s, inv) {
  for (let r = 1; r < 4; r++) {
    const t = [s[r], s[r+4], s[r+8], s[r+12]];
    for (let c = 0; c < 4; c++) s[r + c*4] = inv ? t[(c + 4 - r) % 4] : t[(c + r) % 4];
  }
}
function aesMixColumns(s, inv) {
  const xt = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255;
  const m2 = xt;
  const m3 = (a) => xt(a) ^ a;
  const m9 = (a) => xt(xt(xt(a))) ^ a, me = (a) => xt(xt(xt(a))) ^ xt(xt(a)) ^ xt(a);
  const mb = (a) => xt(xt(xt(a))) ^ xt(a) ^ a, md = (a) => xt(xt(xt(a))) ^ xt(xt(a)) ^ a;
  for (let c = 0; c < 4; c++) {
    const a0 = s[c*4], a1 = s[c*4+1], a2 = s[c*4+2], a3 = s[c*4+3];
    if (!inv) { s[c*4] = m2(a0)^m3(a1)^a2^a3; s[c*4+1] = a0^m2(a1)^m3(a2)^a3; s[c*4+2] = a0^a1^m2(a2)^m3(a3); s[c*4+3] = m3(a0)^a1^a2^m2(a3); }
    else { s[c*4] = me(a0)^mb(a1)^md(a2)^m9(a3); s[c*4+1] = m9(a0)^me(a1)^mb(a2)^md(a3); s[c*4+2] = md(a0)^m9(a1)^me(a2)^mb(a3); s[c*4+3] = mb(a0)^md(a1)^m9(a2)^me(a3); }
  }
}
function aesEncryptBlock(block16, keyBytes) {
  const { w, nr } = aesKeyExpand(keyBytes);
  const s = block16.slice();
  aesAddRoundKey(s, w, 0);
  for (let r = 1; r < nr; r++) { aesSubBytes(s, false); aesShiftRows(s, false); aesMixColumns(s, false); aesAddRoundKey(s, w, r); }
  aesSubBytes(s, false); aesShiftRows(s, false); aesAddRoundKey(s, w, nr);
  return s;
}
function aesDecryptBlock(block16, keyBytes) {
  const { w, nr } = aesKeyExpand(keyBytes);
  const s = block16.slice();
  aesAddRoundKey(s, w, nr);
  for (let r = nr - 1; r >= 1; r--) { aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, w, r); aesMixColumns(s, true); }
  aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, w, 0);
  return s;
}
function aesCbcEncrypt(plainBytes, keyBytes, ivBytes) {
  const out = []; let prev = ivBytes.slice();
  for (let off = 0; off < plainBytes.length; off += 16) {
    const blk = plainBytes.slice(off, off + 16).map((b, i) => b ^ prev[i]);
    const enc = aesEncryptBlock(blk, keyBytes);
    out.push(...enc); prev = enc;
  }
  return out;
}
function aesCbcDecrypt(cipherBytes, keyBytes, ivBytes) {
  const out = []; let prev = ivBytes.slice();
  for (let off = 0; off < cipherBytes.length; off += 16) {
    const blk = cipherBytes.slice(off, off + 16);
    const dec = aesDecryptBlock(blk, keyBytes);
    out.push(...dec.map((b, i) => b ^ prev[i])); prev = blk;
  }
  return out;
}
function pkcs7Pad(bytes, blockSize) {
  blockSize = blockSize || 16;
  const n = blockSize - (bytes.length % blockSize);
  return bytes.concat(new Array(n).fill(n));
}
function pkcs7Unpad(bytes) {
  const n = bytes[bytes.length - 1];
  if (n < 1 || n > 16) throw new Error("bad pkcs7 padding");
  return bytes.slice(0, bytes.length - n);
}

// ---------------- RSA PKCS#1 v1.5 加密（BigInt；n/e 由 Python 预解析硬编码） ----------------
const RSA_N_HEX = "dcf8264af5b040f4853e81950e73a1541aeef23bd5a94cd0743f39a014187de8c8355aba2f0f5a2a67e7881782e3bf129718e748efd25176f7bd34f850a34efebaa190804e229b0367471ecf16d091af288811c5286afb8db6e455a01026eaa741d12adcb606aa19f2e02af6473a7c138f236a8c1531ccc7909440b673310c4b";
const RSA_E_HEX = "10001";
function bigintPowMod(base, exp, mod) {
  let r = 1n;
  base = base % mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; base = (base * base) % mod; exp >>= 1n; }
  return r;
}
function rsaEncryptPkcs1v15(dataStr) {
  // 对应 Python: PKCS1_v1_5.new(RSA.import_key(LOGIN_PUB_KEY)).encrypt((val + 6位随机数).encode())
  const data = utf8Bytes(String(dataStr) + randomString(6, "0123456789"));
  const k = 128; // 1024 bit
  if (data.length > k - 11) throw new Error("RSA data too long");
  const psLen = k - data.length - 3;
  const ps = [];
  while (ps.length < psLen) { const b = 1 + Math.floor(Math.random() * 254); if (b !== 0) ps.push(b); }
  const em = [0x00, 0x02].concat(ps, [0x00], data);
  const m = BigInt("0x" + bytesToHex(em));
  const c = bigintPowMod(m, BigInt("0x" + RSA_E_HEX), BigInt("0x" + RSA_N_HEX));
  let hex = c.toString(16);
  hex = "0".repeat(k * 2 - hex.length) + hex;
  return b64encode(hexBytes(hex));
}

// ---------------- 全局配置（默认与 Python 版一致；export 入口处 refreshGlobalConfig() 会用环境变量覆盖） ----------------
let globalConfig = {
  enable_sign: true,
  enable_ttlxj: true,
  enable_ttxc: true,
  enable_ltzf: true,
  enable_woread: false,
  enable_security: true,
  enable_ltyp: true,
  enable_market: true,
  enable_aiting: true,
  enable_wostore: true,
  enable_regional: true,
  sign_config: { run_grab_coupon: false },
  market_config: { run_water: true, run_task: true, run_member_center: true, run_draw: true, run_claim: true },
  regional_config: { run_ah_friday: true },
  refresh_device_id: false,
};
function refreshGlobalConfig() {
  globalConfig.enable_sign = envBool("UNICOM_ENABLE_SIGN", true);
  globalConfig.enable_ttlxj = envBool("UNICOM_ENABLE_TTLXJ", true);
  globalConfig.enable_ttxc = envBool("UNICOM_ENABLE_TTXC", true);
  globalConfig.enable_ltzf = envBool("UNICOM_ENABLE_LTZF", true);
  globalConfig.enable_woread = envBool("UNICOM_ENABLE_WOREAD", false);
  globalConfig.enable_security = envBool("UNICOM_ENABLE_SECURITY", true);
  globalConfig.enable_ltyp = envBool("UNICOM_ENABLE_LTYP", true);
  globalConfig.enable_market = envBool("UNICOM_ENABLE_MARKET", true);
  globalConfig.enable_aiting = envBool("UNICOM_ENABLE_AITING", true);
  globalConfig.enable_wostore = envBool("UNICOM_ENABLE_WOSTORE", true);
  globalConfig.enable_regional = envBool("UNICOM_ENABLE_REGIONAL", true);
  globalConfig.sign_config.run_grab_coupon = envBool("UNICOM_SIGN_GRAB_COUPON", false);
  globalConfig.market_config.run_water = envBool("UNICOM_MARKET_WATER", true);
  globalConfig.market_config.run_task = envBool("UNICOM_MARKET_TASK", true);
  globalConfig.market_config.run_member_center = envBool("UNICOM_MARKET_MEMBER_CENTER", true);
  globalConfig.market_config.run_draw = envBool("UNICOM_MARKET_DRAW", true);
  globalConfig.market_config.run_claim = envBool("UNICOM_MARKET_CLAIM", true);
  globalConfig.regional_config.run_ah_friday = envBool("UNICOM_REGIONAL_AH_FRIDAY", true);
  globalConfig.refresh_device_id = envBool("UNICOM_REFRESH_DEVICE_ID", false);
}

// ---------------- 常量（与 Python 版一字不差） ----------------
const COMMON_CONSTANTS = {
  UA: "Dalvik/2.1.0 (Linux; U; Android 12; Mi 10 Pro MIUI/21.11.3);unicom{version:android@11.0802}",
  MARKET_UA: "Dalvik/2.1.0 (Linux; U; Android 12; Mi 10 Pro MIUI/21.11.3);unicom{version:android@11.0802}",
  MARKET_H5_UA: "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36; unicom{version:android@11.0802,desmobile:0};devicetype{deviceBrand:Xiaomi,deviceModel:MI 8}",
  APP_VERSION: "android@11.0802",
};
const MARKET_MEMBER_CENTER_PAGE_ID = "s782351687947921408";
const MARKET_MEMBER_CENTER_DISTRIBUTE_ID = "D1161369893988319232";
const MARKET_MEMBER_CENTER_PARTNERS_ID = "1703";
const MARKET_MEMBER_CENTER_CLIENT_TYPE = "marketUnicom";
const MARKET_MEMBER_CENTER_TASK_CODE = "s769153426294495232";
const XJ_ACTIVITY_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
let XJ_ACTIVITY_YEAR = String(new Date().getFullYear());
let XJ_ACTIVITY_MONTH = XJ_ACTIVITY_MONTHS[new Date().getMonth()];
let XJ_ACTIVITY_ID = "";
let XJ_MONTHLY_DRAW_ATTEMPT_COUNT = 1;
let XJ_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0701};ltst;OSVersion/16.2";
let UNICOM_CLOUD_UPLOAD_TIMEOUT = 120;
let UNICOM_CLOUD_UPLOAD_PROGRESS_BYTES = 6376590;
const WOCARE_CONSTANTS = {
  serviceLife: "wocareMBHServiceLife1",
  anotherApiKey: "beea1c7edf7c4989b2d3621c4255132f",
  anotherEncryptionKey: "f4cd4ffeb5554586acf65ba7110534f5",
  minRetries: "1",
};
const WOCARE_ACTIVITIES = [
  { name: "星座配对", id: 2 },
  { name: "大转盘", id: 3 },
  { name: "盲盒抽奖", id: 4 },
];
const AITING_BASE_URL = "https://pcc.woread.com.cn";
const AITING_SIGN_KEY_APPKEY = "7ZxQ9rT3wE5sB2dF";
const AITING_SIGN_KEY_API = "woread!@#qwe1234";
const AITING_SIGN_KEY_REQUERTID = "46iCw24ewAZbNkK6";
const AITING_CLIENT_KEY = "1";
const AITING_AES_KEY = "j2K81755sxV12wFx";
const AITING_AES_IV = "16-Bytes--String";
const WOREAD_KEY = "woreadst^&*12345";
const ADDREADTIME_AES_KEY = "UNS#READDAY39COM";
const YUNNAN_LIFE_BASE_URL = "https://wsm.wx.yn10010.com";
const YUNNAN_LIFE_ACT_ID = "47191519589909";
const YUNNAN_LIFE_SIGN_SALT = "ltynsh@sd23kjkgj2mbnfa0";
const YUNNAN_LIFE_ACCESS_KEY = "ltynsh";
const YUNNAN_LIFE_TO_URL = "https://wsm.wx.yn10010.com/micropage/orderPages/newYear/2025newYearsDay?channelId=1001010";
const YUNNAN_LIFE_TASKS = [
  { taskName: "每日签到", taskCode: "DAILY_SIGN" },
  { taskName: "浏览年终大回馈,好礼多多", taskCode: "BROWSE_5TOWNS" },
];
const TTXC_BASE_URL = "https://epay.10010.com/cu-ca-game-front";
const TTXC_APP_BASE_URL = "https://epay.10010.com/cu-ca-app-front";
const TTXC_CHANNEL = "225";
const TTXC_REFERER = "https://epay.10010.com/cu-ca-game-web/index.html?channel=qdqp";
let TTXC_GARBAGE_WAIT_SECONDS = 28;
let TTXC_GROW_MAX_CHARGE_PER_LAND = 20;
let GRAB_AMOUNT = "5";
let AH_FRIDAY_AMOUNT = "";
const AH_FRIDAY_BASE_URL = "http://123.138.11.116:8080";
let AH_FRIDAY_SECKILL_TIMES = 50;
let AH_FRIDAY_INTERVAL = 0.3;
let UNICOM_TEST_MODE = "";

function refreshEnvConsts() {
  XJ_ACTIVITY_YEAR = env("XJ_ACTIVITY_YEAR", String(new Date().getFullYear()));
  XJ_ACTIVITY_MONTH = env("XJ_ACTIVITY_MONTH", XJ_ACTIVITY_MONTHS[new Date().getMonth()]);
  XJ_ACTIVITY_ID = XJ_ACTIVITY_MONTH + XJ_ACTIVITY_YEAR + "Act";
  XJ_MONTHLY_DRAW_ATTEMPT_COUNT = Math.max(envInt("UNICOM_ATTEMPT_COUNT", 1), 1);
  XJ_USER_AGENT = env("XJ_USER_AGENT", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0701};ltst;OSVersion/16.2");
  UNICOM_CLOUD_UPLOAD_TIMEOUT = envInt("UNICOM_CLOUD_UPLOAD_TIMEOUT", 120);
  UNICOM_CLOUD_UPLOAD_PROGRESS_BYTES = envInt("UNICOM_CLOUD_UPLOAD_PROGRESS_BYTES", 6376590);
  TTXC_GARBAGE_WAIT_SECONDS = envInt("UNICOM_TTXC_GARBAGE_WAIT", 28);
  TTXC_GROW_MAX_CHARGE_PER_LAND = envInt("UNICOM_TTXC_GROW_MAX_CHARGE_PER_LAND", 20);
  GRAB_AMOUNT = env("UNICOM_GRAB_AMOUNT", "5");
  AH_FRIDAY_AMOUNT = env("UNICOM_AH_FRIDAY_AMOUNT", "");
  AH_FRIDAY_SECKILL_TIMES = envInt("UNICOM_AH_FRIDAY_TIMES", 50);
  AH_FRIDAY_INTERVAL = envFloat("UNICOM_AH_FRIDAY_INTERVAL", 0.3);
  UNICOM_TEST_MODE = env("UNICOM_TEST_MODE", "");
}

// ctx.storage 便捷读写（token 缓存用；对应 Python 的 unicom_token_cache.json 文件）
function storageGetJSON(key) {
  try {
    if (!ctxStorage) return null;
    const raw = ctxStorage.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function storageSetJSON(key, val) {
  try { if (ctxStorage) ctxStorage.set(key, JSON.stringify(val)); } catch (e) {}
}
const UNICOM_TOKEN_CACHE_KEY = "unicom_token_cache";

// ---------------- Egern HTTP 会话（cookie jar + 手动重定向，对应 Python requests.Session） ----------------
function splitSetCookies(values) {
  const out = [];
  (values || []).forEach((v) => {
    String(v).split(/\r?\n/).forEach((line) => {
      String(line).split(/,(?=\s*[^;,\s]+=)/).forEach((part) => {
        const kv = part.split(";", 1)[0].trim();
        if (/^[^=;\s]+=.+/.test(kv) && out.indexOf(kv) < 0) out.push(kv);
      });
    });
  });
  return out;
}
function encodeParams(obj) {
  return Object.keys(obj || {}).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k] == null ? "" : String(obj[k]))).join("&");
}
class EgernSession {
  constructor(http) {
    this.http = http;
    this.jar = {}; // name -> value
    this.baseHeaders = { "User-Agent": COMMON_CONSTANTS.UA, "Connection": "keep-alive" };
  }
  setCookie(k, v) { this.jar[k] = v; }
  updateCookies(obj) { Object.keys(obj || {}).forEach((k) => { this.jar[k] = obj[k]; }); }
  getCookieDict() { return Object.assign({}, this.jar); }
  buildCookieHeader(extra) {
    const pairs = [];
    Object.keys(this.jar).forEach((k) => pairs.push(k + "=" + this.jar[k]));
    if (extra) pairs.push(extra);
    return pairs.join("; ");
  }
  applySetCookies(values) {
    splitSetCookies(values).forEach((kv) => {
      const i = kv.indexOf("=");
      if (i > 0) this.jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  }
  // 底层请求：返回 {status, text, headers:{get,getAll}}；网络异常抛错
  async rawRequest(method, url, opts) {
    opts = opts || {};
    method = String(method || "GET").toUpperCase();
    let fullUrl = url;
    if (opts.params) {
      const qs = encodeParams(opts.params);
      if (qs) fullUrl += (fullUrl.indexOf("?") >= 0 ? "&" : "?") + qs;
    }
    const headers = Object.assign({}, this.baseHeaders, opts.headers || {});
    const jarHeader = this.buildCookieHeader();
    if (jarHeader) {
      headers["Cookie"] = headers["Cookie"] ? headers["Cookie"] + "; " + jarHeader : jarHeader;
    }
    let body;
    if (opts.multipart) {
      const mp = buildMultipart(opts.multipart.fields, opts.multipart.files);
      headers["Content-Type"] = mp.contentType;
      body = mp.body;
    } else if (opts.json !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      body = jsonDumpsAscii(opts.json); // 对应 Python json.dumps(ensure_ascii=True)
    } else if (opts.data !== undefined) {
      if (typeof opts.data === "string") { body = opts.data; }
      else {
        headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
        body = encodeParams(opts.data);
      }
    }
    const timeout = (opts.timeout || 15) * 1000;
    const followRedirects = opts.allowRedirects !== false;
    let curUrl = fullUrl, curMethod = method, curBody = body, curHeaders = headers;
    for (let i = 0; i < 6; i++) {
      const fn = this.http[curMethod.toLowerCase()];
      if (typeof fn !== "function") throw new Error("不支持的 HTTP 方法: " + curMethod);
      let resp;
      try {
        resp = await fn.call(this.http, curUrl, { headers: curHeaders, body: curBody, timeout, redirect: "manual", credentials: "omit" });
      } catch (e) { throw new Error("请求异常 " + curUrl + ": " + (e && e.message ? e.message : e)); }
      const status = Number(resp.status || 0);
      let sc = [];
      try { sc = resp.headers.getAll("set-cookie") || []; } catch (e) {}
      this.applySetCookies(sc);
      const text = await resp.text().catch(() => "");
      const location = resp.headers.get("location");
      const isRedirect = followRedirects && [301, 302, 303, 307, 308].indexOf(status) >= 0 && location;
      if (!isRedirect) {
        const rh = resp.headers;
        return { status, text, headers: { get: (n) => { try { return rh.get(n); } catch (e) { return null; } } } };
      }
      const next = new URL(location, curUrl).href;
      curUrl = next;
      if (status === 303 || ((status === 301 || status === 302) && curMethod === "POST")) {
        curMethod = "GET"; curBody = undefined;
        Object.keys(curHeaders).forEach((k) => { if (/^content-(type|length)$/i.test(k)) delete curHeaders[k]; });
      }
      curHeaders["Cookie"] = this.buildCookieHeader();
    }
    throw new Error("重定向次数过多: " + url);
  }
  // 对应 Python self.session.get/post：抛错
  async get(url, opts) { return this.rawRequest("GET", url, opts); }
  async post(url, opts) { return this.rawRequest("POST", url, opts); }
  async request(method, url, opts) { return this.rawRequest(method, url, opts); }
}

// 包一层：json()/text() 与 Python res.json()/res.text 对应
function wrapResponse(r) {
  return {
    status: r.status,
    headers: r.headers,
    text: async () => r.text,
    json: async () => JSON.parse(r.text),
  };
}

// ---------------- UserService（基础部分；各模块方法由后续 Part 通过原型扩展） ----------------
let blogLines = [];
function blog(msg) { // 模块级函数的日志（对应 Python print）
  const line = "[" + fmtTime() + "] " + msg;
  blogLines.push(line);
  if (typeof console !== "undefined" && console.log) console.log(line);
}

class UserService {
  constructor(ctx, index, configStr) {
    this.ctx = ctx;
    this.index = index;
    this.valid = false;
    this.notifyLogs = [];
    this.session = new EgernSession(ctx.http);
    this.account_mobile = "";
    this.mobile = "";
    this.account_password = "";
    this.token_online = "";
    this.token_refresh = "";
    this.cookie = "";
    this.appId = "";
    this.city_info = [];
    this.last_read_submission_time = 0;
    this.uuid = (globalConfig.refresh_device_id ? uuid32() : (env("chinaUnicomUuid") || uuid32()));
    this.unicomTokenId = this.random_string(32);
    this.tokenId_cookie = "chinaunicom-" + this.random_string(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    this.ecs_token = "";
    this.rptId = "";
    this.sec_ai_share_key = "";
    this.sec_share_task_code = "";
    this.sec_share_task_name = "联通助理-分享AI助手对话";
    this.sec_pending_claim_tasks = {};
    this.initAccount(configStr);
  }

  random_string(length, chars) {
    return randomString(length, chars || "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  }

  initAccount(configStr) {
    const parts = String(configStr).split("#");
    if (parts.length >= 2 && parts[0].length === 11 && /^\d+$/.test(parts[0]) && parts[1].length < 50) {
      this.account_mobile = parts[0];
      this.account_password = parts[1];
    } else {
      this.token_online = parts[0].trim();
      if (this.token_online.length === 11 && /^\d+$/.test(this.token_online)) {
        this.account_mobile = this.token_online;
        this.token_online = "";
        this.log("识别到纯手机号模式: " + mask_str(this.account_mobile));
      }
      if (parts.length > 1) this.appId = parts[1].trim();
      if (parts.length > 2 && parts[2]) {
        const pm = parts[2].trim();
        if (/^\d+$/.test(pm) && pm.length === 11) this.account_mobile = pm;
      }
    }
    this.unicomTokenId = uuid32();
    this.tokenId_cookie = "chinaunicom-" + uuid32().toUpperCase();
    this.cookie_string = "TOKENID_COOKIE=" + this.tokenId_cookie + "; UNICOM_TOKENID=" + this.unicomTokenId + "; sdkuuid=" + this.unicomTokenId;
    this.update_session_cookies();
  }

  update_session_cookies() {
    if (this.cookie_string) {
      const cookies = {};
      this.cookie_string.split(";").forEach((item) => {
        const i = item.indexOf("=");
        if (i > 0) cookies[item.slice(0, i).trim()] = item.slice(i + 1).trim();
      });
      this.session.updateCookies(cookies);
    }
    const extra = {};
    if (this.token_online) extra["token_online"] = this.token_online;
    if (this.appId) extra["appId"] = this.appId;
    this.session.updateCookies(extra);
  }

  log(msg, notify) {
    const line = "[" + fmtTime() + "] 账号[" + this.index + "]" + msg;
    blogLines.push(line);
    if (typeof console !== "undefined" && console.log) console.log(line);
    if (notify) this.notifyLogs.push(String(msg));
  }

  // 对应 Python self.request：网络异常返回 null（不抛错）
  async request(method, url, kwargs) {
    try {
      const r = await this.session.request(method, url, kwargs);
      if (r.status >= 400) this.log("请求 " + url + " 返回状态码 " + r.status);
      return wrapResponse(r);
    } catch (e) {
      this.log("请求 " + url + " 异常: " + (e && e.message ? e.message : e));
      return null;
    }
  }
  // 对应 Python self.session.get/post（直接）：网络异常抛错
  async httpGet(url, opts) { return wrapResponse(await this.session.get(url, opts)); }
  async httpPost(url, opts) { return wrapResponse(await this.session.post(url, opts)); }

  async request_direct(method, url, kwargs) {
    // Python 版用全新 session 直连；Egern 下等价于一次无 cookie 的裸请求
    const tmp = new EgernSession(this.ctx.http);
    tmp.jar = {};
    const r = await tmp.request(method, url, kwargs);
    return wrapResponse(r);
  }

  configure_proxy() {
    // Egern 自带网络分流与节点选择，脚本内不再配置代理（对应 Python 的 UNICOM_PROXY_API 逻辑）
    if (env("UNICOM_PROXY_API")) this.log("ℹ️ Egern 环境已忽略 UNICOM_PROXY_API（走 Egern 自身分流）");
  }
  failover_proxy() { return false; }

  rsa_encrypt(val) {
    this.log("正在进行 RSA 加密...");
    try { return rsaEncryptPkcs1v15(val); }
    catch (e) { this.log("RSA加密失败: " + (e && e.message ? e.message : e)); return ""; }
  }

  generate_appid() {
    const rnd = () => String(randInt(0, 9));
    return rnd() + "f" + rnd() + "af" + rnd() + rnd() + "ad" + rnd() +
      "912d306b5053abf90c7ebbb695887bc870ae0706d573c348539c26c5c0a878641fcc0d3e90acb9be1e6ef858a59af546f3c826988332376b7d18c8ea2398ee3a9c3db947e2471d32a49" +
      rnd() + rnd();
  }
}

// ---------------- multipart/form-data（对应 Python requests 的 files= 参数） ----------------
function bytesToBinaryString(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
  return s;
}
function buildMultipart(fields, files) {
  // fields: {name: value}；files: [{field, filename, contentType, data: byte数组}]
  // 返回 {body: 二进制字符串, contentType}
  const boundary = "----EgernBoundary" + randomString(24, "0123456789abcdef");
  let body = "";
  Object.keys(fields || {}).forEach((name) => {
    body += "--" + boundary + "\r\n";
    body += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
    body += String(fields[name]) + "\r\n";
  });
  (files || []).forEach((f) => {
    body += "--" + boundary + "\r\n";
    body += 'Content-Disposition: form-data; name="' + f.field + '"; filename="' + f.filename + '"\r\n';
    body += "Content-Type: " + (f.contentType || "application/octet-stream") + "\r\n\r\n";
    body += bytesToBinaryString(f.data);
    body += "\r\n";
  });
  body += "--" + boundary + "--\r\n";
  return { body: body, contentType: "multipart/form-data; boundary=" + boundary };
}
// 云盘上传用的 seed JPEG（Python 版 base64，一字不差；Egern 版不做 6MB 零填充，用实际大小）
const CLOUD_SEED_JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEBAPEA8PEA8QDw8PDw8QDw8QFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lICYtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAgMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6A//xAAXEAEAAwAAAAAAAAAAAAAAAAABAAIR/9oACAEBAAEFAkqf/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQAGPwJf/8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQABPyFf/9k=";
function cloudSeedJpegBytes() { return b64decode(CLOUD_SEED_JPEG_B64); }

// ---------------- urllib.parse.quote 等价实现 ----------------
function pyQuote(s, safe) {
  // 对应 Python urllib.parse.quote(s, safe=safe)，默认 safe='/'
  safe = safe === undefined ? "/" : safe;
  const always = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";
  return Array.from(String(s)).map((ch) => {
    if (always.indexOf(ch) >= 0 || safe.indexOf(ch) >= 0) return ch;
    return utf8Bytes(ch).map((b) => "%" + ("0" + b.toString(16)).slice(-2).toUpperCase()).join("");
  }).join("");
}
function jsonDumpsAscii(o) {
  // 对应 Python json.dumps(o, ensure_ascii=True)；separators=(',',':') 时 JS 的 JSON.stringify 默认即无空格
  return JSON.stringify(o).replace(/[^\x00-\x7f]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
}
function fmtYmdHms14(d) {
  // %Y%m%d%H%M%S（无毫秒），与骨架 fmtYmdHms（含3位毫秒）区分
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
// Part 01: 核心认证（unicom_login / onLine / token 缓存 / 资产查询 / gettaskip）
Object.assign(UserService.prototype, {
  async unicom_login() {
    this.log("正在使用账号 " + mask_str(this.account_mobile) + " 进行登录...");
    if (!this.appId) {
      this.appId = this.generate_appid();
      this.log("生成临时 AppId: " + this.appId.slice(0, 15) + "...");
    }
    const timestamp = fmtDateTime(new Date());
    try {
      const payload = {
        version: COMMON_CONSTANTS.APP_VERSION,
        mobile: this.rsa_encrypt(this.account_mobile),
        reqtime: timestamp,
        deviceModel: "Android",
        netWay: "Wifi",
        isR4: "0",
        password: this.rsa_encrypt(this.account_password),
        appId: this.appId,
      };
      const url = "https://m.client.10010.com/mobileService/login.htm";
      const res = await this.httpPost(url, { data: payload });
      const result = await res.json();
      if (result.code === "0" || result.code === "0000") {
        if (result.token_online) {
          this.token_online = result.token_online;
          this.log("✅ 登录接口验证通过");
          return true;
        } else {
          this.log("❌ 登录响应中未找到 token_online");
        }
      } else {
        this.log("❌ 登录失败: " + result.desc + " (Code: " + result.code + ")");
      }
    } catch (e) {
      this.log("❌ 登录过程异常: " + (e && e.message ? e.message : e));
    }
    return false;
  },

  async load_token_from_cache() {
    if (!this.account_mobile) return false;
    try {
      const cache = storageGetJSON(UNICOM_TOKEN_CACHE_KEY) || {};
      const user_cache = cache[this.account_mobile];
      if (user_cache && user_cache.token_online) {
        if (Date.now() - (user_cache.timestamp || 0) < 12 * 60 * 60 * 1000) {
          this.token_online = user_cache.token_online;
          this.appId = user_cache.appId || this.appId;
          this.city_info = user_cache.city_info || [];
          this.update_session_cookies();
          this.log("♻️ [缓存复用] 成功加载本地 Token (" + user_cache.time + ")");
          return true;
        }
      }
    } catch (e) { /* pass */ }
    return false;
  },

  async save_token_to_cache() {
    if (!this.account_mobile) return;
    let cache = {};
    try { cache = storageGetJSON(UNICOM_TOKEN_CACHE_KEY) || {}; } catch (e) { /* pass */ }
    const now = new Date();
    cache[this.account_mobile] = {
      token_online: this.token_online,
      appId: this.appId,
      city_info: this.city_info || [],
      cookieString: "",
      timestamp: now.getTime(),
      time: fmtDateTime(now),
    };
    try {
      storageSetJSON(UNICOM_TOKEN_CACHE_KEY, cache);
      this.log("💾 [缓存保存] Token 已写入本地存储");
    } catch (e) {
      this.log("❌ 保存缓存失败: " + (e && e.message ? e.message : e));
    }
  },

  async get_city_info() {
    try {
      const url = "https://m.client.10010.com/mobileService/business/get/getCity";
      const res = await (await this.httpPost(url, { data: {}, timeout: 10 })).json();
      if (res.code === "200" && res.list) {
        this.city_info = res.list;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  async queryRemain() {
    try {
      if (!this.ecs_token) {
        if (!(await this.onLine())) {
          this.log("❌ 无法获取 ecs_token，跳过查询");
          return;
        }
      }
      this.log("==== 资产查询 ====");
      this.log("正在查询套餐余量...");
      const url = "https://m.client.10010.com/servicequerybusiness/balancenew/accountBalancenew.htm";
      const headers = {
        "User-Agent": COMMON_CONSTANTS.MARKET_UA,
        "Cookie": "ecs_token=" + this.ecs_token,
      };
      const res = await this.request("get", url, { headers });
      if (!res) return;
      const result = await res.json();
      if (result.code === "0000") {
        let current_balance = "0.00";
        let real_time_fee = "0.00";
        if (result.curntbalancecust) current_balance = String(result.curntbalancecust);
        if (result.realfeecust) real_time_fee = String(result.realfeecust);
        this.log("💰 [资产-话费] 当前余额: " + current_balance + "元, 实时话费: " + real_time_fee + "元", true);
        const pkg_list = result.realTimeFeeSpecialFlagThree || [];
        if (pkg_list && Array.isArray(pkg_list)) {
          this.log("    📋 [套餐详情]:", true);
          for (const item of pkg_list) {
            const sub_items = item.subItems || [];
            if (sub_items) {
              for (const sub of sub_items) {
                const bill = sub.bill || {};
                if (bill) {
                  const name = bill.integrateitem || "未知项";
                  const fee = bill.realfee || "0.00";
                  this.log("       - " + name + ": " + fee + "元", true);
                }
              }
            }
          }
        }
      } else {
        const msg = result.desc || result.msg || "未知错误";
        this.log("套餐余量查询失败: " + msg);
      }
    } catch (e) {
      this.log("queryRemain 异常: " + (e && e.message ? e.message : e));
    }
  },

  async onLine() {
    if (!this.token_online) {
      this.log("❌ 缺少 token_online，无法执行 onLine");
      return false;
    }
    try {
      const url = "https://m.client.10010.com/mobileService/onLine.htm";
      const data = {
        isFirstInstall: "1",
        netWay: "Wifi",
        version: "android@11.0000",
        token_online: this.token_online,
        provinceChanel: "general",
        deviceModel: "ALN-AL10",
        step: "dingshi",
        androidId: "291a7deb1d716b5a",
        reqtime: Date.now(),
      };
      if (this.appId) data.appId = this.appId;
      const res = await this.request("post", url, { data });
      if (!res) return false;
      const result = await res.json();
      const code = result.code;
      if (code === "0" || code === 0) {
        this.valid = true;
        const desmobile = result.desmobile || "";
        if (desmobile.length === 11 && /^\d+$/.test(desmobile)) {
          this.account_mobile = desmobile;
          this.mobile = desmobile;
        } else if (desmobile.indexOf("enc_") === 0) {
          if (!this.account_mobile) this.log("⚠️ 注意: 服务端返回了加密手机号且未配置本地手机号");
        }
        this.log("登录成功");
        this.city_info = result.list || [];
        this.ecs_token = result.ecs_token;
        return true;
      } else {
        this.log("登录失败[" + code + "]: " + result.msg);
        return false;
      }
    } catch (e) {
      this.log("onLine 异常: " + (e && e.message ? e.message : e));
      return false;
    }
  },

  async gettaskip() {
    const orderId = this.random_string(32).toUpperCase();
    try {
      const url = "https://m.client.10010.com/taskcallback/topstories/gettaskip";
      const data = { mobile: this.account_mobile, orderId: orderId };
      await this.request("post", url, { data });
    } catch (e) { /* pass */ }
    return orderId;
  },
});
// Part 02: 首页签到（对应 Python 19705.py L707-1003 签到区方法 + L6745-6793）
// sign_getContinuous / sign_daySign / sign_getTelephone / sign_getTaskList /
// sign_doTaskFromList / sign_getTaskReward / sign_grabCoupon / sign_grab_execute /
// sign_query_my_prizes / sign_task_main
Object.assign(UserService.prototype, {

  // PY-707
  async sign_getContinuous(is_query_only = false) {
    try {
      const url = "https://activity.10010.com/sixPalaceGridTurntableLottery/signin/getContinuous";
      const params = { "taskId": "", "channel": "wode", "imei": this.uuid };
      const res = await this.request("get", url, { params: params });
      if (!res) return;
      const result = await res.json();
      const code = result?.code;
      if (code === "0000") {
        const todayIsSignIn = ((result?.data ?? {}).todayIsSignIn) ?? 'n';
        this.log(`签到区今天${todayIsSignIn === 'y' ? '已' : '未'}签到`, true);
        if (todayIsSignIn === 'y') {
          // pass
        } else {
          if (!is_query_only) {
            await sleep(1000);
            await this.sign_daySign();
          } else {
            this.log("签到区: [查询模式] 跳过自动打卡");
          }
        }
      } else {
        this.log(`签到区查询签到状态失败[${code}]: ${(result?.desc) ?? ''}`);
      }
    } catch (e) {
      this.log(`sign_getContinuous 异常: ${String(e)}`);
    }
  },

  // PY-735
  async sign_daySign() {
    try {
      const url = "https://activity.10010.com/sixPalaceGridTurntableLottery/signin/daySign";
      const res = await this.request("post", url, { data: {} });
      if (!res) return;
      const result = await res.json();
      const code = result?.code;
      if (code === "0000") {
        const data = (result?.data) ?? {};
        const msg = `签到区签到成功: [${data.statusDesc ?? ''}]${data.redSignMessage ?? ''}`;
        this.log(msg);
      } else if (code === "0002" && (result?.desc ?? '').includes("已经签到")) {
        this.log("签到区签到成功: 今日已完成签到！");
      } else {
        this.log(`签到区签到失败[${code}]: ${(result?.desc) ?? ''}`);
      }
    } catch (e) {
      this.log(`sign_daySign 异常: ${String(e)}`);
    }
  },

  // PY-753
  async sign_getTelephone(is_initial = false, silent = false) {
    try {
      const url = "https://act.10010.com/SigninApp/convert/getTelephone";
      const res = await this.request("post", url, { data: {} });
      if (!res) return null;
      const result = await res.json();
      const status = result?.status;
      if (status === "0000" && result?.data) {
        const tel_val = (result.data).telephone ?? 0;
        let current_amount;
        try {
          current_amount = parseFloat(tel_val);
        } catch (e) {
          current_amount = 0.0;
        }
        if (isNaN(current_amount)) current_amount = 0.0;
        if (silent) return current_amount;
        let msg;
        if (is_initial) {
          msg = `签到区-话费红包: 运行前总额 ${current_amount.toFixed(2)}元`;
          this.sign_initial_amount = current_amount;
        } else {
          if ("sign_initial_amount" in this) {
            const increase = current_amount - this.sign_initial_amount;
            this.log(`签到区-话费红包: 本次运行增加 ${increase.toFixed(2)}元`, true);
          }
          msg = `签到区-话费红包: 总额 ${current_amount.toFixed(2)}元`;
          const exp_val = (result.data).needexpNumber ?? 0;
          let exp_num;
          try {
            exp_num = parseFloat(exp_val);
          } catch (e) {
            exp_num = 0.0;
          }
          if (isNaN(exp_num)) exp_num = 0.0;
          if (exp_num > 0) {
            msg += `，其中 ${(result.data).needexpNumber ?? '0'}元 将于 ${(result.data).month ?? ''}月底到期`;
          }
        }
        this.log(msg, !is_initial);
        return current_amount;
      } else {
        if (!silent) {
          this.log(`签到区查询话费红包失败[${status}]: ${(result?.msg) ?? ''}`);
        }
        return null;
      }
    } catch (e) {
      if (!silent) {
        this.log(`sign_getTelephone 异常: ${String(e)}`);
      }
      return null;
    }
  },

  // PY-794
  async sign_getTaskList() {
    try {
      const url = "https://activity.10010.com/sixPalaceGridTurntableLottery/task/taskList";
      const headers = { "Referer": "https://img.client.10010.com/" };
      for (let i = 0; i < 30; i++) {
        const res = await this.request("get", url, { params: { "type": "2" }, headers: headers, timeout: 10 });
        if (!res) return;
        const result = await res.json();
        const code = result?.code;
        if (code === "0329" || (result?.desc ?? '').includes("火爆")) {
          this.log("签到区: 系统繁忙(0329)，停止后续尝试");
          break;
        }
        if (code !== "0000") {
          this.log(`签到区-任务中心: 获取任务列表失败[${code}]: ${(result?.desc) ?? ''}`);
          return;
        }
        const tag_list = (((result?.data ?? {}).tagList) ?? []) || [];
        const task_list = (((result?.data ?? {}).taskList) ?? []) || [];
        let all_tasks = task_list.concat(tag_list.flatMap((tag) => (tag.taskDTOList || [])));
        all_tasks = all_tasks.filter((t) => t);
        if (!all_tasks.length) {
          if (i === 0) this.log("签到区-任务中心: 当前无任何任务。");
          break;
        }
        const do_task = all_tasks.find((t) => t.taskState === '1' && t.taskType === '5') || null;
        if (do_task) {
          this.log(`签到区-任务中心: 开始执行任务 [${do_task.taskName}]`);
          await this.sign_doTaskFromList(do_task);
          await sleep(3000);
          continue;
        }
        const claim_task = all_tasks.find((t) => t.taskState === '0') || null;
        if (claim_task) {
          this.log(`签到区-任务中心: 发现可领取奖励的任务 [${claim_task.taskName}]`);
          await this.sign_getTaskReward(claim_task.id);
          await sleep(2000);
          continue;
        }
        if (i === 0) {
          this.log("签到区-任务中心: 没有可执行或可领取的任务。");
        } else {
          this.log("签到区-任务中心: 所有任务处理完毕。");
        }
        break;
      }
    } catch (e) {
      this.log(`sign_getTaskList 异常: ${String(e)}`);
    }
  },

  // PY-836
  async sign_doTaskFromList(task) {
    try {
      if (task.url && task.url !== '1' && task.url.startsWith('http')) {
        await this.request("get", task.url, { headers: { "Referer": "https://img.client.10010.com/" } });
        this.log(`签到区-任务中心: 浏览页面 [${task.taskName}]`);
        await sleep(randFloat(5, 7) * 1000);
      }
      const orderId = await this.gettaskip();
      const url = "https://activity.10010.com/sixPalaceGridTurntableLottery/task/completeTask";
      const params = { "taskId": task.id, "orderId": orderId, "systemCode": "QDQD" };
      const res = await this.request("get", url, { params: params });
      if (!res) return;
      const result = await res.json();
      const code = result?.code;
      if (code === "0000") {
        this.log(`签到区-任务中心: ✅ 任务 [${task.taskName}] 已完成`);
      } else {
        this.log(`签到区-任务中心: ❌ 任务 [${task.taskName}] 完成失败[${code}]: ${(result?.desc) ?? '未知错误'}`);
      }
    } catch (e) {
      this.log(`sign_doTaskFromList 异常: ${String(e)}`);
    }
  },

  // PY-860
  async sign_getTaskReward(task_id) {
    try {
      const url = "https://activity.10010.com/sixPalaceGridTurntableLottery/task/getTaskReward";
      const res = await this.request("get", url, { params: { "taskId": task_id } });
      if (!res) return;
      const result = await res.json();
      const code = result?.code;
      if (code === "0000") {
        const data = (result?.data) ?? {};
        if (data.code === '0000') {
          this.log(`签到区-领取奖励: [${data.prizeName ?? ''}] ${data.prizeNameRed ?? ''}`);
        } else {
          this.log(`签到区-领取奖励失败[${data.code}]: ${result?.desc || data.desc}`);
        }
      } else {
        this.log(`签到区-领取奖励失败[${code}]: ${(result?.desc) ?? ''}`);
      }
    } catch (e) {
      this.log(`sign_getTaskReward 异常: ${String(e)}`);
    }
  },

  // PY-878
  async sign_grabCoupon() {
    const sc = globalConfig.sign_config || {};
    if (!sc.run_grab_coupon) return;
    this.log(`⚔️ [抢兑阶段] 正在检查目标: ${GRAB_AMOUNT}元 话费券...`);
    const candidates = [];
    try {
      const url = "https://act.10010.com/SigninApp/new_convert/prizeList";
      const headers = { "Origin": "https://img.client.10010.com" };
      const res = await this.request("post", url, { headers: headers });
      if (res) {
        const list_res = await res.json();
        if ((list_res?.status) === "0000") {
          const details = ((list_res?.data ?? {}).datails) ?? {}; // 原字段名 datails（一字不差）
          const tab_items = details.tabItems ?? [];
          this.log(`📋 [调试] 共获取到 ${tab_items.length} 个场次数据`);
          for (const tab of tab_items) {
            const products = tab.timeLimitQuanListData ?? [];
            const round_time_str = tab.time ?? '';
            let round_date = null;
            try {
              if (round_time_str && round_time_str.includes(":")) {
                const now = new Date();
                const date_str = fmtDateSlash(now); // Python: now.strftime('%Y/%m/%d')
                const full_time_str = `${date_str} ${round_time_str}`;
                if (round_time_str.length <= 8) {
                  // Python: datetime.strptime(full_time_str, "%Y/%m/%d %H:%M")
                  const m = full_time_str.match(/^(\d+)\/(\d+)\/(\d+) (\d+):(\d+)$/);
                  if (m) round_date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
                } else {
                  // Python: datetime.strptime(round_time_str, "%Y-%m-%d %H:%M:%S")
                  const m = round_time_str.match(/^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/);
                  if (m) round_date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
                }
              }
            } catch (e) { /* pass */ }
            for (const item of products) {
              const p_name = item.product_name ?? '';
              if (p_name.includes(String(GRAB_AMOUNT)) && (p_name.includes("元") || p_name.includes("话费"))) {
                this.log(`      ✅ 发现目标: ${p_name} (ID: ${item.product_id})`);
                candidates.push({
                  "id": item.product_id,
                  "name": p_name,
                  "typeCode": item.type_code || '0',
                  "timeStr": round_time_str,
                  "startTime": round_date,
                  "itemData": item
                });
              }
            }
          }
        }
      }
    } catch (e) {
      this.log(`❌ 获取奖品列表失败: ${String(e)}`);
    }
    if (!candidates.length) {
      this.log(`⚠️ 未在任何场次中匹配到名为 '${GRAB_AMOUNT}元' 的奖品。`);
      return;
    }
    const now = new Date();
    let best_candidate = null;
    let min_diff = Infinity; // Python: float('inf')
    for (const cand of candidates) {
      const start_time = cand['startTime'];
      if (!start_time) continue;
      const diff = (start_time.getTime() - now.getTime()) / 1000; // Python: total_seconds()
      let score = 0;
      if (diff > 0) {
        score = diff;
      } else if (diff > -600) {
        score = Math.abs(diff) + 10000;
      } else {
        score = Math.abs(diff) + 90000;
      }
      if (score < min_diff) {
        min_diff = score;
        best_candidate = cand;
      }
    }
    if (!best_candidate) best_candidate = candidates[0];
    this.log(`🎯 最终锁定场次: [${best_candidate['timeStr']}] ${best_candidate['name']}`);
    if (best_candidate['startTime']) {
      const start_time = best_candidate['startTime'];
      const wait_seconds = (start_time.getTime() - new Date().getTime()) / 1000;
      if (wait_seconds > 0) {
        if (wait_seconds > 300) {
          this.log(`⏳ 距离开抢还有 ${wait_seconds.toFixed(1)} 秒，大于5分钟，暂不等待。建议在临近时间(如提前2分钟)再运行脚本。`);
          return;
        }
        this.log(`⏳ 正在等待开抢... (剩余 ${wait_seconds.toFixed(1)} 秒)`);
        while ((best_candidate['startTime'].getTime() - new Date().getTime()) / 1000 > 0.5) {
          await sleep(500);
        }
      } else {
        this.log(`⚡ 当前时间已超过场次时间 ${Math.abs(wait_seconds).toFixed(1)}s，直接抢兑！`);
      }
    }
    await this.sign_grab_execute(best_candidate);
  },

  // PY-960
  async sign_grab_execute(candidate) {
    for (let i = 1; i < 6; i++) {
      this.log(`🔥 [第${i}次冲击] 发起兑换请求...`);
      try {
        const data = { "product_id": candidate['id'], "typeCode": candidate['typeCode'] };
        const url = "https://act.10010.com/SigninApp/convert/prizeConvert";
        const headers = {
          "Origin": "https://img.client.10010.com",
          "Referer": "https://img.client.10010.com/",
          "X-Requested-With": "com.sinovatech.unicom.ui"
        };
        const res = await this.request("post", url, { data: data, headers: headers });
        if (!res) continue;
        const result = await res.json();
        const uuid_val = ((result?.data ?? {}).uuid);
        const status = result?.status;
        if (status === "0000" && uuid_val) {
          this.log(`📝 [提交成功] 获取到工单号: ${uuid_val}，正在查询最终结果...`);
          const check_url = "https://act.10010.com/SigninApp/convert/prizeConvertResult";
          const check_data = { "uuid": uuid_val };
          const check_res = await this.request("post", check_url, { data: check_data, headers: headers });
          if (!check_res) continue;
          const final_res = await check_res.json();
          const final_status = final_res?.status;
          if (final_status === "0000") {
            this.log(`🎉🎉🎉 [抢兑成功] 恭喜！已成功抢到目标奖品！ 🎉🎉🎉`, true);
            return;
          } else {
            const err_code = ((final_res?.data ?? {}).errorCode) ?? '';
            const msg = final_res?.msg || final_res?.message || '未知原因';
            const detail_msg = ((((final_res?.data ?? {}).rightBtn) ?? {}).name) ?? '';
            let log_msg = `💔 [抢兑失败] 状态: ${final_status}`;
            if (err_code) log_msg += ` | 错误码: ${err_code}`;
            if (detail_msg) log_msg += ` | 详情: ${detail_msg}`;
            log_msg += ` | 提示: ${msg}`;
            this.log(log_msg, true);
          }
        } else {
          this.log(`📝 提交结果: ${result?.msg || result?.message || JSON.stringify(result)}`);
        }
        await sleep(200);
      } catch (e) {
        this.log(`❌ 抢兑异常: ${String(e)}`);
      }
    }
  },

  // PY-6745
  async sign_query_my_prizes() {
    this.log("正在查询账户明细 (抢兑)...");
    try {
      const url = "https://act.10010.com/SigninApp/convert/phoneDetails";
      const form = { "log_type": "1", "number": "1", "list_num": "" };
      const headers = { "Origin": "https://img.client.10010.com" };
      const res = await this.request("post", url, { data: form, headers: headers });
      if (!res) return;
      const result = await res.json();
      if ((result?.status) === '0000') {
        const data = (((result?.data ?? {}).detailedBO) ?? []);
        if (data && Array.isArray(data)) {
          let logged_count = 0;
          for (const item of data) {
            if (logged_count >= 5) break;
            const remark = item.remark ?? '';
            const buss_name = item.from_bussname ?? '';
            if (remark.includes("兑换") || buss_name.includes("兑换")) {
              if (logged_count === 0) {
                this.log(`📋 [账户明细] 最近 5 条记录:`, true);
              }
              const order_time = item.order_time ?? '';
              const amount = item.booksNumber || item.books_number || "0";
              this.log(`   🎁 [抢兑] ${order_time} | ${remark} (变动:${amount})`, true);
              logged_count += 1;
            }
          }
          if (logged_count === 0) {
            this.log("[账户明细] 暂无兑换记录");
          }
        } else {
          this.log("[账户明细] 暂无兑换记录");
        }
      } else {
        this.log(`[账户明细] 查询异常: ${(result?.msg) ?? 'Result Error'}`);
      }
    } catch (e) {
      this.log(`sign_query_my_prizes error: ${e}`);
    }
  },

  // PY-6782
  async sign_task_main() {
    this.log("==== 签到区 ====");
    await this.sign_getTelephone(true);
    await this.sign_getContinuous(false);
    await this.sign_getTaskList();
    const sc = globalConfig.sign_config || {};
    if (sc.run_grab_coupon) {
      await this.sign_grabCoupon();
    } else {
      this.log("签到区-抢话费券: ⏭️ 已被子开关关闭，跳过");
    }
    await this.sign_getTelephone();
    await this.sign_query_my_prizes();
  },

});
// Part 03: 联通祝福（对应 Python 19705.py L1005-1298）
// get_wocare_body / wocare_api / wocare_getToken / wocare_loginmbh /
// wocare_getDrawTask / wocare_completeTask / wocare_getSpecificityBanner /
// wocare_loadInit / wocare_luckDraw / parse_jwt_payload
Object.assign(UserService.prototype, {

  // PY-1005
  async get_wocare_body(apiCode, requestData) {
    requestData = requestData || {};
    const timestamp = fmtYmdHms();
    const encodedContent = b64encode(utf8Bytes(JSON.stringify(requestData)));
    const body = {
      version: WOCARE_CONSTANTS.minRetries,
      apiCode: apiCode,
      channelId: WOCARE_CONSTANTS.anotherApiKey,
      transactionId: timestamp + this.random_string(6, "0123456789"),
      timeStamp: timestamp,
      messageContent: encodedContent,
    };
    const params_array = [];
    Object.keys(body).sort().forEach((key) => {
      params_array.push(key + "=" + body[key]);
    });
    params_array.push("sign=" + WOCARE_CONSTANTS.anotherEncryptionKey);
    const sign_str = params_array.join("&");
    body.sign = md5(sign_str);
    return body;
  },

  // PY-1024
  async wocare_api(apiCode, requestData) {
    try {
      const url = "https://wocare.unisk.cn/api/v1/" + apiCode;
      const body = await this.get_wocare_body(apiCode, requestData);
      const res = await this.request("post", url, {data: body});
      if (!res) return null;
      const result = await res.json();
      if (result.messageContent) {
        try {
          let content = result.messageContent;
          content = content.replace(/\n/g, "").replace(/\r/g, "").replace(/ /g, "");
          content = content.replace(/-/g, "+").replace(/_/g, "/");
          const missing_padding = content.length % 4;
          if (missing_padding) {
            content += "=".repeat(4 - missing_padding);
          }
          let decoded_str;
          try {
            const decoded_bytes = b64decode(content);
            decoded_str = utf8Decode(decoded_bytes);
          } catch (e) {
            decoded_str = "{}";
          }
          let decoded;
          try {
            decoded = JSON.parse(decoded_str);
          } catch (e) {
            decoded_str = decoded_str.replace(/[\x00-\x1f\x7f]/g, "");
            try {
              decoded = JSON.parse(decoded_str);
            } catch (e2) {
              decoded = {};
            }
          }
          if (isObj(decoded)) {
            if ("data" in decoded) {
              result.data = decoded.data;
            } else {
              result.data = decoded;
            }
            if ("resultMsg" in decoded) result.resultMsg = decoded.resultMsg;
            if ("resultCode" in decoded) result.resultCode = decoded.resultCode;
          }
        } catch (e) {
          this.log("联通祝福: 解析返回失败: " + (e && e.message ? e.message : e));
        }
      }
      return result;
    } catch (e) {
      this.log("wocare_api 异常: " + (e && e.message ? e.message : e));
      return null;
    }
  },

  // PY-1070
  async wocare_getToken(ticket) {
    try {
      const url = "https://wocare.unisk.cn/mbh/getToken";
      const params = {
        channelType: WOCARE_CONSTANTS.serviceLife,
        type: "02",
        ticket: ticket,
        version: COMMON_CONSTANTS.APP_VERSION,
        timestamp: fmtYmdHms(),
        desmobile: this.account_mobile,
        num: "0",
        postage: this.random_string(32),
        homePage: "home",
        duanlianjieabc: "qAz2m",
        userNumber: this.account_mobile,
      };
      const res = await this.httpGet(url, {params: params, allowRedirects: false, timeout: 15});
      if (res.status === 302) {
        const location = res.headers.get("location") || res.headers.get("Location") || "";
        if (location) {
          let sid = null;
          try {
            const sp = new URL(location, "https://wocare.unisk.cn").searchParams;
            sid = sp.get("sid");
            if (!sid) {
              sid = sp.get("uuid");
              if (sid) {
                this.log("联通祝福: 未找到sid，使用uuid替代: " + sid);
              }
            }
          } catch (e) { /* URL 解析失败则 sid 保持 null，走下方失败分支 */ }
          if (sid) {
            this.wocare_sid = sid;
            return await this.wocare_loginmbh();
          } else {
            this.log("联通祝福: 没有获取到sid或uuid, Location: " + location);
          }
        } else {
          this.log("联通祝福: 没有获取到location");
        }
      } else {
        this.log("联通祝福: 获取sid失败[" + res.status + "]");
      }
    } catch (e) {
      this.log("wocare_getToken 异常: " + (e && e.message ? e.message : e));
    }
    return false;
  },

  // PY-1109
  async wocare_loginmbh() {
    try {
      const apiCode = "loginmbh";
      const requestData = {
        sid: this.wocare_sid,
        channelType: WOCARE_CONSTANTS.serviceLife,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      if (!result) return false;
      const responseResult = result;
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        this.wocare_token = responseResult.data.token;
        this.log("联通祝福: 登录成功");
        return true;
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        this.log("联通祝福: 登录失败[" + resultCode + "]: " + msg);
      }
    } catch (e) {
      this.log("wocare_loginmbh 异常: " + (e && e.message ? e.message : e));
    }
    return false;
  },

  // PY-1132
  async wocare_getDrawTask(activity) {
    try {
      const apiCode = "getDrawTask";
      const requestData = {
        token: this.wocare_token,
        channelType: WOCARE_CONSTANTS.serviceLife,
        type: activity.id,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      const responseResult = result || {};
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        const taskList = (responseResult.data ?? {}).taskList ?? [];
        if (taskList.length) {
          this.log("联通祝福: [" + activity.name + "] 查询到 " + taskList.length + " 个任务");
          for (const task of taskList) {
            const ts = task.taskStatus;
            if (String(ts) === "0" || !ts) {
              await this.wocare_completeTask(activity, task);
            }
          }
        }
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        this.log("联通祝福: [" + activity.name + "]查询任务失败[" + resultCode + "]: " + msg);
      }
    } catch (e) {
      this.log("wocare_getDrawTask 异常: " + (e && e.message ? e.message : e));
    }
  },

  // PY-1160
  async wocare_completeTask(activity, task, taskStep = "1") {
    try {
      const taskTitle = task.title ?? "";
      const action = taskStep === "1" ? "领取任务" : "完成任务";
      const apiCode = "completeTask";
      const requestData = {
        token: this.wocare_token,
        channelType: WOCARE_CONSTANTS.serviceLife,
        task: task.id ?? null,
        taskStep: taskStep,
        type: activity.id,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      const responseResult = result || {};
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        this.log("联通祝福: " + action + "[" + taskTitle + "]成功");
        if (taskStep === "1") {
          await sleep(1000);
          await this.wocare_completeTask(activity, task, "4");
        }
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        this.log("联通祝福: [" + activity.name + "]" + action + "[" + taskTitle + "]失败[" + resultCode + "]: " + msg);
      }
    } catch (e) {
      this.log("wocare_completeTask 异常: " + (e && e.message ? e.message : e));
    }
  },

  // PY-1187
  async wocare_getSpecificityBanner() {
    try {
      const apiCode = "getSpecificityBanner";
      const requestData = {
        token: this.wocare_token,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      const responseResult = result || {};
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        const bannerList = responseResult.data || [];
        if (!bannerList.length) {
          this.log("联通祝福: 获取动态 Banner 列表为空，接口明细: " + JSON.stringify(responseResult));
        }
        for (const banner of bannerList) {
          if (String(banner.activityStatus) === "0" && String(banner.isDeleted) === "0") {
            await this.wocare_getDrawTask(banner);
            await this.wocare_loadInit(banner);
          }
        }
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        this.log("联通祝福: 进入活动失败[" + resultCode + "]: " + msg);
      }
    } catch (e) {
      this.log("wocare_getSpecificityBanner 异常: " + (e && e.message ? e.message : e));
    }
  },

  // PY-1211
  async wocare_loadInit(activity) {
    try {
      const apiCode = "loadInit";
      const requestData = {
        token: this.wocare_token,
        channelType: WOCARE_CONSTANTS.serviceLife,
        type: activity.id,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      const responseResult = result || {};
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        const responseData = responseResult.data || {};
        const activeModuleGroupId = responseData.zActiveModuleGroupId ?? null;
        let drawCount = 0;
        const aid = activity.id;
        if (aid === 2) {
          const isPartake = (responseData.data || {}).isPartake || 0;
          if (!isPartake) {
            drawCount = 1;
          }
        } else if (aid === 3) {
          drawCount = safeInt(responseData.raffleCountValue, 0);
        } else if (aid === 4) {
          drawCount = safeInt(responseData.mhRaffleCountValue, 0);
        }
        if (drawCount > 0) {
          this.log("联通祝福: [" + activity.name + "] 可抽奖次数 " + drawCount);
        } else {
          this.log("联通祝福: [" + activity.name + "] 今日已无抽奖机会");
        }
        while (drawCount > 0) {
          await sleep(2000);
          await this.wocare_luckDraw(activity, activeModuleGroupId);
          drawCount -= 1;
        }
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        this.log("联通祝福: [" + activity.name + "]查询活动失败[" + resultCode + "]: " + msg);
      }
    } catch (e) {
      this.log("wocare_loadInit 异常: " + (e && e.message ? e.message : e));
    }
  },

  // PY-1250
  async wocare_luckDraw(activity, activeModuleGroupId) {
    try {
      const apiCode = "luckDraw";
      const requestData = {
        token: this.wocare_token,
        channelType: WOCARE_CONSTANTS.serviceLife,
        zActiveModuleGroupId: activeModuleGroupId,
        type: activity.id,
        apiCode: apiCode,
      };
      const result = await this.wocare_api(apiCode, requestData);
      const responseResult = result || {};
      const resultCode = responseResult.resultCode ?? "-1";
      if (resultCode === "0000") {
        const resultData = responseResult.data || {};
        const drawResultCode = resultData.resultCode ?? "-1";
        if (drawResultCode === "0000") {
          const prize = resultData.data?.prize ?? {};
          const prizeName = prize.prizeName ?? "";
          const prizeDesc = prize.prizeDesc ?? "";
          this.log("联通祝福: [" + activity.name + "]抽奖: " + prizeName + "[" + prizeDesc + "]", true);
        } else {
          const msg = responseResult.resultMsg || responseResult.resultDesc || "";
          if (msg.toLowerCase() === "success") {
            this.log("联通祝福: [" + activity.name + "] 未中奖 (继续努力)");
          } else {
            this.log("联通祝福: [" + activity.name + "] 抽奖并未中奖: " + msg);
          }
        }
      } else {
        const msg = responseResult.resultMsg || responseResult.resultDesc || "";
        if (msg.toLowerCase() === "success") {
          this.log("联通祝福: [" + activity.name + "] 未中奖 (继续努力)");
        } else {
          this.log("联通祝福: [" + activity.name + "] 抽奖异常[" + resultCode + "]: " + msg);
        }
      }
    } catch (e) {
      this.log("wocare_luckDraw 异常: " + (e && e.message ? e.message : e));
    }
  },

  // PY-1286
  async parse_jwt_payload(token) {
    try {
      let payload = String(token).split(".")[1];
      const padding = payload.length % 4;
      if (padding) {
        payload += "=".repeat(4 - padding);
      }
      payload = payload.replace(/-/g, "+").replace(/_/g, "/");
      const decoded_bytes = b64decode(payload);
      return JSON.parse(utf8Decode(decoded_bytes));
    } catch (e) {
      this.log("JWT Decode Error: " + (e && e.message ? e.message : e));
      return {};
    }
  },
});
// Part 03b: 补 P3 遗漏的 3 个 market 签名 helper（Python 1299/1325/1340）
Object.assign(UserService.prototype, {
  async generate_market_signature_headers(user_token, query_string, json_body) {
    query_string = query_string || "";
    json_body = json_body || "";
    try {
      const token = user_token || "";
      const payload = await this.parse_jwt_payload(token);
      const login_id = payload.loginId || "";
      const app_secret = "test";
      const nonce = uuid32().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      const message = login_id + app_secret + nonce + (query_string || "") + (json_body || "");
      const signature = b64encode(hmacSha256Bytes(utf8Bytes(app_secret), utf8Bytes(message)));
      return {
        "X-User-Id": login_id,
        "X-Nonce": nonce,
        "X-Timestamp": String(Date.now()),
        "X-Signature": signature,
        "Content-Type": "application/json",
      };
    } catch (e) {
      this.log("Signature Generation Error: " + (e && e.message ? e.message : e));
      return {};
    }
  },

  async generate_market_watering_signature_headers(user_token, xbsosjl, login_id, request_ts) {
    try {
      const message = "td:433:tp" + xbsosjl + "td:334:et" + login_id + "td:334:et" + request_ts + "td:334:et";
      const signature = b64encode(hmacSha256Bytes(utf8Bytes(String(login_id)), utf8Bytes(message)));
      return { "X-Signature": signature };
    } catch (e) {
      this.log("Market Watering Signature Error: " + (e && e.message ? e.message : e));
      return {};
    }
  },

  async get_market_headers(user_token) {
    return {
      "User-Agent": COMMON_CONSTANTS.MARKET_UA,
      "Authorization": "Bearer " + user_token,
      "Content-Type": "application/json",
      "X-Requested-With": "com.sinovatech.unicom.ui",
    };
  },
});
// Part 04: 权益超市（对应 Python 19705.py 第 1348-1948 行，22 个方法）

// Python datetime.now().strftime('%Y-%m-%d')
function fmtYmd(d) {
d = d || new Date();
return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

Object.assign(UserService.prototype, {

async market_get_ticket() {
this.log("权益超市: 正在获取 ticket...");
const target_url = "https://contact.bol.wo.cn/market";
const res = await this.openPlatLineNew(target_url);
if (res && ("ticket" in res)) {
this.log("权益超市: 获取ticket成功");
return res.ticket;
}
this.log("权益超市: 获取ticket失败");
return null;
},

async market_get_user_token(ticket) {
const url = `https://backward.bol.wo.cn/prod-api/auth/marketUnicomLogin?ticket=${ticket}`;
const headers = {
'User-Agent': COMMON_CONSTANTS['MARKET_UA'],
'Connection': "Keep-Alive",
'Accept-Encoding': "gzip",
};
for (let attempt = 1; attempt < 4; attempt++) {
try {
this.log(`权益超市: 正在获取 userToken...${attempt > 1? ` (第${attempt}次重试)`: ""}`);
const res = await (await this.httpPost(url, { headers: headers, timeout: 30})).json();
if (res.code === 200) {
const user_token = (res.data || {}).token;
if (user_token) {
this.log("权益超市: 获取userToken成功");
return user_token;
}
}
this.log(`权益超市: 获取userToken失败: ${res.msg}`);
} catch (e) {
this.log(`权益超市: 获取userToken异常: ${e}`);
}
if (attempt < 3) {
this.log(`权益超市: 等待5秒后重试...`);
await sleep(5 * 1000);
}
}
return null;
},

async query_market_watering_status(user_token) {
try {
const status_url = "https://backward.bol.wo.cn/prod-api/promotion/activityTask/getMultiCycleProcess?activityId=13";
const headers = await this.get_market_headers(user_token);
const res = await (await this.httpGet(status_url, { headers: headers})).json();
if (res.code === 200) {
const data = res.data || {};
const triggered_time = data.triggeredTime?? 0;
const trigger_time = data.triggerTime?? 0;
const create_date = data.createDate?? "";
this.log(`权益超市-浇花当前状况: 进度 ${triggered_time}/${trigger_time}`, true);
if (triggered_time >= trigger_time) {
this.log("权益超市-浇花: 🌟 您有鲜花权益待领取! (连续浇花已满) 🌟", true);
} else {
const today_str = fmtYmd(new Date());
const last_watered = create_date? create_date.split(" ")[0]: "";
if (today_str === last_watered) {
this.log(`权益超市-浇花: 今日已浇水 (最后: ${create_date})`, true);
} else {
this.log("权益超市-浇花: 今日尚未浇水。");
}
}
} else {
this.log(`权益超市-浇花查验: 查询状态失败: ${res.msg}`);
}
} catch (e) {
this.log(`权益超市-浇花查验: 异常: ${e}`);
}
},

async market_watering_task(user_token) {
this.log("权益超市: 浇花任务开始...");
try {
const status_url = "https://backward.bol.wo.cn/prod-api/promotion/activityTask/getMultiCycleProcess?activityId=13";
const headers = await this.get_market_headers(user_token);
const res = await (await this.httpGet(status_url, { headers: headers})).json();
if (res.code!== 200) {
this.log(`权益超市-浇花: ❌ 失败: 获取状态失败: ${res.msg}`, true);
return;
}
const data = res.data || {};
const before_triggered = safeInt(data.triggeredTime?? 0);
const trigger_time = safeInt(data.triggerTime?? 0);
const create_date = data.createDate?? "";
const today_str = fmtYmd(new Date());
const last_watered = create_date? create_date.split(" ")[0]: "";
if (today_str === last_watered) {
this.log(`权益超市-浇花: 今日已浇水 (${before_triggered}/${trigger_time})`, true);
return;
}
if (before_triggered >= trigger_time) {
this.log(`权益超市-浇花: 🌟 已达领奖条件 (${before_triggered}/${trigger_time})`, true);
return;
}
const token = user_token.replace("Bearer ", "");
const payload = await this.parse_jwt_payload(token);
const login_id = payload.loginId?? "";
if (!login_id) {
this.log("权益超市-浇花: ❌ 失败: 无法获取登录标识", true);
return;
}
const xbsosjl = "Y1mN8fNYktY0";
const request_ts = String(Date.now());
const query_string = `xbsosjl=${xbsosjl}&timeVerRan=${request_ts}&diceid=${login_id}`;
const watering_url = `https://backward.bol.wo.cn/prod-api/promotion/activityTaskShare/checkWatering?${query_string}`;
const wsig_headers = await this.generate_market_watering_signature_headers(user_token, xbsosjl, login_id, request_ts);
const req_headers = {
'Authorization': `Bearer ${token}`,
'X-Signature': wsig_headers["X-Signature"] || "",
'User-Agent': COMMON_CONSTANTS['MARKET_H5_UA'],
'Content-Type': 'application/json',
'Origin': 'https://contact.bol.wo.cn',
'Referer': 'https://contact.bol.wo.cn/',
'X-Requested-With': 'com.sinovatech.unicom.ui',
'Accept': '*/*',
};
const water_res = await (await this.httpPost(watering_url, { headers: req_headers, data: "{}"})).json();
if (water_res.code!== 200) {
this.log(`权益超市-浇花: ❌ 失败: ${water_res.msg}`, true);
return;
}
await sleep(1 * 1000);
const check_res = await (await this.httpGet(status_url, { headers: headers})).json();
if (check_res.code!== 200) {
this.log(
`权益超市-浇花: ✅ 浇水成功 (当前进度约 ${before_triggered}/${trigger_time}，APP 可能稍后刷新)`,
true
);
return;
}
const check_data = check_res.data || {};
const after_triggered = safeInt(check_data.triggeredTime?? before_triggered);
const after_trigger_time = safeInt(check_data.triggerTime?? trigger_time) || trigger_time;
if (after_triggered!== before_triggered) {
this.log(
`权益超市-浇花: ✅ 浇水成功 (${before_triggered}/${after_trigger_time} → ${after_triggered}/${after_trigger_time})`,
true
);
return;
}
this.log(
`权益超市-浇花: ✅ 浇水成功 (当前进度约 ${before_triggered}/${trigger_time}，APP 可能稍后刷新)`,
true
);
} catch (e) {
this.log(`权益超市-浇花: ❌ 失败: ${e}`, true);
}
},

async market_get_raffle(user_token) {
this.log("权益超市: 正在查询奖品池...");
try {
const timestamp = Date.now();
const query_string = `id=12&timeVerRan=${timestamp}`;
const json_body = "{}";
const sig_headers = await this.generate_market_signature_headers(user_token, query_string, json_body);
const url = `https://backward.bol.wo.cn/prod-api/promotion/home/raffleActivity/prizeList?${query_string}`;
const headers = await this.get_market_headers(user_token);
Object.assign(headers, sig_headers);
headers['Referer'] = 'https://contact.bol.wo.cn/market';
headers['Origin'] = 'https://contact.bol.wo.cn';
const res = await (await this.httpPost(url, { headers: headers, data: json_body})).json();
if (res.code === 200 && Array.isArray(res.data)) {
const keywords = ['月卡', '月会员', '月度', 'VIP月', '一个月', '周卡'];
const exclude = ['5G宽视界', '沃视频'];
const live_prizes = [];
for (const p of res.data) {
const vip_prob = parseFloat(p.probabilityVip || p.newVipProbability || 0);
const norm_prob = parseFloat(p.probability || 0);
const name = p.name?? "";
const daily_limit = safeInt(p.dailyPrizeLimit || 0);
const match = keywords.some((k) => name.includes(k));
const not_excluded =!exclude.some((e) => name.includes(e));
const has_stock = daily_limit > 0;
const has_chance = norm_prob > 0 || vip_prob > 0;
if (match && not_excluded && has_stock && has_chance) {
live_prizes.push(p);
const total_limit = safeInt(p.quantity || 0);
this.log(`权益超市: 监测到放水 (日库存:${daily_limit}, 总库存:${total_limit}, 普通概率:${(norm_prob * 100).toFixed(4)}%, VIP概率:${(vip_prob * 100).toFixed(4)}%)`);
}
}
if (live_prizes.length) {
return true;
}
}
this.log("权益超市: 📢 未监测到高价值权益放水");
return false;
} catch (e) {
this.log(`权益超市: 查询奖品池异常: ${e}`);
return false;
}
},

async market_get_raffle_count(user_token) {
try {
const timestamp = Date.now();
const query_string = `id=12&channel=unicomTab&timeVerRan=${timestamp}`;
const json_body = "{}";
const sig_headers = await this.generate_market_signature_headers(user_token, query_string, json_body);
const url = `https://backward.bol.wo.cn/prod-api/promotion/home/raffleActivity/getUserRaffleCountExt?${query_string}`;
const headers = await this.get_market_headers(user_token);
Object.assign(headers, sig_headers);
headers['Referer'] = 'https://contact.bol.wo.cn/market';
headers['Origin'] = 'https://contact.bol.wo.cn';
const res = await (await this.httpPost(url, { headers: headers, data: json_body})).json();
let count = 0;
if (res.code === 200) {
const data = res.data;
if (isObj(data)) {
count = safeInt(data.raffleCount || 0);
} else {
count = safeInt(data || 0);
}
}
if (count > 0) {
this.log(`权益超市: ✅ 当前抽奖次数: ${count}`);
for (let i = 0; i < count; i++) {
this.log(`权益超市: 🎯 第 ${i + 1} 次抽奖...`);
if (!(await this.market_user_raffle(user_token))) {
break;
}
await sleep((3 + Math.random() * 2) * 1000);
}
} else {
this.log("权益超市: 当前无抽奖次数");
}
} catch (e) {
this.log(`权益超市: 查询抽奖次数异常: ${e}`);
}
},

async market_user_raffle(user_token) {
try {
const timestamp = Date.now();
const query_string = `id=12&channel=unicomTab&timeVerRan=${timestamp}`;
const json_body = "{}";
const sig_headers = await this.generate_market_signature_headers(user_token, query_string, json_body);
const url = `https://backward.bol.wo.cn/prod-api/promotion/home/raffleActivity/userRaffle?${query_string}`;
const headers = await this.get_market_headers(user_token);
Object.assign(headers, sig_headers);
headers['Referer'] = 'https://contact.bol.wo.cn/market';
const res = await (await this.httpPost(url, { headers: headers, data: json_body})).json();
if (res.code === 200) {
const data = res.data || {};
const prize_name = data.prizesName?? "";
const message = data.message || res.msg || "";
if (prize_name &&!prize_name.includes("谢谢参与")) {
this.log(`权益超市: 🎉 抽奖成功: ${prize_name}`, true);
return true;
}
this.log(`权益超市: 💨 未中奖: ${message}`, true);
return true;
}
this.log(`权益超市: 抽奖失败: ${res.msg}`);
return false;
} catch (e) {
this.log(`权益超市: 抽奖异常: ${e}`);
return false;
}
},

async market_get_all_tasks(ecs_token, user_token) {
const url = "https://backward.bol.wo.cn/prod-api/promotion/activityTask/getAllActivityTasks?activityId=12";
const headers = {
"Authorization": `Bearer ${user_token}`,
"User-Agent": COMMON_CONSTANTS["MARKET_UA"],
"Origin": "https://contact.bol.wo.cn",
"Referer": "https://contact.bol.wo.cn/",
"Cookie": `ecs_token=${ecs_token}`
};
for (let attempt = 1; attempt < 4; attempt++) {
try {
this.log(`权益超市: 正在获取任务列表...${attempt > 1? ` (第${attempt}次重试)`: ""}`);
const res = await (await this.httpGet(url, { headers: headers, timeout: 15})).json();
if (res.code === 200) {
const tasks = (res.data || {}).activityTaskUserDetailVOList || [];
this.log(`权益超市: 成功获取到 ${tasks.length} 个任务`);
return tasks;
}
this.log(`权益超市: 查询任务列表失败: ${res.msg}`);
} catch (e) {
this.log(`权益超市: 获取任务列表异常: ${e}`);
}
if (attempt < 3) {
this.log("权益超市: 等待5秒后重试...");
await sleep(5 * 1000);
}
}
return [];
},

async market_do_share_list(share_list, user_token) {
this.log("权益超市: 开始执行任务...");
for (const task of share_list) {
const name = task.name?? "";
const param = task.param1?? "";
const trigger_time = task.triggerTime?? 0;
const triggered_time = task.triggeredTime?? 0;
if (["购买", "秒杀"].some((k) => name.includes(k))) {
this.log(`权益超市: 🚫 ${name} [跳过]`);
continue;
}
if (triggered_time >= trigger_time) {
this.log(`权益超市: ✅ ${name} [已完成]`);
continue;
}
let url = "";
if (["浏览", "查看"].some((k) => name.includes(k))) {
url = `https://backward.bol.wo.cn/prod-api/promotion/activityTaskShare/checkView?checkKey=${param}`;
} else if (name.includes("分享")) {
url = `https://backward.bol.wo.cn/prod-api/promotion/activityTaskShare/checkShare?checkKey=${param}`;
}
if (url) {
try {
const headers = {
"Authorization": `Bearer ${user_token}`,
"User-Agent": COMMON_CONSTANTS["MARKET_UA"],
"Origin": "https://contact.bol.wo.cn",
"Referer": "https://contact.bol.wo.cn/"
};
const res = await (await this.httpPost(url, { json: {}, headers: headers, timeout: 15})).json();
if (res.code === 200) {
this.log(`权益超市: ✅ ${name} [执行成功]`);
} else {
this.log(`权益超市: ❌ ${name} [执行失败]: ${res.msg}`);
}
} catch (e) {
this.log(`权益超市: ❌ ${name} [执行异常]: ${e}`);
}
}
await sleep(2 * 1000);
}
},

async market_get_points_ticket(user_token) {
try {
const res = await (await this.httpGet(
"https://backward.bol.wo.cn/prod-api/auth/getTicket?channel=pointsPlatform",
{
headers: {
"Authorization": `Bearer ${user_token}`,
"User-Agent": COMMON_CONSTANTS["MARKET_UA"],
},
timeout: 15,
}
)).json();
if (res.code === 200 && res.data) {
return res.data;
}
this.log(`权益超市-会员中心: 获取 points ticket 失败: ${res.msg || JSON.stringify(res)}`);
} catch (e) {
this.log(`权益超市-会员中心: 获取 points ticket 异常: ${e}`);
}
return null;
},

async market_member_center_base_headers(points_ticket) {
const referer =
`https://m.jf.10010.com/ts-mobile/well/${MARKET_MEMBER_CENTER_PAGE_ID}` +
`?distributeId=${MARKET_MEMBER_CENTER_DISTRIBUTE_ID}` +
`&partnersId=${MARKET_MEMBER_CENTER_PARTNERS_ID}` +
`&clientType=${MARKET_MEMBER_CENTER_CLIENT_TYPE}` +
`&ticket=${points_ticket}`;
return {
"origin": "https://m.jf.10010.com",
"clienttype": MARKET_MEMBER_CENTER_CLIENT_TYPE,
"ticket": points_ticket,
"partnersid": MARKET_MEMBER_CENTER_PARTNERS_ID,
"content-type": "application/json;charset=UTF-8",
"pageid": MARKET_MEMBER_CENTER_PAGE_ID,
"Accept": "application/json, text/plain, */*",
"Referer": referer,
"User-Agent": COMMON_CONSTANTS["MARKET_H5_UA"],
"X-Requested-With": "com.sinovatech.unicom.ui",
};
},

async market_get_secret_key_jf(points_ticket) {
if (this.market_jf_secretKey && this.market_jf_ticket === points_ticket) {
return this.market_jf_secretKey;
}
try {
const res = await (await this.httpGet(
"https://m.jf.10010.com/jf-external-application/jftask/getSecretKey",
{ headers: await this.market_member_center_base_headers(points_ticket), timeout: 10}
)).json();
const secret = (res.data || {}).secretKey;
if (res.code === "0000" && secret) {
this.market_jf_ticket = points_ticket;
this.market_jf_secretKey = utf8Bytes(secret);
return this.market_jf_secretKey;
}
this.log(`权益超市-会员中心: getSecretKey 失败: ${JSON.stringify(res)}`);
} catch (e) {
this.log(`权益超市-会员中心: getSecretKey 异常: ${e}`);
}
return null;
},

async market_build_signature_headers_jf(points_ticket) {
const secret_key = await this.market_get_secret_key_jf(points_ticket);
if (!secret_key) {
return {};
}
const request_ts = String(Math.round(Date.now()));
const nonce = randomString(8, "0123456789abcdefghijklmnopqrstuvwxyz");
const signature = hmacSha256(secret_key, `${nonce}${request_ts}`);
return {
"x-request-timestamp": request_ts,
"x-request-nonce": nonce,
"x-request-signature": signature,
};
},

async market_member_center_headers(points_ticket, with_sign) {
if (with_sign === undefined) with_sign = false;
const headers = await this.market_member_center_base_headers(points_ticket);
if (with_sign) {
Object.assign(headers, await this.market_build_signature_headers_jf(points_ticket));
}
return headers;
},

async market_prepare_member_center_context(points_ticket) {
const signed_headers = await this.market_member_center_headers(points_ticket, true);
try {
await this.httpPost(
"https://m.jf.10010.com/jf-external-application/page/query",
{
json: {
"activityId": MARKET_MEMBER_CENTER_PAGE_ID,
"distributeId": MARKET_MEMBER_CENTER_DISTRIBUTE_ID,
"partnersId": MARKET_MEMBER_CENTER_PARTNERS_ID,
},
headers: signed_headers,
timeout: 10,
}
);
} catch (e) {
this.log(`权益超市-会员中心: page/query 预热异常: ${e}`);
}
try {
await this.httpPost(
"https://m.jf.10010.com/jf-external-application/jftask/userInfo",
{
json: {},
headers: await this.market_member_center_headers(points_ticket, true),
timeout: 10,
}
);
} catch (e) {
this.log(`权益超市-会员中心: userInfo 预热异常: ${e}`);
}
},

async market_member_center_finish_code(task) {
return safeInt(task.finish?? task.status?? 0, 0);
},

async market_member_center_finish_text(task) {
const finish_text = String(task.finishText?? "").trim();
if (finish_text) {
return finish_text;
}
return ({ 0: "未完成", 99: "待领取", 100: "已领取"})[await this.market_member_center_finish_code(task)]?? "未知状态";
},

async market_query_member_center_task(points_ticket) {
try {
const res = await (await this.httpPost(
"https://m.jf.10010.com/jf-external-application/jftask/taskDetail",
{
json: {},
headers: await this.market_member_center_headers(points_ticket, true),
timeout: 10,
}
)).json();
if (res.code!== "0000") {
this.log(`权益超市-会员中心: 查询任务失败: ${JSON.stringify(res)}`);
return null;
}
const task_list = ((res.data || {}).taskDetail || {}).taskList || [];
return task_list.find((task) => String(task.taskCode) === MARKET_MEMBER_CENTER_TASK_CODE) || null;
} catch (e) {
this.log(`权益超市-会员中心: 查询任务异常: ${e}`);
return null;
}
},

async market_wait_member_center_task_state(points_ticket, expected_codes, attempts, delay) {
if (attempts === undefined) attempts = 4;
if (delay === undefined) delay = 2;
let task = null;
for (let idx = 1; idx <= attempts; idx++) {
task = await this.market_query_member_center_task(points_ticket);
if (task) {
const finish_code = await this.market_member_center_finish_code(task);
const finish_text = await this.market_member_center_finish_text(task);
const text_matches =
(finish_text === "待领取" && expected_codes.includes(99)) ||
(finish_text === "已领取" && expected_codes.includes(100));
if (expected_codes.includes(finish_code) || text_matches) {
return task;
}
this.log(
`权益超市-会员中心: 第${idx}次回查状态 ${finish_text}/${finish_code}，` +
`本月进度 ${safeInt(task.finishCount, 0)}/${safeInt(task.needCount, 0)}`
);
}
if (idx < attempts) {
await sleep(delay * 1000);
await this.market_prepare_member_center_context(points_ticket);
}
}
return task;
},

async market_mark_member_center_browse_done(user_token, task_fix_id) {
try {
const headers = {
"Authorization": `Bearer ${user_token}`,
"Origin": "https://contact.bol.wo.cn",
"Referer": "https://contact.bol.wo.cn/",
"Content-Type": "application/json",
"Accept": "*/*",
"User-Agent": COMMON_CONSTANTS["MARKET_H5_UA"],
"X-Requested-With": "com.sinovatech.unicom.ui",
};
const detail = await (await this.httpGet(
`https://backward.bol.wo.cn/prod-api/promotion/activityTask/getActivityTaskDetailByFixId?taskFixId=${task_fix_id}`,
{ headers: headers, timeout: 10}
)).json();
if (detail.code!== 200) {
this.log(`权益超市-会员中心: 获取任务详情失败: ${detail.msg || JSON.stringify(detail)}`);
return false;
}
const task_data = detail.data || {};
const check_key = task_data.param1;
const wait_seconds = Math.max(safeInt(task_data.content, 17), 15);
if (!check_key) {
this.log("权益超市-会员中心: 未拿到 checkKey，跳过浏览任务");
return false;
}
this.log(`权益超市-会员中心: 模拟浏览会员中心 ${wait_seconds} 秒`);
await sleep(wait_seconds * 1000);
const check = await (await this.httpPost(
`https://backward.bol.wo.cn/prod-api/promotion/activityTaskShare/checkView?checkKey=${check_key}`,
{ json: {}, headers: headers, timeout: 10}
)).json();
if (check.code === 200 && check.data === true) {
this.log("权益超市-会员中心: 浏览完成，任务已进入待领取");
return true;
}
this.log(`权益超市-会员中心: checkView 失败: ${check.msg || JSON.stringify(check)}`);
} catch (e) {
this.log(`权益超市-会员中心: 浏览任务异常: ${e}`);
}
return false;
},

async market_receive_member_center_points(points_ticket) {
try {
const res = await (await this.httpPost(
"https://m.jf.10010.com/jf-external-application/jfmarkettask/receive",
{
json: { "taskCode": MARKET_MEMBER_CENTER_TASK_CODE},
headers: await this.market_member_center_headers(points_ticket, true),
timeout: 10,
}
)).json();
if (res.code === "0000") {
const score = (res.data || {}).score?? "未知积分";
const title = (res.data || {}).title?? "领取成功";
this.log(`权益超市-会员中心: ✅ ${title}，获得 ${score}`, true);
return true;
}
this.log(`权益超市-会员中心: 领取失败: ${res.msg || JSON.stringify(res)}`);
} catch (e) {
this.log(`权益超市-会员中心: 领取异常: ${e}`);
}
return false;
},

async market_member_center_task(user_token) {
this.log("权益超市-会员中心: 开始检查浏览任务");
const points_ticket = await this.market_get_points_ticket(user_token);
if (!points_ticket) {
return;
}
await this.market_prepare_member_center_context(points_ticket);
let task = await this.market_query_member_center_task(points_ticket);
if (!task) {
this.log("权益超市-会员中心: 未找到目标任务");
return;
}
let finish_code = await this.market_member_center_finish_code(task);
let finish_text = await this.market_member_center_finish_text(task);
const finish_count = safeInt(task.finishCount, 0);
const need_count = safeInt(task.needCount, 0);
this.log(`权益超市-会员中心: 当前状态 ${finish_text}/${finish_code}，本月进度 ${finish_count}/${need_count}`);
if (finish_count >= need_count) {
this.log("权益超市-会员中心: 本月次数已达上限");
return;
}
if (finish_code === 100 || finish_text === "已领取") {
this.log("权益超市-会员中心: 今日已领取，跳过");
return;
}
if (finish_code === 0 || finish_text === "未完成") {
const jump_url = String(task.jumpUrl?? "").trim();
const match = jump_url.match(/taskFixId=(\d+)/);
const task_fix_id = match? match[1]: "90";
if (!(await this.market_mark_member_center_browse_done(user_token, task_fix_id))) {
return;
}
await this.market_prepare_member_center_context(points_ticket);
task = await this.market_wait_member_center_task_state(points_ticket, [99, 100], 4, 2);
if (!task) {
return;
}
finish_code = await this.market_member_center_finish_code(task);
finish_text = await this.market_member_center_finish_text(task);
this.log(`权益超市-会员中心: 浏览后状态 ${finish_text}/${finish_code}，本月进度 ${safeInt(task.finishCount, 0)}/${safeInt(task.needCount, 0)}`);
}
if (finish_code === 99 || finish_text === "待领取") {
await this.market_receive_member_center_points(points_ticket);
} else if (finish_code!== 100) {
this.log("权益超市-会员中心: 状态未及时刷新，尝试直接领奖兜底");
if (await this.market_receive_member_center_points(points_ticket)) {
return;
}
this.log("权益超市-会员中心: 直接领奖兜底失败，跳过");
}
},

async market_task(is_query_only) {
if (is_query_only === undefined) is_query_only = false;
this.log("==== 权益超市 ====");
const ticket = await this.market_get_ticket();
if (!ticket) {
return;
}
const user_token = await this.market_get_user_token(ticket);
if (!user_token) {
return;
}
if (is_query_only) {
await this.query_market_watering_status(user_token);
await this.query_market_raffle_records(user_token);
await this.query_phone_recharge_records(user_token);
return;
}
const mc = globalConfig.market_config;
if (mc.run_water) {
await this.market_watering_task(user_token);
await sleep(2 * 1000);
} else {
this.log("权益超市-浇水: ⏭️ 已被总开关关闭，跳过");
}
if (mc.run_task) {
if ("ecs_token" in this) {
const share_list = await this.market_get_all_tasks(this.ecs_token, user_token);
if (share_list && share_list.length) {
await this.market_do_share_list(share_list, user_token);
}
} else {
this.log("权益超市: 缺 ecs_token, 跳过通用任务列表");
}
} else {
this.log("权益超市-做任务: ⏭️ 已被总开关关闭，跳过");
}
if (mc.run_member_center) {
await sleep(2 * 1000);
await this.market_member_center_task(user_token);
} else {
this.log("权益超市-会员中心: ⏭️ 已被子开关关闭，跳过");
}
if (mc.run_draw) {
if (await this.market_get_raffle(user_token)) {
await this.market_get_raffle_count(user_token);
}
} else {
this.log("权益超市-抽奖: ⏭️ 已被总开关关闭，跳过");
}
if (mc.run_claim) {
this.log("权益超市-领奖: 自动领奖已开启");
await this.query_phone_recharge_records(user_token);
} else {
this.log("权益超市-领奖: ⏭️ 未开启自动领奖");
}
await this.query_market_raffle_records(user_token);
await this.query_phone_recharge_records(user_token);
},

});
// Part 05: 联通云盘
// 来源: 19705.py 1949-3337 行 (init_cloud_urls 起的 *_cloud 方法，不含 ltyp_task)
// 说明: 文件上传一律使用内存生成的 cloudSeedJpegBytes()，不做 6MB 零填充，fileSize 填实际字节长度

function cloudEscapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

Object.assign(UserService.prototype, {

  async init_cloud_urls() {
    if (!this.cloudDiskUrls) {
      this.cloudDiskUrls = {
        'onLine': "https://m.client.10010.com/mobileService/onLine.htm",
        'getTicketByNative': "https://m.client.10010.com/edop_ng/getTicketByNative",
        'userticket': "https://panservice.mail.wo.cn/api-user/api/user/ticket",
        'ltypDispatcher': "https://panservice.mail.wo.cn/wohome/dispatcher",
        'query': "https://m.jf.10010.com/jf-external-application/page/query",
        'taskDetail': "https://m.jf.10010.com/jf-external-application/jftask/taskDetail",
        'taskRecords': "https://m.jf.10010.com/jf-external-application/jftask/taskRecords",
        'dosign': "https://m.jf.10010.com/jf-external-application/jftask/sign",
        'upload2C': "https://tjupload.pan.wo.cn/openapi/client/upload2C",
        'doPopUp': "https://m.jf.10010.com/jf-external-application/jftask/popUp",
        'toFinish': "https://m.jf.10010.com/jf-external-application/jftask/toFinish",
        'lottery': "https://panservice.mail.wo.cn/activity/lottery",
        'openActivity': "https://panservice.mail.wo.cn/activity/openActivity",
        'checkActivityStatus': "https://panservice.mail.wo.cn/activity/checkActivityStatus",
        'userInfo': "https://m.jf.10010.com/jf-external-application/jftask/userInfo",
        'ai_query': "https://panservice.mail.wo.cn/wohome/ai/assistant/query",
        'lottery_times': "https://panservice.mail.wo.cn/activity/lottery/lottery-times",
        'aiMoveFile': "https://panservice.mail.wo.cn/wohome/open/v1/ai/moveFile2SystemFolder",
        'activityUpload2C': "https://du.smartont.net:8443/openapi/client/upload2C",
        'queryPhoneLocation': "https://panservice.mail.wo.cn/api-user/user/info/query",
        'getScanState': "https://s.pan.wo.cn/wohome/intelligentClean/getScanStateAndResult",
        'getCleanData': "https://s.pan.wo.cn/wohome/intelligentClean/getCleanData",
        'batchClean': "https://s.pan.wo.cn/wohome/intelligentClean/batchClean",
        'vote': "https://panservice.mail.wo.cn/activity/activity-task/vote",
        'secretKey': "https://m.jf.10010.com/jf-external-application/jftask/getSecretKey",
        'taskFinish': "https://panservice.mail.wo.cn/activity/member-point/v1/task/finish",
      };
    }
  },

  async cloudRequest(url_name, payload, is_changer, method, custom_headers) {
    if (is_changer === undefined) is_changer = false;
    if (method === undefined) method = 'post';
    if (custom_headers === undefined) custom_headers = null;
    await this.init_cloud_urls();
    const url = this.cloudDiskUrls[url_name];
    if (!url) {
      this.log(`云盘无效的URL名称: ${url_name}`);
      return {result: null, headers: null};
    }
    const headers = {
      'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301}",
      'Connection': "Keep-Alive",
      'Accept-Encoding': "gzip",
    };
    if (custom_headers) Object.assign(headers, custom_headers);
    if (['dosign', 'userInfo', 'doPopUp', 'toFinish', 'taskDetail', 'taskRecords'].includes(url_name)) {
      if (!((this.cloudDisk || {}).userticket)) {
        this.log(`云盘 [{url_name}] userticket 未获取`);
        return {result: null, headers: null};
      }
      headers['ticket'] = this.cloudDisk.userticket;
      headers['content-type'] = "application/json;charset=UTF-8";
      headers['partnersid'] = "1649";
      headers['origin'] = "https://m.jf.10010.com";
      if ((this.cloudDisk || {}).jeaId) {
        headers['Cookie'] = `_jea_id=${this.cloudDisk.jeaId};`;
      }
      if (['dosign', 'toFinish'].includes(url_name)) {
        const sig_headers = await this.build_signature_headers_cloud();
        if (sig_headers) Object.assign(headers, sig_headers);
      }
      if (is_changer) {
        headers['clienttype'] = "yunpan_unicom_applet";
        headers['x-requested-with'] = "com.sinovatech.unicom.ui";
        if (url_name === 'toFinish') {
          headers['User-Agent'] = "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36/woapp LianTongYunPan/4.0.4 (Android 12)";
          headers['clienttype'] = "yunpan_android";
          headers['x-requested-with'] = "com.chinaunicom.bol.cloudapp";
        }
      } else {
        headers['clienttype'] = "yunpan_android";
        headers['x-requested-with'] = "com.sinovatech.unicom.ui";
      }
    } else if (url_name === 'ai_query') {
      const model_id = (payload && payload.modelId !== undefined && payload.modelId !== null) ? payload.modelId : 1;
      Object.assign(headers, {
        'accept': 'text/event-stream',
        'X-YP-Access-Token': this.cloudDisk.userToken,
        'X-YP-App-Version': '5.0.12',
        'X-YP-Client-Id': '1001000035',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-N9810 Build/PQ3A.190705.11211540; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Mobile Safari/537.36/woapp LianTongYunPan/5.0.12 (Android 9)',
        'Content-Type': 'application/json',
        'Origin': 'https://panservice.mail.wo.cn',
        'X-Requested-With': 'com.chinaunicom.bol.cloudapp',
        'Referer': `https://panservice.mail.wo.cn/h5/wocloud_ai/?modelType=${model_id}&clientId=1001000035&touchpoint=300300010001&token=${this.cloudDisk.userToken}`,
      });
    } else if (url_name === 'lottery_times') {
      method = 'get';
      Object.assign(headers, {
        'X-YP-Access-Token': this.cloudDisk.userToken, 'source-type': 'woapi', 'clientId': '1001000165',
        'token': this.cloudDisk.userToken, 'X-YP-Client-Id': '1001000165',
      });
    } else if (url_name === 'aiMoveFile') {
      Object.assign(headers, {
        'X-YP-Device-Id': 'yOH1Y2/Ck5tBHRRBEAPCoGRGBOHCob7I',
        'app-type': 'liantongyunpanapp',
        'Access-Token': this.cloudDisk.userToken,
        'Client-Id': '1001000035',
        'App-Version': 'yp-app/5.1.0',
        'Sys-Version': 'Android/15',
        'User-Agent': 'LianTongYunPan/5.1.0 (Android 15)',
        'X-YP-Client-Id': '1001000035',
        'X-YP-Access-Token': this.cloudDisk.userToken,
        'oaid': '00000000',
        'Content-Type': 'application/json;charset=utf-8',
        'Origin': 'https://panservice.mail.wo.cn',
      });
    } else if (url_name.indexOf('cloud_') === 0 || url_name.indexOf('shareCard') >= 0) {
      const current_token = ((this.cloudDisk || {}).userToken) || '';
      Object.assign(headers, {
        'Host': 'panservice.mail.wo.cn',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; PJZ110 Build/AP3A.240617.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.109 Mobile Safari/537.36/woapp LianTongYunPan/5.1.0 (Android 15)',
        'client-Id': '1001000035',
        'X-YP-Client-Id': '1001000035',
        'accessToken': current_token,
        'access-token': current_token,
        'X-YP-Access-Token': current_token,
        'Authorization': `Bearer ${current_token}`,
        'X-Requested-With': 'com.chinaunicom.bol.cloudapp',
        'Content-Type': 'application/json',
        'Origin': 'https://panservice.mail.wo.cn',
      });
      let touchpoint = '300300010032';
      if (url_name.indexOf('lightPuzzle') >= 0) touchpoint = '300300010003';
      if (url_name.indexOf('shareCardReceive') >= 0) {
        headers['User-Agent'] = "Mozilla/5.0 (Linux; Android 15; PJZ110 Build/AP3A.240617.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.7444.173 Mobile Safari/537.36 XWEB/1420229 MMWEBSDK/20250802 MMWEBID/7928 MicroMessenger/8.0.62.2900(0x28003EA0) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64";
        headers['X-Requested-With'] = "com.tencent.mm";
        headers['X-YP-GRAY-FLAG'] = "undefined";
        const uniq_key = (isObj(payload) ? (payload.uniqKey ?? '') : '');
        const card_code = (isObj(payload) ? (payload._cardCode ?? 'LT') : 'LT');
        if (isObj(payload) && ('_cardCode' in payload)) delete payload['_cardCode'];
        headers['Referer'] = `https://panservice.mail.wo.cn/h5/activitymobile/newYears26?uniqKey=${uniq_key}&cardCode=${card_code}&activityId=SPRING_FESTIVAL_2026&page=1&touchpoint=undefined`;
      } else {
        headers['Referer'] = `https://panservice.mail.wo.cn/h5/activitymobile/newYears26?activityId=SPRING_FESTIVAL_2026&touchpoint=${touchpoint}&token=${current_token}`;
        if (url_name === 'shareCard') headers['X-YP-GRAY-FLAG'] = "undefined";
      }
    }
    for (let attempt = 1; attempt < 4; attempt++) {
      try {
        let res;
        if (method === 'get') res = await this.httpGet(url, {params: payload, headers: headers, timeout: 15});
        else res = await this.httpPost(url, {json: payload, headers: headers, timeout: 15});
        if (url_name === 'ai_query') {
          return {result: null, body: await res.text(), headers: res.headers};
        }
        try {
          return {result: await res.json(), headers: res.headers, status: res.status};
        } catch (e) {
          return {result: await res.text(), headers: res.headers, status: res.status};
        }
      } catch (e) {
        const err_msg = String((e && e.message) || e);
        if (attempt < 3 && env("UNICOM_PROXY_API") && (err_msg.includes("Max retries exceeded") || err_msg.toLowerCase().includes("timed out") || err_msg.toLowerCase().includes("connection") || err_msg.includes("SOCKS"))) {
          this.log(`cloudRequest [${url_name}] 网络异常触发故障转移(${err_msg}), 正在更换代理...`);
          this.failover_proxy();
          continue;
        }
        if (attempt === 3) {
          this.log(`cloudRequest Exception [${url_name}]: ${e}`);
          return {result: null, headers: null, status: 599};
        }
        this.log(`cloudRequest [${url_name}] 网络异常(${e}), 重试第${attempt}次...`);
        await sleep(2000);
      }
    }
  },

  async encrypt_data_cloud(data, key, iv) {
    if (iv === undefined) iv = "wNSOYIB1k1DjY5lA";
    const key_padded = String(key).padEnd(16).slice(0, 16);
    const padded = pkcs7Pad(utf8Bytes(data), 16);
    return b64encode(aesCbcEncrypt(padded, utf8Bytes(key_padded), utf8Bytes(iv)));
  },

  async getTicketByNative_cloud() {
    for (let attempt = 1; attempt < 4; attempt++) {
      try {
        const url = `${this.cloudDiskUrls['getTicketByNative']}?appId=edop_unicom_d67b3e30&token=${this.ecs_token}`;
        const headers = {
          'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301}",
          'Connection': "Keep-Alive",
          'Accept-Encoding': "gzip",
        };
        const res = await (await this.httpGet(url, {headers: headers})).json();
        if (res.ticket) {
          this.cloudDisk.ticket = res.ticket;
          return res.ticket;
        } else if (String(res.code) === "9999") {
          this.log(`getTicketByNative_cloud 票据失效或被拦截: ${JSON.stringify(res)}`);
        }
      } catch (e) {
        const err_msg = String((e && e.message) || e);
        if (attempt < 3 && env("UNICOM_PROXY_API") && (err_msg.includes("Max retries exceeded") || err_msg.toLowerCase().includes("timed out") || err_msg.toLowerCase().includes("connection") || err_msg.includes("SOCKS"))) {
          this.log(`getTicketByNative_cloud 第${attempt}次异常触发故障转移: ${err_msg}`);
          this.failover_proxy();
          continue;
        }
        this.log(`getTicketByNative_cloud 第${attempt}次重试 - 异常: ${e}`);
        await sleep(2000);
      }
    }
    return null;
  },

  async get_ltypDispatcher_cloud(ticket) {
    for (let attempt = 1; attempt < 4; attempt++) {
      try {
        const timestamp = String(Date.now());
        const result_rnd = String(randInt(123456, 199999));
        const string_to_hash = "HandheldHallAutoLoginV2" + timestamp + result_rnd + "wohome";
        const sign = md5(string_to_hash);
        const payload = {
          "header": {
            "key": "HandheldHallAutoLoginV2",
            "resTime": timestamp,
            "reqSeq": result_rnd,
            "channel": "wohome",
            "version": "",
            "sign": sign
          },
          "body": {
            "clientId": "1001000003",
            "ticket": ticket
          }
        };
        const url = this.cloudDiskUrls['ltypDispatcher'];
        const headers = {'User-Agent': "Dalvik/2.1.0 (Linux; U; Android 12; leijun Pro Build/SKQ1.22013.001);unicom{version:android@11.0702}"};
        const res = await (await this.httpPost(url, {json: payload, headers: headers})).json();
        const token = (((res.RSP || {}).DATA) || {}).token;
        if (token) {
          this.cloudDisk.userToken = token;
          return token;
        }
      } catch (e) {
        const err_msg = String((e && e.message) || e);
        if (attempt < 3 && env("UNICOM_PROXY_API") && (err_msg.includes("Max retries exceeded") || err_msg.toLowerCase().includes("timed out") || err_msg.toLowerCase().includes("connection") || err_msg.includes("SOCKS"))) {
          this.log(`get_ltypDispatcher_cloud 第${attempt}次异常触发故障转移: ${err_msg}`);
          this.failover_proxy();
          continue;
        }
        this.log(`get_ltypDispatcher_cloud 第${attempt}次重试 - 异常: ${e}`);
        await sleep(2000);
      }
    }
    return null;
  },

  async get_userticket_cloud(is_changer) {
    if (is_changer === undefined) is_changer = false;
    if (!((this.cloudDisk || {}).userToken)) {
      this.log("云盘任务: 获取userticket失败, userToken未获取");
      return null;
    }
    let headers = {};
    if (is_changer) {
      headers = {
        'User-Agent': "LianTongYunPan/4.0.4 (Android 12)",
        'app-type': "liantongyunpanapp",
        'Client-Id': "1001000035",
        'App-Version': "yp-app/4.0.4",
        'Sys-Version': "Android/12",
        'X-YP-Client-Id': "1001000035",
        'X-YP-Access-Token': this.cloudDisk.userToken,
      };
    } else {
      headers = {
        'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301}",
        'Content-Type': 'application/json',
        'X-YP-Access-Token': this.cloudDisk.userToken,
        'accesstoken': this.cloudDisk.userToken,
        'token': this.cloudDisk.userToken,
        'clientId': "1001000003",
        'X-YP-Client-Id': "1001000003",
        'source-type': "woapi",
        'app-type': "unicom"
      };
    }
    for (let attempt = 1; attempt < 4; attempt++) {
      try {
        const res = await (await this.httpPost(this.cloudDiskUrls['userticket'], {json: {}, headers: headers, timeout: 15})).json();
        if (res && isObj(res) && ((res.result || {}).ticket)) {
          this.cloudDisk.userticket = res.result.ticket;
          return this.cloudDisk.userticket;
        } else {
          this.log(`get_userticket_cloud failed: ${JSON.stringify(res)}`);
          return null;
        }
      } catch (e) {
        this.log(`[get_userticket_cloud] 请求异常[${e}]，重试第${attempt}次`);
        await sleep(2000);
      }
    }
    return null;
  },

  async get_userInfo_cloud() {
    if (!(await this.get_userticket_cloud(false))) return;
    const data = await this.cloudRequest('userInfo', {}, false, 'post');
    const res = data.result;
    const headers = data.headers;
    if (headers) {
      const cookie = headers.get('Set-Cookie') || '';
      const match = cookie.match(/_jea_id=([^;]+)/);
      if (match) this.cloudDisk.jeaId = match[1];
    }
    if (res && res.data) {
      const avail = res.data.availableScore;
      const today_earn = (res.data.todayEarnScore !== undefined && res.data.todayEarnScore !== null) ? res.data.todayEarnScore : 0;
      if (!('initial_avail' in this.cloudDisk)) {
        this.cloudDisk.initial_avail = avail;
        this.log(`云盘任务: 运行前 - 今日已赚: ${today_earn}, 可用积分: ${avail}`);
      } else {
        const earned = safeInt(avail, 0) - safeInt(this.cloudDisk.initial_avail, 0);
        this.log(`云盘任务: 运行后 - 今日已赚: ${today_earn}, 可用: ${avail}, 本次获得: ${earned}`, true);
      }
    }
  },

  async do_ai_interaction_cloud(taskCode, taskName) {
    this.log(`云盘任务: 执行AI通通查询请求...`);
    const payload = {
      "input": "你好",
      "platform": 2,
      "modelId": 0,
      "tag": 21,
      "subTag": 210000,
      "conversationId": "",
      "knowledgeId": "",
      "referFileInfo": []
    };
    const data = await this.cloudRequest('ai_query', payload, false, 'post');
    const body = (data.body !== undefined && data.body !== null) ? data.body : '';
    if (body && (body.includes('"finish":1') || body.includes('success'))) {
      this.log(`云盘任务: ✅ [${taskName}] 互动成功`);
      await this.doPopUp_cloud(taskCode, taskName, false);
      return true;
    }
    this.log(`云盘任务: ❌ [${taskName}] 互动失败`);
    return false;
  },

  async get_cloud_upload_file_path() {
    // Egern 无文件系统：上传一律使用内存生成的 cloudSeedJpegBytes()，此方法保留仅作兼容
    const custom_path = env("UNICOM_CLOUD_UPLOAD_FILE", "").trim();
    if (custom_path) this.log("云盘任务: Egern 环境不支持自定义上传文件，已忽略 UNICOM_CLOUD_UPLOAD_FILE");
    return null;
  },

  async get_cloud_upload_progress_bytes(file_size) {
    if (file_size === undefined) file_size = 0;
    const progress_bytes = Math.max(safeInt(UNICOM_CLOUD_UPLOAD_PROGRESS_BYTES || 0, 0), 1);
    if (file_size && safeInt(file_size, 0) > 0) {
      return Math.min(safeInt(file_size, 0), progress_bytes);
    }
    return progress_bytes;
  },

  async parse_cloud_size_to_bytes(value) {
    const match = String(value).toUpperCase().match(/(\d+(?:\.\d+)?)\s*([KMGT])/);
    if (!match) return 0;
    const unit_power = {'K': 1, 'M': 2, 'G': 3, 'T': 4};
    return Math.trunc(parseFloat(match[1]) * Math.pow(1024, unit_power[match[2]]));
  },

  async get_cloud_upload_times(task, file_size) {
    const progress_list = (((task.taskExtend || {}).taskProgressVOList) || []);
    const targets = [];
    for (const item of progress_list) {
      const size_bytes = await this.parse_cloud_size_to_bytes(item.progressName);
      if (size_bytes > 0) targets.push(size_bytes);
    }
    const finished = Math.max(safeInt(task.finishCount || 0, 0), 0);
    let stage_goal = finished + 1;
    const progress_bytes = await this.get_cloud_upload_progress_bytes(file_size);
    if (targets.length) {
      stage_goal = Math.min(stage_goal, targets.length);
      const final_target = targets[stage_goal - 1];
      const completed_target = finished > 0 ? targets[Math.min(finished, targets.length) - 1] : 0;
      const remaining_bytes = Math.max(final_target - completed_target, 0);
      if (remaining_bytes <= 0) return [0, stage_goal];
      return [Math.max(Math.floor((remaining_bytes + progress_bytes - 1) / progress_bytes), 1), stage_goal];
    }
    const required = Math.max(safeInt(task.needCount || 0, 0), 0);
    if (required > 0) stage_goal = Math.min(stage_goal, required);
    const remaining = Math.max(stage_goal - finished, 0);
    return [remaining, stage_goal];
  },

  async query_cloud_task_list_cloud() {
    if (!(await this.get_userticket_cloud(false))) return [];
    const data = await this.cloudRequest('taskDetail', {}, false, 'post');
    if (!isObj(data)) {
      this.log("云盘任务: taskDetail 返回结构异常，已跳过本轮任务列表");
      return [];
    }
    const res = data.result;
    if (!isObj(res)) {
      const body = String(res).replace(/\r/g, ' ').replace(/\n/g, ' ').trim().slice(0, 120);
      this.log(`云盘任务: taskDetail 返回异常，已跳过本轮任务列表 (status=${data.status}, body=${body || 'None'})`);
      return [];
    }
    const task_detail = ((res.data || {}).taskDetail) || {};
    if (!isObj(task_detail)) {
      this.log("云盘任务: taskDetail 数据结构异常，已跳过本轮任务列表");
      return [];
    }
    return task_detail.taskList || [];
  },

  async query_task_records_cloud(cursor) {
    if (cursor === undefined) cursor = "";
    if (!(await this.get_userticket_cloud(false))) return [];
    const data = await this.cloudRequest('taskRecords', {"cursor": cursor}, false, 'post');
    if (!isObj(data)) {
      this.log("云盘任务: taskRecords 返回结构异常，已跳过积分明细查询");
      return [];
    }
    const res = data.result;
    if (!isObj(res)) {
      const body = String(res).replace(/\r/g, ' ').replace(/\n/g, ' ').trim().slice(0, 120);
      this.log(`云盘任务: taskRecords 返回异常，已跳过积分明细查询 (status=${data.status}, body=${body || 'None'})`);
      return [];
    }
    return res.data || [];
  },

  async init_cloud_task_records_state() {
    const records = await this.query_task_records_cloud("");
    this.cloudDisk.knownTaskRecordIds = new Set(records.filter((item) => item.id).map((item) => String(item.id)));
  },

  async match_new_cloud_task_record(task_name, before_ids) {
    if (before_ids === undefined) before_ids = null;
    const records = await this.query_task_records_cloud("");
    const known_ids = new Set((before_ids !== null && before_ids !== undefined) ? before_ids : (((this.cloudDisk || {}).knownTaskRecordIds) || []));
    let new_record = null;
    for (const item of records) {
      const record_id = String(item.id || '');
      if (!record_id || known_ids.has(record_id)) continue;
      if (item.taskName === task_name && !new_record) new_record = item;
      known_ids.add(record_id);
    }
    this.cloudDisk.knownTaskRecordIds = known_ids;
    return new_record;
  },

  async get_cloud_task_by_code_cloud(task_code) {
    if (!task_code) return null;
    const list = await this.query_cloud_task_list_cloud();
    for (const task of list) {
      if (task.taskCode === task_code) return task;
    }
    return null;
  },

  async finalize_generic_task_cloud(task_code, task_name) {
    const current_task = await this.get_cloud_task_by_code_cloud(task_code);
    if (!isObj(current_task)) return;
    const finish_text = current_task.finishText;
    const finished = safeInt(current_task.finishCount || 0, 0);
    const required = safeInt(current_task.needCount || 0, 0);
    if (finish_text === "待领取") {
      await this.doPopUp_cloud(task_code, task_name, false);
      return;
    }
    if (["已完成", "已领取"].includes(finish_text) || (required > 0 && finished >= required)) {
      const record = await this.match_new_cloud_task_record(task_name);
      if (record) {
        this.log(`云盘任务: ✅ [${task_name}] 完成, 获得积分: ${record.earnScoreDesc}`);
      } else {
        this.log(`云盘任务: ✅ [${task_name}] 已完成`);
      }
    }
  },

  async get_cloud_upload_name_cloud() {
    return env("UNICOM_CLOUD_UPLOAD_FILENAME", "8648").trim() || "8648";
  },

  async doUpload_cloud(taskCode, taskName, prefix, notify) {
    if (prefix === undefined) prefix = "云盘任务";
    if (notify === undefined) notify = true;
    const token = ((this.cloudDisk || {}).userToken) || '';
    const fileData = cloudSeedJpegBytes();
    if (!token || !fileData) return false;
    const file_size = fileData.length;
    const progress_file_size = await this.get_cloud_upload_progress_bytes(file_size);
    const file_name = await this.get_cloud_upload_name_cloud();
    const headers = {
      'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
      'Accept-Encoding': "gzip, deflate, br, zstd",
      'Origin': "https://pan.wo.cn",
      'Referer': "https://pan.wo.cn/",
      'Accept-Language': "zh-CN,zh;q=0.9",
      'Sec-Fetch-Site': "same-site",
      'Sec-Fetch-Mode': "cors",
      'Sec-Fetch-Dest': "empty",
    };
    for (let attempt = 1; attempt < 3; attempt++) {
      const request_time = String(Date.now());
      const _d = new Date();
      const file_info = await this.encrypt_data_cloud(JSON.stringify({
        "spaceType": "0",
        "directoryId": "0",
        "batchNo": _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()),
        "fileName": file_name,
        "fileSize": progress_file_size,
        "fileType": "1",
      }), token);
      try {
        const fields = {
          "uniqueId": `${request_time}_${randomString(6, "abcdefghijklmnopqrstuvwxyz0123456789")}`,
          "accessToken": token,
          "fileName": file_name,
          "psToken": "undefined",
          "fileSize": String(file_size),
          "totalPart": "1",
          "partSize": String(file_size),
          "partIndex": "1",
          "channel": "wocloud",
          "directoryId": "0",
          "fileInfo": file_info,
        };
        const files = [{field: "file", filename: file_name, contentType: "image/jpeg", data: fileData}];
        const res = await this.request_direct("POST", this.cloudDiskUrls['upload2C'], {headers: headers, multipart: {fields: fields, files: files}, timeout: UNICOM_CLOUD_UPLOAD_TIMEOUT});
        let res_json = {};
        try { res_json = await res.json(); } catch (e) {}
        const meta_code = String(((res_json.meta || {}).code) ?? '');
        const code = String(res_json.code ?? '');
        if (res.status === 200 && (!res_json || ['200', '0', '0000'].includes(meta_code) || ['200', '0', '0000'].includes(code))) {
          this.cloudDisk.uploadedFileCount = safeInt(this.cloudDisk.uploadedFileCount || 0, 0) + 1;
          this.log(`${prefix}: [${taskName}] 上传成功`);
          if (taskCode) {
            await sleep(1000);
            await this.doPopUp_cloud(taskCode, taskName, false, notify);
          }
          return true;
        }
        if (attempt < 2 && res.status >= 500) {
          this.log(`${prefix}: [${taskName}] 上传返回 ${res.status}，重建请求重试一次`);
          await sleep(2000);
          continue;
        }
        const body_txt = res_json ? JSON.stringify(res_json) : (await res.text()).slice(0, 200);
        this.log(`${prefix}: ❌ [${taskName}] 上传失败: HTTP ${res.status} ${body_txt}`);
        return false;
      } catch (e) {
        if (attempt < 2) {
          this.log(`${prefix}: [${taskName}] 上传异常，重建请求重试一次: ${e}`);
          await sleep(2000);
          continue;
        }
        this.log(`${prefix}: ❌ [${taskName}] 上传异常: ${e}`);
      }
    }
    return false;
  },

  async doPopUp_cloud(taskCode, taskName, is_changer, notify) {
    if (notify === undefined) notify = true;
    if (!(await this.get_userticket_cloud(is_changer))) return;
    const known_ids = new Set(((this.cloudDisk || {}).knownTaskRecordIds) || []);
    await sleep(5000);
    const data = await this.cloudRequest('doPopUp', {}, is_changer, 'post');
    let res = data.result;
    if (!isObj(res)) res = {};
    const code = (res.meta || {}).code;
    const code2 = res.code;
    if (String(code) === "0000" || String(code) === "0" || String(code2) === "0000" || String(code2) === "0") {
      const record = await this.match_new_cloud_task_record(taskName, known_ids);
      if (record) {
        const score_desc = record.earnScoreDesc || ((res.data || {}).score ?? 0);
        this.log(`云盘任务: ✅ [${taskName}] 完成, 获得积分: ${score_desc}`, notify);
        return;
      }
      const score = ((res.data || {}).score !== undefined && (res.data || {}).score !== null) ? (res.data || {}).score : 0;
      if (!['', '0', '0积分'].includes(String(score))) {
        this.log(`云盘任务: ✅ [${taskName}] 领取到积分: ${score}，但未在积分明细匹配到当前任务`, notify);
      } else {
        this.log(`云盘任务: ✅ [${taskName}] 完成`, notify);
      }
    } else {
      this.log(`云盘任务: ❌ [${taskName}] 领取奖励失败: ${JSON.stringify(res)}`);
    }
  },

  async toFinish_cloud(taskCode, taskName, is_changer) {
    if (!(await this.get_userticket_cloud(is_changer))) return false;
    const data = await this.cloudRequest('toFinish', {'taskCode': taskCode}, is_changer, 'post');
    let res = data.result;
    if (!isObj(res)) res = {};
    if (res.code === "0000") return true;
    return false;
  },

  async dosign_cloud(taskCode, taskName) {
    if (!(await this.get_userticket_cloud(false))) return;
    const data = await this.cloudRequest('dosign', {'taskCode': taskCode}, false, 'post');
    let res = data.result;
    if (!isObj(res)) res = {};
    if (String(res.code).includes("0000") && ((res.data || {}).score)) {
      this.log(`云盘任务: ✅ [${taskName}] 完成, 获得积分: ${res.data.score}`, true);
    } else {
      this.log(`云盘任务: ❌ [${taskName}] 失败: ${JSON.stringify(res)}`);
    }
  },

  async upload_specific_file_quick_cloud() {
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return [false, null];
    const quick_transfer_url = "https://b.smartont.net/openapi/transfer/quickTransfer";
    const headers = {
      "access-token": token,
      "User-Agent": "okhttp-okgo/jeasonlzy LianTongYunPan/5.0.7 (Android 15)",
      "client-Id": "1001000035",
      "app-version": "yp-app/5.0.7",
      "Content-Type": "application/json"
    };
    const body = {
      "batchNo": randomString(32, "0123456789ABCDEF"),
      "directoryId": "0",
      "fileName": "南网在线_4.3.128.apk",
      "fileSize": "223892168",
      "fileType": "5",
      "sha256": "479f9fe75fd218c0c9f9b8038fcfabcc5068094ceaad4bce3443dff304526656",
      "spaceType": "0",
      "autoRename": 1,
    };
    try {
      const res = await this.httpPost(quick_transfer_url, {headers: headers, json: body, timeout: 15});
      if (res.status === 200) {
        const resp_json = await res.json();
        if (isObj(resp_json) && ["0000", "0"].includes(String(((resp_json.meta || {}).code)))) {
          const r2 = resp_json.result || {};
          if ([1, null, "1"].includes(r2.hasFile)) {
            const fid = r2.woCloudId;
            if (fid) return [true, fid];
          }
        }
      }
    } catch (e) {
      this.log(`云盘任务: 秒传请求异常: ${e}`);
    }
    return [false, null];
  },

  async get_taskDetail_cloud() {
    const taskList = await this.query_cloud_task_list_cloud();
    if (taskList.length) {
      const names = taskList.map((t) => t.taskName || '?');
      this.log(`云盘任务: 任务列表(${taskList.length}): ${names.join(', ')}`);
    } else {
      this.log("云盘任务: 任务列表为空");
      return;
    }
    for (const task of taskList) {
      await sleep(500);
      const tName = task.taskName || '';
      const tCode = task.taskCode;
      const finishText = task.finishText;
      const finished = safeInt(task.finishCount, 0);
      const required = safeInt(task.needCount, 0);
      if (finishText === "待领取") {
        this.log(`云盘任务: [${tName}] 待领取`);
        await this.doPopUp_cloud(tCode, tName, false);
        continue;
      }
      if (["已完成", "已领取"].includes(finishText) || task.finishState === true || (required > 0 && finished >= required)) {
        this.log(`云盘任务: ✅ [${tName}] 已完成`);
        continue;
      }
      this.log(`云盘任务: 开始执行 [${tName}] 进度: ${finished}/${required}`);
      if (tName.includes("签到")) {
        await this.toFinish_cloud(tCode, tName, false);
        await this.dosign_cloud(tCode, tName);
      } else if (tName.includes("与AI通通互动")) {
        await this.toFinish_cloud(tCode, tName, false);
        await this.do_ai_interaction_cloud(tCode, tName);
      } else if (tName.includes("微信备份") || tName.includes("通讯录备份")) {
        this.log(`云盘任务: [${tName}] 暂未适配，当前缺少该任务专用协议，先跳过`);
      } else if (tName.includes("当月上传容量满1GB")) {
        await this.toFinish_cloud(tCode, tName, false);
        this.log(`云盘任务: 开始执行1GB秒传任务...`);
        let upload_ok = 0;
        for (let i = 0; i < 5; i++) {
          const [success, fid] = await this.upload_specific_file_quick_cloud();
          if (success && fid) {
            upload_ok += 1;
            this.log(`云盘任务: 第${i + 1}/5次秒传成功`);
            await sleep(randFloat(1, 2) * 1000);
            await this.delete_root_files_cloud([{id: fid, type: '1'}]);
          } else {
            this.log(`云盘任务: 第${i + 1}/5次秒传失败`);
          }
          await sleep(randFloat(2, 4) * 1000);
        }
        const current_task = await this.get_cloud_task_by_code_cloud(tCode);
        const current_finishText = current_task ? current_task.finishText : finishText;
        if (["已完成", "已领取"].includes(current_finishText)) {
          this.log(`云盘任务: ✅ [${tName}] 1GB秒传任务已完成`, true);
        } else {
          this.log(`云盘任务: [${tName}] 秒传结束，当前状态: ${current_finishText}`, true);
        }
      } else {
        await this.run_generic_cloud_task(tCode, tName);
      }
    }
  },

  async query_all_files_cloud(space_type, parent_directory_id, page_num, page_size) {
    if (space_type === undefined) space_type = "0";
    if (parent_directory_id === undefined) parent_directory_id = "0";
    if (page_num === undefined) page_num = 0;
    if (page_size === undefined) page_size = 500;
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return {};
    const res = await this.request_wohome_dispatcher_cloud("QueryAllFiles", {
      "clientId": "1001000035",
      "spaceType": String(space_type),
      "sortRule": "0",
      "parentDirectoryId": String(parent_directory_id),
      "pageNum": String(page_num),
      "pageSize": parseInt(page_size, 10),
    }, 15);
    const rsp = res.RSP || {};
    if (String(rsp.RSP_CODE) !== '0000' || !rsp.DATA) return {};
    try {
      const key_padded = String(token).padEnd(16).slice(0, 16);
      const plain = pkcs7Unpad(aesCbcDecrypt(b64decode(rsp.DATA), utf8Bytes(key_padded), utf8Bytes("wNSOYIB1k1DjY5lA")));
      return JSON.parse(utf8Decode(plain));
    } catch (e) {
      this.log(`云盘任务: 查询根目录文件失败: ${e}`);
      return {};
    }
  },

  async request_wohome_dispatcher_cloud(key, param, timeout, client_id) {
    if (timeout === undefined) timeout = 15;
    if (client_id === undefined) client_id = "1001000035";
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return {};
    const timestamp = String(Date.now());
    const req_seq = String(randInt(10000, 99999));
    const payload = {
      "header": {
        "key": key,
        "resTime": timestamp,
        "reqSeq": req_seq,
        "channel": "wohome",
        "version": "",
        "sign": md5(`${key}${timestamp}${req_seq}wohome`).toUpperCase(),
      },
      "body": {
        "param": await this.encrypt_data_cloud(JSON.stringify(param), token),
        "secret": true,
      },
    };
    const headers = {
      'User-Agent': 'LianTongYunPan/5.1.2 (Android 10)',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Access-Token': token,
      'accesstoken': token,
      'Client-Id': String(client_id),
    };
    try {
      return await (await this.httpPost(this.cloudDiskUrls['ltypDispatcher'], {json: payload, headers: headers, timeout: timeout})).json();
    } catch (e) {
      this.log(`云盘任务: [${key}] 请求失败: ${e}`);
      return {};
    }
  },

  async list_upload_named_files_cloud(max_pages) {
    if (max_pages === undefined) max_pages = 4;
    const upload_name = (await this.get_cloud_upload_name_cloud()).trim();
    if (!upload_name) return [];
    const pattern = new RegExp("^" + cloudEscapeRegExp(upload_name) + "(?:\\(\\d+\\))?(?:\\.[^.]+)?$");
    const matched = [];
    const seen = new Set();
    let page_num = 0;
    while (page_num < max_pages) {
      const data = await this.query_all_files_cloud("0", "0", page_num, 500);
      const page_files = data.files || [];
      if (!page_files.length) break;
      for (const item of page_files) {
        const file_id = item.id;
        const file_name = String(item.name || '').trim();
        if (file_id && !seen.has(file_id) && pattern.test(file_name)) {
          seen.add(file_id);
          matched.push(item);
        }
      }
      if (page_files.length < 500) break;
      page_num += 1;
    }
    return matched;
  },

  async delete_root_files_cloud(items, space_type) {
    if (space_type === undefined) space_type = "0";
    const targets = [];
    for (const item of (items || [])) {
      const item_id = String(item.id || '').trim();
      if (!item_id) continue;
      targets.push([item_id, String(item.type || '1') === '0']);
    }
    let deleted = 0;
    for (let offset = 0; offset < targets.length; offset += 100) {
      const batch = targets.slice(offset, offset + 100);
      const dir_list = batch.filter(([item_id, is_dir]) => is_dir).map(([item_id]) => item_id);
      const file_list = batch.filter(([item_id, is_dir]) => !is_dir).map(([item_id]) => item_id);
      if (!dir_list.length && !file_list.length) continue;
      const res = await this.request_wohome_dispatcher_cloud("DeleteFile", {
        "spaceType": String(space_type),
        "vipLevel": "0",
        "dirList": dir_list,
        "fileList": file_list,
        "clientId": "1001000035",
      }, 20);
      const rsp = res.RSP || {};
      const batch_idx = Math.floor(offset / 100) + 1;
      if (String(rsp.RSP_CODE) === '0000') {
        deleted += batch.length;
        this.log(`云盘任务: 第${batch_idx}批根目录删除成功，共${batch.length}个文件`);
      } else {
        this.log(`云盘任务: 第${batch_idx}批根目录删除失败: ${rsp.RSP_DESC || JSON.stringify(res)}`);
      }
      await sleep(1000);
    }
    return deleted;
  },

  async clean_duplicate_files_cloud() {
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return;
    this.log("云盘任务: 开始清理云盘重复文件");
    const cloud_headers = {
      'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) LianTongYunPan/5.1.0 (iPhone; iOS 16.6)",
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'br;q=1.0, gzip;q=0.9, deflate;q=0.8',
      'Access-Token': token, 'X-YP-Access-Token': token,
      'Client-Id': '1001000035', 'X-YP-Client-Id': '1001000035',
      'App-Version': 'yp-app/5.1.0', 'app-type': 'liantongyunpanapp',
      'Sys-Version': 'iOS/16.6',
    };
    const uploaded_count = safeInt((this.cloudDisk || {}).uploadedFileCount || 0, 0);
    const retry_count = uploaded_count > 0 ? 6 : 1;
    let task_id = "";
    let file_ids = [];
    for (let attempt = 1; attempt < retry_count + 1; attempt++) {
      let res;
      try {
        res = await (await this.httpPost(
          this.cloudDiskUrls['getScanState'],
          {json: {"pathLevelList": [{"levelType": "space", "levelName": "个人云", "busId": "0"}]}, headers: cloud_headers, timeout: 10}
        )).json();
      } catch (e) {
        this.log(`云盘任务: 获取扫描状态失败: ${e}`);
        return;
      }
      if (((res.meta || {}).code) !== '200') {
        this.log("云盘任务: 获取扫描状态失败");
        return;
      }
      task_id = "";
      for (const item of (((res.result || {}).subTaskList) || [])) {
        if (item.taskId) { task_id = item.taskId; break; }
      }
      if (task_id) {
        file_ids = [];
        let page = 1, max_page = 1;
        while (page <= max_page) {
          let page_res;
          try {
            page_res = await (await this.httpPost(
              this.cloudDiskUrls['getCleanData'],
              {json: {"pageNum": page, "taskId": task_id, "type": 3, "pageSize": 50}, headers: cloud_headers, timeout: 10}
            )).json();
          } catch (e) {
            this.log(`云盘任务: 获取第${page}页清理数据失败: ${e}`);
            return;
          }
          if (((page_res.meta || {}).code) !== '200') break;
          max_page = ((page_res.result || {}).maxPageNum) || 1;
          for (const group of (((page_res.result || {}).fileGroupList) || [])) {
            const fl = group.fileList || [];
            for (let fi = 0; fi < fl.length; fi++) {
              const file_item = fl[fi];
              if (fi <= 0 || !file_item.fileId) continue;
              file_ids.push({"fileId": file_item.fileId, "spaceType": file_item.spaceType || '0'});
            }
          }
          page += 1;
        }
      }
      if (file_ids.length) {
        this.log(`云盘任务: 第${attempt}次重复扫描完成，共${file_ids.length}个重复文件`);
        break;
      }
      if (attempt < retry_count) {
        const wait_seconds = Math.min(5 + (attempt - 1) * 2, 12);
        this.log(`云盘任务: 第${attempt}次重复扫描未发现可清理文件，${wait_seconds}秒后重试`);
        await sleep(wait_seconds * 1000);
      }
    }
    if (!file_ids.length) {
      const named_files = uploaded_count > 0 ? await this.list_upload_named_files_cloud() : [];
      if (named_files.length) {
        const preview = named_files.slice(0, 6).map((item) => item.name || '').join("、").replace(/^[、]+|[、]+$/g, "");
        const more = named_files.length > 6 ? "..." : "";
        this.log(`云盘任务: 智能清理未识别到重复项，但根目录检测到${named_files.length}个[${await this.get_cloud_upload_name_cloud()}]系列文件: ${preview}${more}`);
        const deleted = await this.delete_root_files_cloud(named_files);
        this.cloudDisk.uploadedFileCount = 0;
        if (deleted) {
          this.log(`云盘任务: 已通过官方删除接口清理${deleted}个[${await this.get_cloud_upload_name_cloud()}]系列文件`);
        } else {
          this.log(`云盘任务: [${await this.get_cloud_upload_name_cloud()}]系列文件删除失败`);
        }
      } else {
        this.cloudDisk.uploadedFileCount = 0;
        this.log("云盘任务: 无重复文件");
      }
      return;
    }
    for (let offset = 0; offset < file_ids.length; offset += 100) {
      const batch = file_ids.slice(offset, offset + 100);
      const batch_idx = Math.floor(offset / 100) + 1;
      try {
        const batch_res = await (await this.httpPost(
          this.cloudDiskUrls['batchClean'],
          {json: {"fileList": batch, "taskType": 3, "taskId": task_id}, headers: cloud_headers, timeout: 30}
        )).json();
        const code = (batch_res.meta || {}).code;
        this.log(`云盘任务: 第${batch_idx}批清理: ${code === '200' ? '成功' : '失败'}`);
      } catch (e) {
        this.log(`云盘任务: 第${batch_idx}批清理失败: ${e}`);
      }
      await sleep(2000);
    }
    const named_files = uploaded_count > 0 ? await this.list_upload_named_files_cloud() : [];
    if (named_files.length) {
      const preview = named_files.slice(0, 6).map((item) => item.name || '').join("、").replace(/^[、]+|[、]+$/g, "");
      const more = named_files.length > 6 ? "..." : "";
      this.log(`云盘任务: 智能清理后根目录仍检测到${named_files.length}个[${await this.get_cloud_upload_name_cloud()}]系列文件: ${preview}${more}`);
      const deleted = await this.delete_root_files_cloud(named_files);
      if (deleted) {
        this.log(`云盘任务: 已通过官方删除接口补充清理${deleted}个[${await this.get_cloud_upload_name_cloud()}]系列文件`);
      }
    }
    this.cloudDisk.uploadedFileCount = 0;
    this.log("云盘任务: 云盘重复文件清理完成");
  },

  async vote_cloud() {
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return;
    const ypid_list = ((this.cloudDisk || {}).ypid_list) || [];
    if (!ypid_list.length) return;
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) LianTongYunPan/4.0.2 (iPhone; iOS 16.6)",
      'Sec-Fetch-Mode': 'cors',
      'clientId': '1001000165',
      'Origin': 'https://panservice.mail.wo.cn',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Site': 'same-origin',
      'X-YP-Access-Token': token, 'token': token,
      'X-YP-Client-Id': '1001000165',
      'X-SH-Access-Token': '',
      'source-type': 'woapi',
    };
    for (let idx = 0; idx < 3; idx++) {
      try {
        await this.httpPost(
          this.cloudDiskUrls['vote'],
          {json: {"activityId": "MjQ=", "id": randChoice(ypid_list)}, headers: headers, timeout: 10}
        );
        this.log(`云盘任务: 第${idx + 1}次投票`);
      } catch (e) {
        this.log(`云盘任务: 第${idx + 1}次投票失败: ${e}`);
      }
      await sleep(1000);
    }
  },

  async build_cloud_lottery_headers() {
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return {};
    return {
      'User-Agent': "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36/woapp LianTongYunPan/5.1.2 (Android 10)",
      'Accept': 'application/json, text/plain, */*',
      'source-type': 'woapi',
      'Sec-Fetch-Site': 'same-origin',
      'clientId': '1001000165',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'token': token,
      'X-SH-Access-Token': '',
      'Sec-Fetch-Mode': 'cors',
      'X-YP-Access-Token': token,
      'X-YP-Client-Id': '1001000165',
      'X-Requested-With': 'com.chinaunicom.bol.cloudapp',
      'X-YP-GRAY-FLAG': 'undefined',
      'Sec-Fetch-Dest': 'empty',
    };
  },

  async build_cloud_hometown_headers(extra) {
    if (extra === undefined) extra = null;
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return {};
    const headers = {
      'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) LianTongYunPan/5.1.0 (iPhone; iOS 16.6)",
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'source-type': 'woapi',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'clientId': '1001000165',
      'X-YP-Client-Id': '1001000165',
      'X-YP-Access-Token': token,
      'token': token,
      'X-SH-Access-Token': '',
      'X-YP-GRAY-FLAG': 'undefined',
      'requestTime': String(Date.now()),
    };
    if (extra) Object.assign(headers, extra);
    return headers;
  },

  async build_cloud_activity_headers(activity_id) {
    if (activity_id === undefined) activity_id = "";
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return {};
    const headers = {
      'User-Agent': "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36/woapp LianTongYunPan/5.1.2 (Android 10)",
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'source-type': 'woapi',
      'clientId': '1001000165',
      'client-Id': '1001000165',
      'token': token,
      'accessToken': token,
      'access-token': token,
      'X-YP-Access-Token': token,
      'X-YP-Client-Id': '1001000165',
      'X-SH-Access-Token': '',
      'X-Requested-With': 'com.chinaunicom.bol.cloudapp',
      'X-YP-GRAY-FLAG': 'undefined',
      'Origin': 'https://panservice.mail.wo.cn',
    };
    if (activity_id) {
      const point_ticket = ((this.cloudDisk || {}).ticket) || '';
      const mobile = this.account_mobile || this.mobile || '';
      if (activity_id === 'MjU=' && point_ticket && mobile) {
        headers['Referer'] = (
          "https://panservice.mail.wo.cn/h5/activitymobile/fileUploadActive"
          + "?touchpoint=300200030001&type=06"
          + `&ticket=${point_ticket}`
          + "&version=iphone_c%4012.0801"
          + `&timestamp=${Date.now()}`
          + `&desmobile=${mobile}`
          + "&num=0&postage=01addda9786dc7eb5ca0eacd9acd664a"
          + `&activityId=${encodeURIComponent(activity_id)}&clientid=1001000003`
          + `&userNumber=${mobile}`
        );
      } else {
        headers['Referer'] = `https://panservice.mail.wo.cn/h5/activitymobile/fileUploadActive?touchpoint=300300010005&activityId=${encodeURIComponent(activity_id)}&token=${token}`;
      }
    }
    return headers;
  },

  async get_cloud_lottery_draw_count(times_res) {
    const result = times_res.result;
    if (typeof result === "number") return result;
    if (!isObj(result)) return 0;
    let draw_count = result.times;
    if (draw_count === undefined || draw_count === null) {
      for (const key of ['lotteryTimes', 'freeTimes', 'drawTimes', 'count']) {
        if (key in result) { draw_count = result[key]; break; }
      }
    }
    const n = parseInt(draw_count || 0, 10);
    return isNaN(n) ? 0 : n;
  },

  async query_cloud_phone_location_cloud() {
    let province_code = String(((this.cloudDisk || {}).hometownProvinceCode) || '');
    let province_name = String(((this.cloudDisk || {}).hometownProvinceName) || '');
    if (province_code && province_name) return [province_code, province_name];
    const token = ((this.cloudDisk || {}).userToken) || '';
    const mobile = this.account_mobile || this.mobile || '';
    const headers = await this.build_cloud_hometown_headers({"X-SH-Access-Token": ""});
    if (!token || !mobile || !headers || !Object.keys(headers).length) return ["", ""];
    try {
      const res = await (await this.httpPost(
        this.cloudDiskUrls['queryPhoneLocation'],
        {json: {"mobile": await this.encrypt_data_cloud(mobile, "CBWGjFHjZdhTf7h8")}, headers: headers, timeout: 10}
      )).json();
      if (String(((res.meta || {}).code)) === '200') {
        const result = res.result || {};
        province_code = String(result.provinceCode || '');
        province_name = String(result.provinceName || '');
        if (province_code && province_name) {
          this.cloudDisk.hometownProvinceCode = province_code;
          this.cloudDisk.hometownProvinceName = province_name;
          this.log(`家乡打卡 - 归属地: ${province_name}(${province_code})`);
          return [province_code, province_name];
        }
      }
      this.log(`云盘任务: 查询号码归属地失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`云盘任务: 查询号码归属地异常: ${e}`);
    }
    return ["", ""];
  },

  async get_cloud_activity_province() {
    let province_code = String(((this.cloudDisk || {}).hometownProvinceCode) || '');
    let province_name = String(((this.cloudDisk || {}).hometownProvinceName) || '');
    if (province_code && province_name) return [province_code, province_name];
    [province_code, province_name] = await this.query_cloud_phone_location_cloud();
    if (province_code && province_name) return [province_code, province_name];
    if (!this.city_info || !this.city_info.length) await this.get_city_info();
    if (!Array.isArray(this.city_info) || !this.city_info.length) return ["", ""];
    const city = isObj(this.city_info[0]) ? this.city_info[0] : {};
    province_code = String(city.proCode || city.standardProvinceCode || "").replace(/^0+/, "");
    province_name = String(city.proName || city.provinceName || "");
    if (province_code && province_name) {
      this.cloudDisk.hometownProvinceCode = province_code;
      this.cloudDisk.hometownProvinceName = province_name;
    }
    return [province_code, province_name];
  },

  async query_cloud_lottery_times_cloud(activity_id, headers) {
    if (headers === undefined) headers = null;
    if (!activity_id) return null;
    const use_headers = Object.assign({}, headers || await this.build_cloud_lottery_headers());
    if (!Object.keys(use_headers).length) return null;
    use_headers['requestTime'] = String(Date.now());
    const res = await (await this.httpGet(this.cloudDiskUrls['lottery_times'], {params: {"activityId": activity_id}, headers: use_headers, timeout: 10})).json();
    this.cloudDisk.lotteryTimesResult = res;
    return res;
  },

  async ensure_cloud_lottery_activity_open_cloud(activity_id) {
    const headers = await this.build_cloud_activity_headers(activity_id);
    if (!Object.keys(headers).length) return false;
    try {
      const check_headers = Object.assign({}, headers);
      check_headers['requestTime'] = String(Date.now());
      const check_res = await (await this.httpGet(this.cloudDiskUrls['checkActivityStatus'], {params: {"activityId": activity_id}, headers: check_headers, timeout: 10})).json();
      if (String(((check_res.meta || {}).code)) === '200' && String(((check_res.result || {}).state)) === '1') {
        if (activity_id === 'MjU=') this.log("家乡打卡 - 开启结果：开启成功");
        return true;
      }
    } catch (e) {
      this.log(`云盘任务: 查询抽奖活动开启状态失败: ${e}`);
    }
    const [province_code, province_name] = await this.get_cloud_activity_province();
    if (!province_code || !province_name) {
      this.log("云盘任务: 开启抽奖活动失败，缺少省份信息");
      return false;
    }
    try {
      const open_headers = Object.assign({}, headers);
      open_headers['requestTime'] = String(Date.now());
      const res = await (await this.httpPost(
        this.cloudDiskUrls['openActivity'],
        {json: {"activityId": activity_id, "provinceCode": province_code, "provinceName": province_name}, headers: open_headers, timeout: 10}
      )).json();
      if (String(((res.meta || {}).code)) === '200' && String(((res.result || {}).state)) === '1') {
        if (activity_id === 'MjU=') {
          this.log("家乡打卡 - 开启结果：开启成功");
        } else {
          this.log(`云盘任务: 抽奖活动[${activity_id}] 已开启`);
        }
        return true;
      }
      if (activity_id === 'MjU=') {
        const message = res.msg || ((res.meta || {}).message) || '开启失败';
        this.log(`家乡打卡 - 开启结果：${message}`);
      } else {
        this.log(`云盘任务: 开启抽奖活动失败: ${JSON.stringify(res)}`);
      }
    } catch (e) {
      this.log(`云盘任务: 开启抽奖活动异常: ${e}`);
    }
    return false;
  },

  async query_cloud_lottery_record_cloud(activity_id) {
    if (!activity_id) return null;
    const headers = activity_id === 'MjU=' ? await this.build_cloud_hometown_headers() : await this.build_cloud_lottery_headers();
    if (!Object.keys(headers).length) return null;
    try {
      const response = await this.httpGet(
        `https://panservice.mail.wo.cn/activity/lottery/recordList?activityId=${encodeURIComponent(activity_id)}`,
        {headers: headers, timeout: 10}
      );
      const result = response.status === 200 ? await response.json() : null;
      if (!isObj(result)) return null;
      if (String(((result.meta || {}).code)) === '200') {
        const record_list = result.result || [];
        const prize = record_list.length ? (record_list[0].prizeName ?? '暂无抽奖记录') : '暂无抽奖记录';
        if (activity_id === 'MjU=') this.log(`家乡打卡 - 上次抽奖：${prize}`);
        return prize;
      }
    } catch (e) {
      this.log(`云盘任务: 查询抽奖记录异常: ${e}`);
    }
    return null;
  },

  async do_activity_upload_cloud(activity_id) {
    const token = ((this.cloudDisk || {}).userToken) || '';
    const fileData = cloudSeedJpegBytes();
    if (!token || !fileData) return false;
    const file_size = fileData.length;
    const file_name = await this.get_cloud_upload_name_cloud();
    const _d = new Date();
    const file_info = await this.encrypt_data_cloud(JSON.stringify({
      "batchNo": _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()) + pad2(_d.getHours()) + pad2(_d.getMinutes()) + pad2(_d.getSeconds()),
      "fileName": file_name,
      "fileSize": file_size,
      "fileType": 1,
      "directoryId": "0",
      "spaceType": "0",
    }), token);
    const headers = {
      'User-Agent': "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36/woapp LianTongYunPan/5.1.2 (Android 10)",
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://panservice.mail.wo.cn',
      'Referer': `https://panservice.mail.wo.cn/h5/activitymobile/fileUploadActive?touchpoint=300300010005&activityId=${encodeURIComponent(activity_id)}&token=${token}`,
      'X-Requested-With': 'com.chinaunicom.bol.cloudapp',
      'accessToken': token,
      'access-token': token,
      'client_id': '1001000165',
      'X-YP-GRAY-FLAG': 'undefined',
      'requestTime': String(Date.now()),
    };
    try {
      if (activity_id === 'MjU=') this.log("开始家乡打卡文件上传...");
      const fields = {
        "uniqueId": `${Date.now()}_${Math.random()}`,
        "accessToken": token,
        "psToken": "undefined",
        "totalPart": "1",
        "partSize": String(file_size),
        "partIndex": "1",
        "channel": "wocloud",
        "directoryId": "0",
        "fileName": file_name,
        "fileSize": String(file_size),
        "fileInfo": file_info,
      };
      const files = [{field: "file", filename: file_name, contentType: "image/jpeg", data: fileData}];
      const res = await this.request_direct("POST", this.cloudDiskUrls['activityUpload2C'], {headers: headers, multipart: {fields: fields, files: files}, timeout: UNICOM_CLOUD_UPLOAD_TIMEOUT});
      let res_json = {};
      try { res_json = await res.json(); } catch (e) {}
      const code = String(res_json.code ?? '');
      const meta_code = String(((res_json.meta || {}).code) ?? '');
      if (res.status === 200 && (['200', '0', '0000'].includes(code) || ['200', '0', '0000'].includes(meta_code))) {
        this.cloudDisk.uploadedFileCount = safeInt(this.cloudDisk.uploadedFileCount || 0, 0) + 1;
        if (activity_id === 'MjU=') {
          this.log("家乡打卡 - 上传成功");
        } else {
          this.log("云盘任务: 活动上传成功，正在刷新抽奖次数...");
        }
        return true;
      }
      if (activity_id === 'MjU=') {
        this.log(`家乡打卡 - 上传失败: HTTP ${res.status}`);
      } else {
        const body_txt = res_json ? JSON.stringify(res_json) : (await res.text()).slice(0, 200);
        this.log(`云盘任务: 活动上传失败: HTTP ${res.status} ${body_txt}`);
      }
    } catch (e) {
      if (activity_id === 'MjU=') {
        this.log(`家乡打卡 - 上传异常: ${e}`);
      } else {
        this.log(`云盘任务: 活动上传异常: ${e}`);
      }
    }
    return false;
  },

  async wait_cloud_lottery_times_cloud(activity_id, wait_seconds) {
    if (wait_seconds === undefined) wait_seconds = 8;
    const headers = await this.build_cloud_lottery_headers();
    if (!Object.keys(headers).length) return null;
    for (let i = 0; i < wait_seconds; i++) {
      await sleep(1000);
      try {
        const res = await this.query_cloud_lottery_times_cloud(activity_id, headers);
        if (isObj(res) && String(((res.meta || {}).code)) === '200' && await this.get_cloud_lottery_draw_count(res) > 0) {
          return res;
        }
      } catch (e) {}
    }
    return this.cloudDisk.lotteryTimesResult ?? null;
  },

  async get_cloud_lottery_activity_id_cloud() {
    if ((this.cloudDisk || {}).lotteryActivityId) return this.cloudDisk.lotteryActivityId;
    const headers = await this.build_cloud_lottery_headers();
    if (!Object.keys(headers).length) return null;
    const custom_id = env("UNICOM_CLOUD_LOTTERY_ACTIVITY_ID", "").trim();
    const activity_id = custom_id || "MjU=";
    try {
      const check_headers = Object.assign({}, headers);
      check_headers['requestTime'] = String(Date.now());
      const res = await (await this.httpGet(this.cloudDiskUrls['lottery_times'], {params: {"activityId": activity_id}, headers: check_headers, timeout: 10})).json();
      const meta_code = String(((res.meta || {}).code));
      if (['200', '90003603'].includes(meta_code)) {
        this.cloudDisk.lotteryActivityId = activity_id;
        this.cloudDisk.lotteryTimesResult = res;
        this.log("云盘任务: 开始执行抽奖活动");
        return activity_id;
      }
      this.log(`云盘任务: 抽奖活动[${activity_id}] 无效: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`云盘任务: 查询抽奖活动[${activity_id}]失败: ${e}`);
    }
    return null;
  },

  async draw_lottery_cloud() {
    const headers = await this.build_cloud_lottery_headers();
    if (!Object.keys(headers).length) return;
    const activity_id = await this.get_cloud_lottery_activity_id_cloud();
    if (!activity_id) {
      this.log("云盘任务: 未找到有效抽奖活动");
      return;
    }
    try {
      let times_res = (this.cloudDisk || {}).lotteryTimesResult ?? null;
      if (!isObj(times_res)) times_res = await this.query_cloud_lottery_times_cloud(activity_id, headers);
      let times_code = String(((times_res.meta || {}).code));
      let draw_count = times_code === '200' ? await this.get_cloud_lottery_draw_count(times_res) : 0;
      if (times_code === '90003603' || draw_count <= 0) {
        if (await this.ensure_cloud_lottery_activity_open_cloud(activity_id) && await this.do_activity_upload_cloud(activity_id)) {
          const refreshed = await this.wait_cloud_lottery_times_cloud(activity_id);
          if (isObj(refreshed)) {
            times_res = refreshed;
            times_code = String(((times_res.meta || {}).code));
            draw_count = times_code === '200' ? await this.get_cloud_lottery_draw_count(times_res) : 0;
          }
        }
      }
      if (activity_id === 'MjU=') await this.query_cloud_lottery_record_cloud(activity_id);
      if (times_code === '90003603') {
        if (activity_id === 'MjU=') {
          this.log("家乡打卡 - 抽奖失败：没有抽奖机会");
        } else {
          this.log(`云盘任务: 抽奖活动[${activity_id}] 活动上传后仍未获得抽奖次数`);
        }
        return;
      }
      if (times_code !== '200') {
        this.log(`云盘任务: 查询抽奖次数失败: ${JSON.stringify(times_res)}`);
        return;
      }
      if (draw_count <= 0) {
        if (activity_id === 'MjU=') {
          this.log("家乡打卡 - 抽奖失败：没有抽奖机会");
        } else {
          this.log(`云盘任务: 抽奖活动[${activity_id}] 当前无抽奖次数`);
        }
        return;
      }
      for (let i = 0; i < draw_count; i++) {
        const draw_headers = Object.assign({}, headers);
        draw_headers['requestTime'] = String(Date.now());
        const res = await (await this.httpPost(this.cloudDiskUrls['lottery'], {json: {"activityId": activity_id}, headers: draw_headers, timeout: 10})).json();
        if (String(((res.meta || {}).code)) === '92000017') {
          this.log("云盘任务: 转盘已抽奖");
          return;
        }
        if ('result' in res) {
          if (activity_id === 'MjU=') {
            this.log(`家乡打卡 - 抽奖结果：${(res.result || {}).prizeName || ''}`, true);
          } else {
            this.log(`云盘任务: 转盘获得: ${(res.result || {}).prizeName || ''}`, true);
          }
          continue;
        }
        this.log(`云盘任务: 抽奖无结果: ${JSON.stringify(res)}`);
      }
    } catch (e) {
      this.log(`云盘任务: 抽奖失败: ${e}`);
    }
  },

  async get_secret_key_cloud() {
    if ((this.cloudDisk || {}).secretKey) return this.cloudDisk.secretKey;
    if (!((this.cloudDisk || {}).userticket) || !((this.cloudDisk || {}).jeaId)) return null;
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'User-Agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) LianTongYunPan/4.0.2 (iPhone; iOS 16.6)",
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Origin': 'https://m.jf.10010.com',
      'Host': 'm.jf.10010.com',
      'clienttype': 'yunpan_iOS',
      'partnersid': '1649',
      'ticket': this.cloudDisk.userticket,
      'Cookie': `_jea_id=${this.cloudDisk.jeaId};`,
    };
    try {
      const res = await (await this.httpGet(this.cloudDiskUrls['secretKey'], {headers: headers, timeout: 10})).json();
      const secret = (res.data || {}).secretKey;
      if (res.code === '0000' && secret) {
        this.cloudDisk.secretKey = utf8Bytes(secret);
        this.log("云盘任务: secretKey 获取成功");
        return this.cloudDisk.secretKey;
      }
      this.log(`云盘任务: getSecretKey 失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`云盘任务: getSecretKey 异常: ${e}`);
    }
    return null;
  },

  async build_signature_headers_cloud() {
    const secret_key = await this.get_secret_key_cloud();
    if (!secret_key) return {};
    const request_ts = String(Date.now());
    const nonce = randomString(8, "0123456789abcdefghijklmnopqrstuvwxyz");
    const signature = hmacSha256(secret_key, `${nonce}${request_ts}`);
    return {
      'x-request-timestamp': request_ts,
      'x-request-nonce': nonce,
      'x-request-signature': signature,
    };
  },

  async run_generic_cloud_task(task_code, task_name) {
    this.log(`云盘任务: [${task_name}] 尝试通用完成接口`);
    await this.toFinish_cloud(task_code, task_name, false);
    await sleep(2000);
    await this.handle_unknown_task_cloud(task_code, task_name);
    await sleep(3000);
    await this.finalize_generic_task_cloud(task_code, task_name);
  },

  async handle_unknown_task_cloud(task_code, task_name) {
    if (task_name === undefined) task_name = "";
    const token = ((this.cloudDisk || {}).userToken) || '';
    if (!token) return false;
    const headers = {
      'User-Agent': 'LianTongYunPan/5.0.4 (iOS 16.3)',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'br;q=1.0, gzip;q=0.9, deflate;q=0.8',
      'Access-Token': token, 'X-YP-Access-Token': token,
      'Client-Id': '1001000035', 'X-YP-Client-Id': '1001000035',
      'App-Version': 'yp-app/5.0.4', 'app-type': 'liantongyunpanapp',
      'Sys-Version': 'iOS/16.3',
      'Accept-Language': 'zh-Hans-CN;q=1.0',
    };
    const prefix = task_name ? `云盘任务: [${task_name}]` : "云盘任务: 未知任务";
    try {
      const res = await (await this.httpPost(
        this.cloudDiskUrls['taskFinish'],
        {json: {"taskCode": task_code, "taskStatus": {"isBackUp": "1"}}, headers: headers, timeout: 10}
      )).json();
      const meta_code = String(((res.meta || {}).code));
      if (meta_code === '90003600') {
        this.log(`${prefix} 处理完成`);
        return true;
      }
      if (['200', '0'].includes(meta_code) || ['200', '0', '0000'].includes(String(res.code))) {
        this.log(`${prefix} 处理完成: ${res.msg || (((res.meta || {}).message) || '成功')}`);
        return true;
      }
      this.log(`${prefix} 处理失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`云盘任务: [${task_name || task_code}] 处理失败: ${e}`);
    }
    return false;
  },

});
// Part 06: 联通云盘入口 + 安全管家
// 对应 Python 19705.py: ltyp_task (3338) + sec_* 方法 + securityButlerTask (3338-4278)
// cross_view_security_share_keys (6918) 为模块级函数，不属本分块
Object.assign(UserService.prototype, {

  async ltyp_task(is_query_only = false) {
    this.log("==== 联通云盘任务 ====");
    await this.init_cloud_urls();
    this.cloudDisk = {};
    if (!this.ecs_token) {
      this.log("云盘任务: 缺少 ecs_token，跳过。");
      return;
    }
    const ticket = await this.getTicketByNative_cloud();
    if (!ticket) return;
    if (!this.city_info || !this.city_info.length) {
      await this.get_city_info();
    }
    const token = await this.get_ltypDispatcher_cloud(ticket);
    if (!token) return;
    await sleep(500);
    await this.get_userInfo_cloud();
    await this.init_cloud_task_records_state();
    if (is_query_only) {
      this.log("云盘任务: [查询模式] 跳过任务执行...");
      await this.get_userInfo_cloud();
      return;
    }
    await sleep(500);
    await this.get_secret_key_cloud();
    await this.get_taskDetail_cloud();
    await sleep(500);
    await this.get_userInfo_cloud();
    await sleep(2000);
    await this.draw_lottery_cloud();
    await sleep(2000);
    await this.clean_duplicate_files_cloud();
  },

  async getTicketByNative_sec() {
    for (let attempt = 1; attempt < 4; attempt++) {
      try {
        const url = `https://m.client.10010.com/edop_ng/getTicketByNative?token=${this.ecs_token}&appId=edop_unicom_3a6cc75a`;
        const city_code = "";
        const cookie_str = `PvSessionId=${fmtYmdHms(new Date()).slice(0, 14)}${this.unicomTokenId};c_mobile=${this.account_mobile}; c_version=iphone_c@11.0800; city=036|${city_code}|90063345|-99;devicedId=${this.unicomTokenId}; ecs_token=${this.ecs_token};t3_token=`;
        const headers = {
          "Cookie": cookie_str,
          "Accept": "*/*",
          "Connection": "keep-alive",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ChinaUnicom4.x/12.3.1 (com.chinaunicom.mobilebusiness; build:77; iOS 16.6.0) Alamofire/4.7.3 unicom{version:iphone_c@12.0301}",
          "Accept-Language": "zh-Hans-CN;q=1.0",
        };
        const res = await this.httpGet(url, {headers: headers, timeout: 10});
        if (res.status !== 200) {
          this.log(`安全管家: getTicketByNative_sec http请求失败 ${res.status}`);
          return;
        }
        let result;
        try {
          result = await res.json();
        } catch (je) {
          this.log(`安全管家: getTicketByNative_sec json解析失败: ${(await res.text()).slice(0, 100)}`);
          return;
        }
        this.sec_ticket1 = result.ticket;
        if (this.sec_ticket1) {
          return;
        } else {
          this.log(`安全管家: getTicketByNative_sec 失败 - ${JSON.stringify(result)}`);
        }
      } catch (e) {
        const err_msg = String(e && e.message ? e.message : e);
        if (attempt < 3 && env("UNICOM_PROXY_API") && (err_msg.includes("Max retries exceeded") || err_msg.toLowerCase().includes("timed out") || err_msg.toLowerCase().includes("connection") || err_msg.includes("SOCKS"))) {
          this.log(`安全管家: getTicketByNative_sec 第${attempt}次异常触发故障转移: ${err_msg}`);
          this.failover_proxy();
          continue;
        }
        this.log(`安全管家: getTicketByNative_sec 第${attempt}次重试 - 异常: ${e && e.message ? e.message : e}`);
        await sleep(2000);
      }
    }
  },

  async getAuthToken_sec() {
    if (!this.sec_ticket1) {
      this.log("安全管家 getAuthToken_sec 缺少 ticket1，跳过");
      return;
    }
    try {
      const url = "https://uca.wo116114.com/api/v1/auth/ticket?product_line=uasp&entry_point=h5&entry_point_id=edop_unicom_3a6cc75a";
      const headers = {
        "User-Agent": "ChinaUnicom4.x/12.3.1 (com.chinaunicom.mobilebusiness; build:77; iOS 16.6.0) Alamofire/4.7.3 unicom{version:iphone_c@12.0301}",
        "Content-Type": "application/json",
        "clientType": "uasp_unicom_applet",
      };
      const data = {"productId": "", "type": 1, "ticket": this.sec_ticket1};
      const res = await (await this.httpPost(url, {json: data, headers: headers})).json();
      if (res.data) {
        this.sec_token = res.data.access_token;
      } else {
        this.log(`安全管家: getAuthToken_sec 失败 - ${JSON.stringify(res)}`);
      }
    } catch (e) {
      this.log(`安全管家: getAuthToken_sec 异常: ${e && e.message ? e.message : e}`);
    }
  },

  async getTicketForJF_sec() {
    if (!this.sec_token) {
      this.log("安全管家 getTicketForJF_sec 缺少 token，跳过");
      return;
    }
    try {
      const url1 = "https://uca.wo116114.com/api/v1/auth/getTicket?product_line=uasp&entry_point=h5&entry_point_id=edop_unicom_3a6cc75a";
      const headers1 = {
        "User-Agent": "ChinaUnicom4.x/12.3.1 (com.chinaunicom.mobilebusiness; build:77; iOS 16.6.0) Alamofire/4.7.3 unicom{version:iphone_c@12.0301}",
        "Content-Type": "application/json",
        "auth-sa-token": this.sec_token,
        "clientType": "uasp_unicom_applet",
      };
      const data1 = {"productId": "91311616", "phone": this.account_mobile};
      const res1 = await (await this.httpPost(url1, {json: data1, headers: headers1})).json();
      if (res1.data) {
        this.sec_ticket = res1.data.ticket;
      } else {
        this.log("安全管家获取积分票据失败");
        return;
      }
      const url2 = "https://m.jf.10010.com/jf-external-application/page/query";
      const headers2 = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301};ltst;OSVersion/16.6",
        "partnersid": "1702",
        "ticket": decodeURIComponent(this.sec_ticket),
        "clienttype": "uasp_unicom_applet",
      };
      if (this.sec_jeaId !== undefined) {
        headers2["Cookie"] = `_jea_id=${this.sec_jeaId}`;
      }
      const reqBody = {"activityId": "s747395186896173056", "partnersId": "1702"};
      await this.httpPost(url2, {json: reqBody, headers: headers2});
      const res2 = await this.httpPost(url2, {json: reqBody, headers: headers2});
      const jar = this.session.getCookieDict();
      for (const name of Object.keys(jar)) {
        if (name === "_jea_id") {
          this.sec_jeaId = jar[name];
        }
      }
      const setCookie = res2.headers.get("Set-Cookie");
      if (setCookie) {
        const match = setCookie.match(/_jea_id=([^;]+)/);
        if (match) {
          this.sec_jeaId = match[1];
        }
      }
    } catch (e) {
      this.log(`安全管家: getTicketForJF_sec 异常: ${e && e.message ? e.message : e}`);
    }
  },

  async get_secret_key_sec(silent = false) {
    if (this.sec_secretKey) {
      return this.sec_secretKey;
    }
    if (!this.sec_ticket) {
      return null;
    }
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301};ltst;OSVersion/16.6",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Origin": "https://m.jf.10010.com",
      "Host": "m.jf.10010.com",
      "clienttype": "uasp_unicom_applet",
      "partnersid": "1702",
      "ticket": decodeURIComponent(this.sec_ticket),
    };
    if (this.sec_jeaId !== undefined && this.sec_jeaId) {
      headers["Cookie"] = `_jea_id=${this.sec_jeaId};`;
    }
    try {
      const res = await (await this.httpGet("https://m.jf.10010.com/jf-external-application/jftask/getSecretKey", {headers: headers, timeout: 10})).json();
      const secret = (res.data || {}).secretKey;
      if (res.code === "0000" && secret) {
        this.sec_secretKey = utf8Bytes(secret);
        if (!silent) {
          this.log("secretKey 获取成功");
        }
        return this.sec_secretKey;
      }
      this.log(`安全管家: getSecretKey 失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`安全管家: getSecretKey 异常: ${e && e.message ? e.message : e}`);
    }
    return null;
  },

  async build_signature_headers_sec() {
    const secret_key = await this.get_secret_key_sec();
    if (!secret_key) {
      return {};
    }
    const request_ts = String(new Date().getTime());
    const nonce = randomString(8, "0123456789abcdefghijklmnopqrstuvwxyz");
    const signature = hmacSha256(secret_key, nonce + request_ts);
    return {
      "x-request-timestamp": request_ts,
      "x-request-nonce": nonce,
      "x-request-signature": signature,
    };
  },

  async sec_uca_post(url_path, body) {
    try {
      const headers = {
        "clientType": "uasp_unicom_applet",
        "auth-sa-token": this.sec_token,
        "Content-Type": "application/json",
        "Accept": "*",
        "User-Agent": "ChinaUnicom4.x/12.3.1 (com.chinaunicom.mobilebusiness; build:77; iOS 16.6.0) Alamofire/4.7.3 unicom{version:iphone_c@12.0301}",
      };
      return await (await this.httpPost(url_path, {json: body, headers: headers, timeout: 10})).json();
    } catch (e) {
      this.log(`安全管家: uca_post 异常: ${e && e.message ? e.message : e}`);
      return null;
    }
  },

  async addToBlacklist_sec() {
    const url = "https://uca.wo116114.com/sjgj/woAssistant/umm/configs/v1/config?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    await this.sec_uca_post(url, {
      "productId": "91242950", "operationType": 1, "type": 1,
      "contents": [{"checked": true, "configTime": null, "nickname": null, "contentTag": "疑似诈骗", "content": "13088330789"}],
    });
    await sleep(2000);
    await this.sec_uca_post(url, {
      "productId": "91242950", "blacklistSource": 0, "type": 1, "operationType": 0,
      "contents": [{"contentTag": "疑似诈骗", "content": "13088330789"}],
    });
  },

  async markPhoneNumber_sec() {
    const url = "https://uca.wo116114.com/sjgj/unicomAssistant/uasp/configs/v1/addressBook/saveTagPhone?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    await this.sec_uca_post(url, {"productId": "91311616", "status": 0, "tagIds": [26], "tagPhoneNo": "13088330789"});
  },

  async syncAddressBook_sec() {
    const url = "https://uca.wo116114.com/sjgj/unicomAssistant/uasp/configs/v1/addressBookBatchConfig?product_line=uasp&entry_point=h5&entry_point_id=edop_unicom_3a6cc75a";
    await this.sec_uca_post(url, {
      "opType": "1", "productId": "91311616",
      "addressBookDTOList": [{"addressBookName": "可乐", "addressBookPhoneNo": "13105750575"}],
    });
  },

  async setInterceptionRules_sec() {
    const url = "https://uca.wo116114.com/sjgj/woAssistant/umm/configs/v1/config?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    await this.sec_uca_post(url, {
      "productId": "91311616", "type": 3, "operationType": 0,
      "contents": [{"icon": "alerting", "content": "1", "contentName": "响一声", "contentTag": "8", "name": "rings-once"}],
    });
    await sleep(2000);
    await this.sec_uca_post(url, {
      "productId": "91311616", "type": 3, "operationType": 0,
      "contents": [{"icon": "alerting", "content": "0", "contentName": "响一声", "contentTag": "8", "name": "rings-once"}],
    });
  },

  async viewWeeklyReport_sec() {
    const base = "https://uca.wo116114.com/sjgj/unicomAssistant/uasp";
    const body = {"productId": "91311616"};
    await this.sec_uca_post(`${base}/configs/v1/weeklySwitchStatus?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6`, body);
    await this.sec_uca_post(`${base}/report/v1/queryKeyData?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6`, body);
    await this.sec_uca_post(`${base}/report/v1/weeklySummary?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6`, body);
  },

  async zhushou_sec() {
    try {
      const headers = {
        "auth-sa-token": this.sec_token, "token": this.sec_token,
        "Content-Type": "application/json", "Accept": "*",
        "User-Agent": "ChinaUnicom4.x/12.3.1 (com.chinaunicom.mobilebusiness; build:77; iOS 16.6.0) Alamofire/4.7.3 unicom{version:iphone_c@12.0301}",
      };
      await this.httpPost("https://ims.wo116114.com/api/AiAssistant/autoReply",
        {json: {"history": [], "message": "1", "promptId": 10000}, headers: headers, timeout: 10});
    } catch (e) {
      this.log(`安全管家: 智能助手异常: ${e && e.message ? e.message : e}`);
    }
  },

  async daijie_sec() {
    try {
      const headers = {
        "auth-sa-token": this.sec_token, "token": this.sec_token, "Authorization": this.sec_token,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)",
      };
      await this.httpPost("https://ims.wo116114.com/api/Assistant/assis_save", {json: {
        "page_type": 1, "old_ainumber": "XF0", "level": 3, "dialog": "0",
        "opertype": 1, "videoimage": "", "speechtype": "06", "ainumber": "BD1",
      }, headers: headers, timeout: 10});
    } catch (e) {
      this.log(`安全管家: 代接助理异常: ${e && e.message ? e.message : e}`);
    }
  },

  async anquanfen_sec() {
    const url = "https://uca.wo116114.com/sjgj/woAssistant/umm/configs/v1/config?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    const score_url = "https://uca.wo116114.com/sjgj/unicomAssistant/uasp/report/v1/queryScore?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    const off_body = {"productId": "91351080", "type": 3, "operationType": 0,
      "contents": [{"icon": "phone-fraud", "content": "1", "contentName": "疑似诈骗", "contentTag": "0", "name": "fraud"}]};
    const on_body = {"productId": "91351080", "type": 3, "operationType": 0,
      "contents": [{"contentTag": "0", "content": "0"}]};
    await this.sec_uca_post(url, off_body);
    await sleep(2000);
    await this.sec_uca_post(score_url, {"productId": "91311616"});
    await sleep(2000);
    await this.sec_uca_post(url, on_body);
    await sleep(2000);
    await this.sec_uca_post(score_url, {"productId": "91311616"});
    await sleep(2000);
    await this.sec_uca_post(url, off_body);
  },

  async haoduan_sec() {
    const url = "https://uca.wo116114.com/sjgj/woAssistant/umm/configs/v1/config?product_line=uasp&entry_point=h5&entry_point_id=wxdefbc1986dc757a6";
    const item_off = {"checked": true, "content": "1", "contentName": "拦截400开头的10位特服号码", "contentTag": "1"};
    const item_on = {"checked": false, "content": "0", "contentName": "拦截400开头的10位特服号码", "contentTag": "1"};
    const base = {"productId": "91351080", "type": 7, "operationType": 0};
    await this.sec_uca_post(url, Object.assign({}, base, {"contents": [item_off]}));
    await sleep(2000);
    await this.sec_uca_post(url, Object.assign({}, base, {"contents": [item_on]}));
    await sleep(2000);
    await this.sec_uca_post(url, Object.assign({}, base, {"contents": [item_off]}));
  },

  async ojbk_sec(taskCode) {
    try {
      const url = "https://m.jf.10010.com/jf-external-application/jftask/taskFinish";
      const headers = await this._sec_jf_headers();
      await this.httpPost(url, {json: {"taskCode": taskCode}, headers: headers, timeout: 10});
    } catch (e) {
      this.log(`安全管家: 活动浏览异常: ${e && e.message ? e.message : e}`);
    }
  },

  async sec_wo_ai_headers(use_mobile = false, override_token = null) {
    const ua_pc = (
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 " +
      "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI " +
      "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) " +
      "UnifiedPCWindowsWechat(0xf2541818) XWEB/19201 miniProgram/wx1e83eef922822ee0"
    );
    const ua_mobile = (
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
      "MicroMessenger/8.0.69(0x1800452f) NetType/WIFI Language/zh_CN " +
      "miniProgram/wx1e83eef922822ee0"
    );
    return {
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Origin": "https://ai.wo.cn",
      "Authorization": override_token || this.sec_token,
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": use_mobile ? ua_mobile : ua_pc,
    };
  },

  async sec_get_knowledge_id() {
    try {
      const headers = await this.sec_wo_ai_headers();
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/knowledge/getKnowledgeList",
        {headers: headers, data: JSON.stringify({"appType": 1}), timeout: 10}
      );
      const res = await response.json();
      if (res.code === 0 && res.data) {
        return res.data[0].id;
      }
      this.log(`获取知识库ID失败：${res.msg || JSON.stringify(res)}`);
    } catch (e) {
      this.log(`获取知识库ID异常：${e && e.message ? e.message : e}`);
    }
    return "";
  },

  async upload_knowledge_file_sec() {
    try {
      const kid = await this.sec_get_knowledge_id();
      if (!kid) {
        return false;
      }
      const all_headers = await this.sec_wo_ai_headers();
      const upload_headers = {};
      for (const k of Object.keys(all_headers)) {
        if (k.toLowerCase() !== "content-type") {
          upload_headers[k] = all_headers[k];
        }
      }
      const data = {
        "knowledgeId": kid,
        "fileName": "task_upload.txt",
        "fileType": "text/plain",
        "fileSize": "1",
        "currentPartSize": "1",
        "currentIndex": "1",
        "totalPart": "1",
        "spaceType": "0",
      };
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/knowledge/uploadLocalFileToKnowledge",
        {headers: upload_headers,
         multipart: {fields: data, files: [{field: "file", filename: "task_upload.txt", contentType: "text/plain", data: utf8Bytes(" ")}]},
         timeout: 15}
      );
      const res = await response.json();
      if (res.code === 0) {
        this.log("上传知识库文件成功");
        return true;
      }
      this.log(`上传知识库文件失败：${res.msg || JSON.stringify(res)}`);
      return false;
    } catch (e) {
      this.log(`安全管家: 上传知识库文件异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async sec_get_chat_list() {
    try {
      const headers = await this.sec_wo_ai_headers();
      headers["Referer"] = "https://ai.wo.cn/wxMini";
      const response = await this.httpGet(
        "https://ai.wo.cn/web-tongtong/historyChat/list",
        {headers: headers, timeout: 10}
      );
      const res = await response.json();
      if (res.code === 0) {
        return ((res.data || {}).content || []);
      }
      if (res.msg) {
        this.log(`获取AI对话历史失败：${res.msg}`);
      }
    } catch (e) {
      this.log(`获取AI对话历史异常：${e && e.message ? e.message : e}`);
    }
    return [];
  },

  async sec_send_ai_chat() {
    try {
      const session_id = "mmru" + randomString(10, "0123456789");
      const request_id = "rqid_mmru" + randomString(10, "0123456789");
      const headers = await this.sec_wo_ai_headers(true);
      headers["Accept"] = "text/event-stream";
      headers["Referer"] = "https://ai.wo.cn/wxMini/psychologicalApp/chat?id=1&type=ruole";
      const payload = {
        "modelKey": "87e622d9e488",
        "message": "帮我推荐1个必吃饭店",
        "deepThink": false,
        "webSearch": false,
        "attachments": [],
        "imgSize": 0,
        "sessionId": session_id,
        "requestId": request_id,
        "promptKey": "",
        "knowledgeId": "",
        "ragSearch": false,
        "moduleType": 12,
      };
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/chat/chatReplyV2",
        {headers: headers, data: JSON.stringify(payload), timeout: 60}
      );
      // Egern 会话已完整读取响应体（对应 Python 的 stream + iter_lines 消费）
      if (response.status < 400) {
        this.log("已发送AI对话");
        return true;
      }
      this.log(`发送AI对话失败：HTTP ${response.status}`);
    } catch (e) {
      this.log(`发送AI对话异常：${e && e.message ? e.message : e}`);
    }
    return false;
  },

  async sec_get_share_key(session_id) {
    try {
      const headers = await this.sec_wo_ai_headers();
      headers["Referer"] = "https://ai.wo.cn/wxMini";
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/historyChat/shareDetail",
        {headers: headers, data: JSON.stringify({"sessionId": session_id}), timeout: 10}
      );
      const res = await response.json();
      if (res.code === 0 && res.data) {
        return String(res.data);
      }
      this.log(`获取分享key失败：${res.msg || JSON.stringify(res)}`);
    } catch (e) {
      this.log(`获取分享key异常：${e && e.message ? e.message : e}`);
    }
    return "";
  },

  async sec_view_share_detail(key, view_token) {
    try {
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/historyChat/getShareDetail",
        {headers: await this.sec_wo_ai_headers(true, view_token), data: JSON.stringify({"key": key, "pageSize": 10, "pageNum": 1}), timeout: 10}
      );
      const res = await response.json();
      if (res.code === 0) {
        this.log("查看分享对话成功");
        return true;
      }
      this.log(`查看分享对话失败：${res.msg || JSON.stringify(res)}`);
    } catch (e) {
      this.log(`查看分享对话异常：${e && e.message ? e.message : e}`);
    }
    return false;
  },

  async share_ai_chat_sec(taskCode = "") {
    try {
      let content = await this.sec_get_chat_list();
      if (!content.length) {
        this.log("暂无AI对话历史，先发送一条对话...");
        if (!(await this.sec_send_ai_chat())) {
          return false;
        }
        await sleep(2000);
        content = await this.sec_get_chat_list();
      }
      if (!content.length) {
        this.log("仍无AI对话历史，跳过分享任务");
        return false;
      }
      const session_id = content[0].chatSessionId || "";
      if (!session_id) {
        this.log("获取分享key失败：缺少sessionId");
        return false;
      }
      const share_key = await this.sec_get_share_key(session_id);
      if (!share_key) {
        return false;
      }
      this.sec_ai_share_key = share_key;
      if (taskCode) {
        this.sec_share_task_code = taskCode;
      }
      const short_key = share_key.length > 8 ? share_key.slice(0, 8) + "..." : share_key;
      this.log(`AI对话分享key获取成功: ${short_key}`);
      return true;
    } catch (e) {
      this.log(`安全管家: 分享AI对话异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async role_chat_sec() {
    try {
      const session_id = "mmrp" + randomString(10, "0123456789");
      const request_id = "rqid_mmrp" + randomString(10, "0123456789");
      const headers = await this.sec_wo_ai_headers();
      headers["Accept"] = "text/event-stream";
      headers["Referer"] = "https://ai.wo.cn/wxMini/psychologicalApp/chat?id=1&type=ruole";
      const response = await this.httpPost(
        "https://ai.wo.cn/web-tongtong/lxzn/chat",
        {headers: headers, data: JSON.stringify({
          "sessionId": session_id,
          "requestId": request_id,
          "roleId": 1,
          "message": "我有拖延症，好多事情不想做。",
        }), timeout: 60}
      );
      // Egern 会话已完整读取响应体（对应 Python 的 stream + iter_lines 消费）
      if (response.status >= 400) {
        this.log(`角色助手对话失败：HTTP ${response.status}`);
        return false;
      }
      this.log("角色助手对话完成");
      return true;
    } catch (e) {
      this.log(`安全管家: 角色助手对话异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async sec_finalize_share_ai_task() {
    if (!this.sec_share_task_code) {
      return false;
    }
    await this.sec_track_pending_claim(this.sec_share_task_code, this.sec_share_task_name);
    let latest_task = await this.sec_refresh_task_snapshot(
      this.sec_share_task_code,
      this.sec_share_task_name,
      5,
      2
    );
    if (!latest_task) {
      await this.sec_refresh_security_context(true);
      latest_task = await this.sec_refresh_task_snapshot(
        this.sec_share_task_code,
        this.sec_share_task_name,
        5,
        2
      );
    }
    if (!latest_task) {
      this.log("联通助理-分享AI助手对话：互看后未查询到任务状态");
      return false;
    }
    const [finish_count, need_count, finish_text] = await this.sec_parse_task(latest_task);
    if (finish_text === "待领取" || (need_count > 0 && finish_count >= need_count)) {
      this.log("联通助理-分享AI助手对话：互看完成，尝试领取奖励");
      const receive_state = await this.receivePoints_sec(this.sec_share_task_code, this.sec_share_task_name);
      if (receive_state === "received" || receive_state === "auto") {
        await this.getUserInfo_sec();
        return true;
      }
      if (receive_state === "pending") {
        await this.sec_recover_pending_claims(2, 6, true);
        if (!(this.sec_share_task_code in this.sec_pending_claim_tasks)) {
          return true;
        }
      }
    }
    this.log(`联通助理-分享AI助手对话：互看后状态 ${finish_count}/${need_count} - ${finish_text}`);
    return false;
  },

  async _sec_jf_headers(with_signature = false) {
    const headers = {
      "ticket": decodeURIComponent(this.sec_ticket),
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301};ltst;OSVersion/16.6",
      "partnersid": "1702",
      "clienttype": "uasp_unicom_applet",
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://m.jf.10010.com",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    if (this.sec_jeaId !== undefined && this.sec_jeaId) {
      headers["Cookie"] = `_jea_id=${this.sec_jeaId};`;
    }
    if (with_signature) {
      Object.assign(headers, await this.build_signature_headers_sec());
    }
    return headers;
  },

  async update_sec_jea_id(response = null) {
    let jea_id = "";
    if (response !== null) {
      const cookie = response.headers.get("Set-Cookie") || "";
      const match = cookie.match(/_jea_id=([^;]+)/);
      if (match) {
        jea_id = match[1];
      }
    }
    if (!jea_id) {
      const jar = this.session.getCookieDict();
      for (const name of Object.keys(jar)) {
        if (name === "_jea_id") {
          jea_id = jar[name];
          break;
        }
      }
    }
    if (jea_id) {
      this.sec_jeaId = jea_id;
    }
    return jea_id;
  },

  async sec_query_task_list() {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/taskDetail";
    let last_error = "";
    for (let attempt = 1; attempt < 4; attempt++) {
      let response = null;
      try {
        response = await this.httpPost(url, {json: {}, headers: await this._sec_jf_headers(), timeout: 15});
        await this.update_sec_jea_id(response);
        const res = await response.json();
        const task_detail = ((res || {}).data || {}).taskDetail || {};
        return task_detail.taskList || [];
      } catch (e) {
        if (e instanceof SyntaxError) {
          const preview = ((response !== null ? await response.text() : "") || "").trim().replace(/\n/g, " ");
          last_error = `非JSON响应[${attempt}/3]: ${preview.slice(0, 60) || "empty"}`;
        } else {
          last_error = String(e && e.message ? e.message : e);
        }
      }
      if (attempt < 3) {
        await sleep(2000);
      }
    }
    this.log(`联通助理任务列表查询异常: ${last_error}`);
    return [];
  },

  async sec_parse_task(task) {
    const finish_count = safeInt(task.finishCount ?? 0);
    const need_count = safeInt(task.needCount ?? 0);
    const finish_text = task.finishText || task.taskStatusName || task.taskStatusDesc || "未知状态";
    return [finish_count, need_count, finish_text];
  },

  async sec_supports_delayed_claim(task_name) {
    const delayed_keywords = [
      "上传知识库文件",
      "分享AI助手对话",
      "角色助手对话",
    ];
    return delayed_keywords.some((keyword) => task_name.includes(keyword));
  },

  async sec_track_pending_claim(task_code, task_name) {
    if (task_code && task_name && await this.sec_supports_delayed_claim(task_name)) {
      this.sec_pending_claim_tasks[task_code] = task_name;
    }
  },

  async sec_untrack_pending_claim(task_code) {
    if (task_code) {
      delete this.sec_pending_claim_tasks[task_code];
    }
  },

  async sec_refresh_security_context(refresh_secret = false) {
    try {
      this.sec_ticket1 = "";
      this.sec_token = "";
      this.sec_ticket = "";
      await this.getTicketByNative_sec();
      if (!this.sec_ticket1) {
        return false;
      }
      await this.getAuthToken_sec();
      if (!this.sec_token) {
        return false;
      }
      await this.getTicketForJF_sec();
      if (!this.sec_ticket) {
        return false;
      }
      if (refresh_secret) {
        this.sec_secretKey = null;
        if (!(await this.get_secret_key_sec(true))) {
          return false;
        }
      }
      return true;
    } catch (e) {
      this.log(`联通助理上下文刷新异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async sec_get_task_snapshot(task_code = "", task_name = "") {
    const list = await this.sec_query_task_list();
    for (const task of list) {
      if (task_code && task.taskCode === task_code) {
        return task;
      }
      if (task_name && task.taskName === task_name) {
        return task;
      }
    }
    return null;
  },

  async sec_refresh_task_snapshot(task_code, task_name, retries = 3, delay = 2) {
    let latest_task = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt) {
        await sleep(delay * 1000);
      }
      latest_task = await this.sec_get_task_snapshot(task_code, task_name);
      if (!latest_task) {
        continue;
      }
      const [finish_count, need_count, finish_text] = await this.sec_parse_task(latest_task);
      if (finish_text === "待领取" || (need_count > 0 && finish_count >= need_count)) {
        return latest_task;
      }
    }
    return latest_task;
  },

  async sec_should_manual_finish(task_name) {
    const manual_keywords = [
      "新增亲情守护成员",
      "新增宽带绑定",
      "语音提醒",
      "反诈险领取",
      "设置日程提醒",
    ];
    return manual_keywords.some((keyword) => task_name.includes(keyword));
  },

  async sec_wait_seconds(task_name) {
    if (["上传知识库文件", "分享AI助手对话", "角色助手对话"].some((k) => task_name.includes(k))) {
      return 5;
    }
    if (["添加黑名单", "骚扰拦截设置", "安全分提升", "号段拦截"].some((k) => task_name.includes(k))) {
      return 8;
    }
    return 4;
  },

  async receivePoints_sec(taskCode, taskName = "") {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/receive";
    let last_error = "";
    for (let attempt = 1; attempt < 3; attempt++) {
      let response = null;
      try {
        const headers = await this._sec_jf_headers(true);
        response = await this.httpPost(url, {json: {"taskCode": taskCode}, headers: headers, timeout: 10});
        await this.update_sec_jea_id(response);
        const res = await response.json();
        const score = String(((res.data || {}).score) || "").trim();
        const msg = String(res.msg || "").trim();
        if (score) {
          await this.sec_untrack_pending_claim(taskCode);
          this.log(`安全管家: 领取${score}成功`, true);
          return "received";
        }
        if (msg.includes("任务未完成") || msg.includes("不可领取")) {
          this.log("领取任务未完成");
          return "pending";
        }
        if (msg.includes("自动发放") || msg.includes("已领取")) {
          await this.sec_untrack_pending_claim(taskCode);
          this.log("任务已完成且奖励已领取");
          return "auto";
        }
        if (msg) {
          this.log(`领取失败：${msg}`);
          return "failed";
        }
        this.log(`领取失败：${JSON.stringify(res)}`);
        return "failed";
      } catch (e) {
        if (e instanceof SyntaxError) {
          const preview = ((response !== null ? await response.text() : "") || "").trim().replace(/\n/g, " ");
          last_error = `非JSON响应[${attempt}/2]: ${preview.slice(0, 60) || "empty"}`;
        } else {
          last_error = String(e && e.message ? e.message : e);
        }
      }
      if (attempt < 2) {
        await sleep(2000);
      }
    }
    this.log(`安全管家: 领取积分异常: ${last_error}`);
    return "error";
  },

  async finishTask_sec(taskCode, taskName) {
    try {
      const url = "https://m.jf.10010.com/jf-external-application/jftask/toFinish";
      const headers = await this._sec_jf_headers(true);
      const response = await this.httpPost(url, {json: {"taskCode": taskCode}, headers: headers, timeout: 10});
      await this.update_sec_jea_id(response);
      const action_map = {
        "添加黑名单": () => this.addToBlacklist_sec(),
        "号码标记": () => this.markPhoneNumber_sec(),
        "同步通讯录": () => this.syncAddressBook_sec(),
        "骚扰拦截设置": () => this.setInterceptionRules_sec(),
        "智能助手": () => this.zhushou_sec(),
        "代接助理": () => this.daijie_sec(),
        "安全分": () => this.anquanfen_sec(),
        "号段拦截": () => this.haoduan_sec(),
        "查看周报": () => this.viewWeeklyReport_sec(),
        "活动浏览": () => this.ojbk_sec(taskCode),
        "上传知识库文件": () => this.upload_knowledge_file_sec(),
        "分享AI助手对话": () => this.share_ai_chat_sec(taskCode),
        "角色助手对话": () => this.role_chat_sec(),
      };
      for (const key of Object.keys(action_map)) {
        if (taskName.includes(key)) {
          const result = await action_map[key]();
          return result === false ? false : true;
        }
      }
      this.log(`任务 ${taskName} 需要手动完成`);
      return false;
    } catch (e) {
      this.log(`安全管家: finishTask异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async signIn_sec(taskCode) {
    try {
      const url = "https://m.jf.10010.com/jf-external-application/jftask/sign";
      const headers = await this._sec_jf_headers(true);
      const response = await this.httpPost(url, {json: {"taskCode": taskCode}, headers: headers, timeout: 10});
      await this.update_sec_jea_id(response);
      const res = await response.json();
      if (res.code === "0000") {
        return true;
      }
      this.log(`签到失败：${res ? res.msg : "状态未知"}`);
      return false;
    } catch (e) {
      this.log(`安全管家: 签到异常: ${e && e.message ? e.message : e}`);
      return false;
    }
  },

  async executeAllTasks_sec() {
    try {
      const task_list = await this.sec_query_task_list();
      if (!task_list.length) {
        this.log("联通助理任务列表查询失败");
        return;
      }
      for (const task of task_list) {
        const task_name = task.taskName || "";
        const task_code = task.taskCode || "";
        let [finish_count, need_count, finish_text] = await this.sec_parse_task(task);
        this.log(`${task_name}：${finish_count}/${need_count} - ${finish_text}`);
        if (!task_code || need_count <= 0) {
          this.log("---------------------");
          continue;
        }
        if (finish_count >= need_count) {
          if (finish_text === "待领取") {
            await sleep(2000);
            const receive_state = await this.receivePoints_sec(task_code, task_name);
            if (receive_state === "pending") {
              await this.sec_track_pending_claim(task_code, task_name);
            }
          } else {
            this.log("任务已完成且奖励已领取");
          }
          this.log("---------------------");
          continue;
        }
        const remaining = Math.max(need_count - finish_count, 1);
        this.log(`任务未完成，需要再执行 ${remaining} 次`);
        if (await this.sec_should_manual_finish(task_name)) {
          this.log(`任务 ${task_name} 需要手动完成`);
          this.log("---------------------");
          continue;
        }
        for (let i = 0; i < remaining; i++) {
          try {
            if (i) {
              await sleep(2000);
            }
            const handled = task_name.includes("签到") ? await this.signIn_sec(task_code) : await this.finishTask_sec(task_code, task_name);
            if (!handled) {
              break;
            }
            const wait_seconds = await this.sec_wait_seconds(task_name);
            if (wait_seconds > 0) {
              await sleep(wait_seconds * 1000);
            }
            const latest_task = await this.sec_refresh_task_snapshot(task_code, task_name, 3, 2);
            if (latest_task) {
              const parsed = await this.sec_parse_task(latest_task);
              finish_count = parsed[0];
              need_count = parsed[1];
              finish_text = parsed[2];
            }
            this.log(`第 ${i + 1} 次执行${task_name}任务完成`);
            const receive_state = await this.receivePoints_sec(task_code, task_name);
            if (receive_state === "pending") {
              await this.sec_track_pending_claim(task_code, task_name);
            }
            if (receive_state === "received" || receive_state === "auto") {
              break;
            }
            if (need_count > 0 && finish_count >= need_count) {
              this.log("任务已完成且奖励已领取");
              break;
            }
          } catch (e) {
            this.log(`执行 ${task_name} 失败：${e && e.message ? e.message : e}`);
            break;
          }
        }
        this.log("---------------------");
      }
    } catch (e) {
      this.log(`联通助理任务执行异常: ${e && e.message ? e.message : e}`);
    }
  },

  async getUserInfo_sec() {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/userInfo";
    let last_error = "";
    for (let attempt = 1; attempt < 3; attempt++) {
      let response = null;
      try {
        const headers = await this._sec_jf_headers();
        response = await this.httpPost(url, {json: {}, headers: headers, timeout: 10});
        await this.update_sec_jea_id(response);
        const res = await response.json();
        if (!res || res.code !== "0000" || !res.data) {
          this.log(`安全管家: 查询积分失败: ${res ? res.msg : "无响应"}`);
          return;
        }
        const current = safeInt(res.data.availableScore ?? 0);
        const today = res.data.todayEarnScore ?? 0;
        if (this.sec_oldJFPoints === undefined || this.sec_oldJFPoints === null) {
          this.sec_oldJFPoints = current;
          this.log(`当前积分：${current}，今日已赚 ${today}`);
        } else {
          const gained = current - this.sec_oldJFPoints;
          const user_label = this.mobile ? mask_str(this.mobile) : `账号[${this.index}]`;
          this.log(`安全管家: 用户${user_label}积分变动：${this.sec_oldJFPoints} → ${current} | 新增: ${gained}`, true);
        }
        return;
      } catch (e) {
        if (e instanceof SyntaxError) {
          const preview = ((response !== null ? await response.text() : "") || "").trim().replace(/\n/g, " ");
          last_error = `非JSON响应[${attempt}/2]: ${preview.slice(0, 60) || "empty"}`;
        } else {
          last_error = String(e && e.message ? e.message : e);
        }
      }
      if (attempt < 2) {
        await sleep(2000);
      }
    }
    this.log(`安全管家: 查询积分异常: ${last_error}`);
  },

  async sec_recover_pending_claims(rounds = 2, delay = 12, refresh_context = false) {
    if (!Object.keys(this.sec_pending_claim_tasks).length) {
      return false;
    }
    let recovered = false;
    const last_status_map = {};
    this.log(`联通助理：待补领任务 ${Object.keys(this.sec_pending_claim_tasks).length} 个，开始补查`);
    for (let attempt = 0; attempt < rounds; attempt++) {
      if (attempt) {
        await sleep(delay * 1000);
      }
      if (!Object.keys(this.sec_pending_claim_tasks).length) {
        break;
      }
      if (refresh_context && !(await this.sec_refresh_security_context(true))) {
        continue;
      }
      for (const [task_code, task_name] of Object.entries(this.sec_pending_claim_tasks)) {
        const latest_task = await this.sec_refresh_task_snapshot(task_code, task_name, 3, 2);
        if (!latest_task) {
          const status_key = "missing";
          if (last_status_map[task_code] !== status_key) {
            this.log(`${task_name}：补查未取到任务状态`);
            last_status_map[task_code] = status_key;
          }
          continue;
        }
        const [finish_count, need_count, finish_text] = await this.sec_parse_task(latest_task);
        if (finish_text === "待领取" || (need_count > 0 && finish_count >= need_count)) {
          this.log(`${task_name}：补查后尝试领取`);
          const receive_state = await this.receivePoints_sec(task_code, task_name);
          if (receive_state === "received" || receive_state === "auto") {
            recovered = true;
            delete last_status_map[task_code];
            continue;
          }
        } else {
          const status_key = `${finish_count}/${need_count}-${finish_text}`;
          if (last_status_map[task_code] !== status_key) {
            this.log(`${task_name}：补查状态 ${finish_count}/${need_count} - ${finish_text}`);
            last_status_map[task_code] = status_key;
          }
        }
      }
    }
    if (recovered) {
      await this.getUserInfo_sec();
    }
    if (Object.keys(this.sec_pending_claim_tasks).length) {
      const names = Object.values(this.sec_pending_claim_tasks).join("、");
      this.log(`联通助理：仍待补领 ${names}`);
    }
    return recovered;
  },

  async securityButlerTask(is_query_only = false) {
    this.log("==== 联通安全管家 ====");
    if (!this.ecs_token) {
      this.log("安全管家: 缺少 ecs_token，跳过");
      return;
    }
    try {
      await this.getTicketByNative_sec();
      if (!this.sec_ticket1) return;
      await this.getAuthToken_sec();
      if (!this.sec_token) return;
      await this.getTicketForJF_sec();
      if (!this.sec_ticket) return;
      this.sec_oldJFPoints = null;
      await this.getUserInfo_sec();
      if (is_query_only) {
        this.log("联通助理积分：[查询模式] 跳过任务执行");
        return;
      }
      await this.get_secret_key_sec();
      await this.executeAllTasks_sec();
      this.log("等待积分到账，等待一会...");
      await this.sec_recover_pending_claims(2, 12, true);
      await sleep(3000);
      await this.getUserInfo_sec();
    } catch (e) {
      this.log(`安全管家: 异常: ${e && e.message ? e.message : e}`);
    }
  },

});
// Part 07: 联通祝福入口 + 天天领现金
// 对应 Python 19705.py 行 4358-4629（ltzf_task / openPlatLineNew / get_bizchannelinfo /
// get_epay_authinfo / ttlxj_task / ttlxj_authorize / ttlxj_auth_check / ttlxj_login /
// ttlxj_do_tasks / ttlxj_unifyDrawNew / ttlxj_query_available）
// 说明：wocare_getToken / wocare_getSpecificityBanner / wocare_getDrawTask / wocare_loadInit
//       定义在 part03，本 Part 直接 await this.wocare_xxx() 调用。
Object.assign(UserService.prototype, {

  async ltzf_task() {
    this.log("==== 联通祝福 ====");
    const base_url = "https://wocare.unisk.cn/mbh/getToken";
    const params = {
      "channelType": WOCARE_CONSTANTS["serviceLife"],
      "homePage": "home",
      "duanlianjieabc": "qAz2m"
    };
    const targetUrl = `${base_url}?${encodeParams(params)}`;
    const res = await this.openPlatLineNew(targetUrl);
    if (!res || !('ticket' in res)) {
      this.log("联通祝福: 获取Ticket失败");
      return;
    }
    const ticket = res['ticket'];
    if (!await this.wocare_getToken(ticket)) {
      this.log("联通祝福: 获取Wocare Token失败");
      return;
    }
    await this.wocare_getSpecificityBanner();
    const wocare_activities = [
      {"name": "星座配对", "id": 2},
      {"name": "大转盘", "id": 3},
      {"name": "盲盒抽奖", "id": 4}
    ];
    for (const activity of wocare_activities) {
      await this.wocare_getDrawTask(activity);
      await this.wocare_loadInit(activity);
    }
  },

  async openPlatLineNew(to_url) {
    try {
      const base_url = "https://m.client.10010.com/mobileService/openPlatform/openPlatLineNew.htm";
      const params = {"to_url": to_url};
      let res;
      for (let attempt = 1; attempt < 4; attempt++) {
        try {
          res = await this.httpGet(base_url, {params: params, allowRedirects: false, timeout: 15});
          break;
        } catch (e) {
          const err_msg = String(e && e.message ? e.message : e);
          if (attempt < 3 && env("UNICOM_PROXY_API") && ("Max retries exceeded" in err_msg || err_msg.toLowerCase().includes("timed out") || err_msg.toLowerCase().includes("connection") || err_msg.includes("SOCKS"))) {
            this.log(`openPlatLineNew 第${attempt}次异常触发故障转移: ${err_msg}`);
            this.failover_proxy();
            continue;
          }
          this.log(`openPlatLineNew 第${attempt}次重试 - 异常: ${e}`);
          if (attempt === 3) {
            return null;
          }
          await sleep(2 * 1000);
        }
      }
      if (res.status === 302 && res.headers.get("Location")) {
        const loc = res.headers.get("Location");
        const parsed = new URL(loc);
        const qs = {};
        parsed.searchParams.forEach((v, k) => { (qs[k] = qs[k] || []).push(v); });
        const ticket = (qs['ticket'] || [''])[0];
        const type_val = (qs['type'] || [''])[0];
        if (ticket) {
          return {'ticket': ticket, 'type': type_val, 'loc': loc};
        } else {
          this.log("openPlatLineNew: 重定向URL中无ticket");
        }
      } else {
        this.log(`openPlatLineNew: 状态码${res.status} (期望302)`);
      }
    } catch (e) {
      this.log(`openPlatLineNew 异常: ${String(e && e.message ? e.message : e)}`);
    }
    return null;
  },

  async get_bizchannelinfo() {
    const info = {
      "bizChannelCode": "225",
      "disriBiz": "party",
      "unionSessionId": "",
      "stType": "",
      "stDesmobile": "",
      "source": "",
      "rptId": this.rptId,
      "ticket": "",
      "tongdunTokenId": this.tokenId_cookie,
      "xindunTokenId": this.unicomTokenId
    };
    return JSON.stringify(info);
  },

  async get_epay_authinfo() {
    const info = {
      "mobile": "",
      "sessionId": this.sessionId ?? "",
      "tokenId": this.tokenId ?? "",
      "userId": ""
    };
    return JSON.stringify(info);
  },

  async ttlxj_task(is_query_only = false) {
    this.log("==== 天天领现金 ====");
    for (let attempt = 1; attempt < 31; attempt++) {
      try {
        const ticket_res = await this.openPlatLineNew("https://epay.10010.com/ci-mps-st-web/ttlxj/");
        if (!ticket_res || !ticket_res['ticket']) {
          if (attempt < 30) {
            this.log(`天天领现金: 获取Ticket失败，正在重试 (${attempt}/30)...`);
            await sleep(2 * 1000);
            continue;
          } else {
            this.log("天天领现金: 获取Ticket失败，已达最大重试次数，跳过任务");
            return;
          }
        }
        const ticket = ticket_res['ticket'];
        const type_val = ticket_res['type'];
        if (await this.ttlxj_authorize(ticket, type_val, ticket_res['loc'])) {
          if (await this.ttlxj_auth_check()) {
            if (is_query_only) {
              await this.ttlxj_query_available();
              return;
            }
            await this.ttlxj_do_tasks();
            await this.ttlxj_query_available();
            break;
          }
        } else {
          if (attempt < 30) {
            this.log(`天天领现金: 授权失败，正在重试 (${attempt}/30)...`);
            await sleep(2 * 1000);
          } else {
            this.log("天天领现金: 授权失败，已达最大重试次数");
          }
        }
      } catch (e) {
        if (attempt < 30) {
          this.log(`天天领现金: 任务异常 (${e})，正在重试 (${attempt}/30)...`);
          await sleep(2 * 1000);
        } else {
          this.log(`天天领现金: 任务异常: ${e}`);
        }
      }
    }
  },

  async ttlxj_authorize(ticket, type_val, referer_url) {
    try {
      const url = "https://epay.10010.com/woauth2/v2/authorize";
      const headers = {
        "Origin": "https://epay.10010.com",
        "Referer": referer_url
      };
      const payload = {
        "response_type": "rptid",
        "client_id": "73b138fd-250c-4126-94e2-48cbcc8b9cbe",
        "redirect_uri": "https://epay.10010.com/ci-mps-st-web/",
        "login_hint": {
          "credential_type": "st_ticket",
          "credential": ticket,
          "st_type": type_val,
          "force_logout": true,
          "source": "app_sjyyt"
        },
        "device_info": {
          "token_id": `chinaunicom-pro-${Date.now()}-${this.random_string(13)}`,
          "trace_id": this.random_string(32)
        }
      };
      const res = await this.httpPost(url, {json: payload, headers: headers, timeout: 10});
      if (res.status === 200) {
        return true;
      } else {
        this.log(`天天领现金: Authorize失败[${res.status}]: ${await res.text()}`);
        return false;
      }
    } catch (e) {
      this.log(`ttlxj_authorize error: ${e}`);
      return false;
    }
  },

  async ttlxj_auth_check() {
    try {
      const url = "https://epay.10010.com/ps-pafs-auth-front/v1/auth/check";
      const headers = {
        "bizchannelinfo": await this.get_bizchannelinfo()
      };
      const res = await this.httpPost(url, {headers: headers, json: {}, timeout: 10});
      const data = await res.json();
      const code = data["code"];
      if (code === "0000") {
        const auth_info = (data["data"] || {})["authInfo"] || {};
        this.sessionId = auth_info["sessionId"] || "";
        this.tokenId = auth_info["tokenId"] || "";
        this.epay_userId = auth_info["userId"] || "";
        return true;
      } else if (code === "2101000100") {
        const login_url = (data["data"] || {})["woauth_login_url"];
        if (login_url) {
          return await this.ttlxj_login(login_url);
        }
      } else {
        this.log(`天天领现金: AuthCheck失败[${code}]: ${data["msg"]}`);
        return false;
      }
    } catch (e) {
      this.log(`ttlxj_auth_check error: ${e}`);
      return false;
    }
  },

  async ttlxj_login(login_url) {
    try {
      const full_url = `${login_url}https://epay.10010.com/ci-mcss-party-web/clockIn/?bizFrom=225&bizChannelCode=225`;
      const res = await this.httpGet(full_url, {allowRedirects: false, timeout: 10});
      if (res.status === 302 && res.headers.get("Location")) {
        const loc = res.headers.get("Location");
        const parsed = new URL(loc);
        const qs = {};
        parsed.searchParams.forEach((v, k) => { (qs[k] = qs[k] || []).push(v); });
        const rptid = (qs['rptid'] || [''])[0];
        if (rptid) {
          this.rptId = rptid;
          return await this.ttlxj_auth_check();
        } else {
          this.log("天天领现金: Login跳转后无rptid");
        }
      } else {
        this.log(`天天领现金: Login失败[${res.status}]`);
      }
      return false;
    } catch (e) {
      this.log(`ttlxj_login error: ${e}`);
      return false;
    }
  },

  async ttlxj_do_tasks() {
    const info_url = "https://epay.10010.com/ci-mcss-party-front/v1/ttlxj/userDrawInfo";
    const headers = {
      "bizchannelinfo": await this.get_bizchannelinfo(),
      "authinfo": await this.get_epay_authinfo()
    };
    const res = await this.request("post", info_url, {json: {}, headers: headers});
    if (!res) return;
    const data = await res.json();
    if (data['code'] === '0000') {
      const day_of_week = (data["data"] || {})["dayOfWeek"] || "";
      const draw_key = `day${day_of_week}`;
      const has_not_clocked_in = (data["data"] || {})[draw_key] === "1";
      if (has_not_clocked_in) {
        this.log(`天天领现金: 今天未打卡`, true);
        // Python: (datetime.now().weekday() + 1) % 7；JS getDay()（周日=0）数值与之完全一致
        const today_js = new Date().getDay();
        const draw_type = today_js === 0 ? "C" : "B";
        await this.ttlxj_unifyDrawNew(draw_type);
      } else {
        this.log(`天天领现金: 今天已打卡`, true);
      }
    } else {
      this.log(`天天领现金: 查询失败: ${data['msg']}`);
    }
  },

  async ttlxj_unifyDrawNew(draw_type) {
    const draw_url = "https://epay.10010.com/ci-mcss-party-front/v1/ttlxj/unifyDrawNew";
    const headers = {
      "bizchannelinfo": await this.get_bizchannelinfo(),
      "authinfo": await this.get_epay_authinfo()
    };
    const req_data = {
      "drawType": draw_type,
      "bizFrom": "225",
      "activityId": "TTLXJ20210330"
    };
    const res = await this.request("post", draw_url, {data: req_data, headers: headers});
    if (!res) return;
    const data = await res.json();
    if (data['code'] === '0000') {
      const prize = (data['data'] || {})['prizeName'] || '未知奖品';
      this.log(`天天领现金: 抽奖成功: ${prize}`, true);
    } else {
      this.log(`天天领现金: 抽奖失败: ${data['msg']}`);
    }
  },

  async ttlxj_query_available() {
    const avail_url = "https://epay.10010.com/ci-mcss-party-front/v1/ttlxj/queryAvailable";
    const headers = {
      "bizchannelinfo": await this.get_bizchannelinfo(),
      "authinfo": await this.get_epay_authinfo()
    };
    const res = await this.request("post", avail_url, {json: {}, headers: headers});
    if (!res) return;
    const data = await res.json();
    if (data['code'] === '0000') {
      const d = data['data'] || {};
      const amount_raw = safeInt(d['availableAmount'], 0);
      const amount_yuan = (amount_raw / 100).toFixed(2);
      let msg = `天天领现金: 可用立减金: ${amount_yuan}元`;
      const seven_day = safeInt(d['sevenDayExpireAmount'], 0);
      if (seven_day > 0) {
        msg += `, 7天内过期立减金: ${(seven_day / 100).toFixed(2)}元`;
      }
      const min_exp_amt = safeInt(d['minExpireAmount'], 0);
      const min_exp_date = d['minExpireDate'];
      if (min_exp_amt > 0 && min_exp_date) {
        msg += `, 最早过期立减金: ${(min_exp_amt / 100).toFixed(2)}元 -- ${min_exp_date}过期`;
      }
      this.log(msg, true);
    } else {
      this.log(`天天领现金: 查询余额失败: ${data['msg']}`);
    }
  },

});
// Part 07b: 补 P7 遗漏的 2 个方法（Python 4385 openPlatLineNew / 4585 ttlxj_unifyDrawNew）
Object.assign(UserService.prototype, {
  async openPlatLineNew(to_url) {
    try {
      const base_url = "https://m.client.10010.com/mobileService/openPlatform/openPlatLineNew.htm";
      const params = { to_url: to_url };
      let res = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await this.httpGet(base_url, { params: params, allowRedirects: false, timeout: 15 });
          break;
        } catch (e) {
          const err_msg = String(e && e.message ? e.message : e);
          // Egern 版：无脚本内代理故障转移（configure_proxy 已 stub），仅重试
          this.log("openPlatLineNew 第" + attempt + "次重试 - 异常: " + err_msg);
          if (attempt === 3) return null;
          await sleep(2000);
        }
      }
      if (res.status === 302 && res.headers.get("location")) {
        const loc = res.headers.get("location");
        const parsed = new URL(loc, base_url);
        const ticket = parsed.searchParams.get("ticket") || "";
        const type_val = parsed.searchParams.get("type") || "";
        if (ticket) {
          return { ticket: ticket, type: type_val, loc: loc };
        } else {
          this.log("openPlatLineNew: 重定向URL中无ticket");
        }
      } else {
        this.log("openPlatLineNew: 状态码" + (res ? res.status : "?") + " (期望302)");
      }
    } catch (e) {
      this.log("openPlatLineNew 异常: " + (e && e.message ? e.message : e));
    }
    return null;
  },

  async ttlxj_unifyDrawNew(draw_type) {
    const draw_url = "https://epay.10010.com/ci-mcss-party-front/v1/ttlxj/unifyDrawNew";
    const headers = {
      bizchannelinfo: await this.get_bizchannelinfo(),
      authinfo: await this.get_epay_authinfo(),
    };
    const req_data = {
      drawType: draw_type,
      bizFrom: "225",
      activityId: "TTLXJ20210330",
    };
    const res = await this.request("post", draw_url, { data: req_data, headers: headers });
    if (!res) return;
    const data = await res.json();
    if (data.code === "0000") {
      const prize = ((data.data || {}).prizeName) || "未知奖品";
      this.log("天天领现金: 抽奖成功: " + prize, true);
    } else {
      this.log("天天领现金: 抽奖失败: " + data.msg);
    }
  },
});
// Part 08: 通通乡村
// 译自 19705.py 行 4630-4985（ttxc_* 共 25 个方法）

// pyQuote 已移入骨架 part00（默认 safe='/'，与本模块用法一致）

Object.assign(UserService.prototype, {
  async ttxc_headers(auth = true, ecs = false) {
    const headers = {
      "user-agent": COMMON_CONSTANTS.MARKET_H5_UA,
      "content-type": "application/json",
      "accept": "*/*",
      "origin": "https://epay.10010.com",
      "referer": TTXC_REFERER,
      "x-requested-with": "com.sinovatech.unicom.ui",
    };
    if (auth && (this.ttxc_token || "")) {
      headers["authorization"] = this.ttxc_token;
    }
    if (ecs && this.ecs_token) {
      headers["Cookie"] = "ecs_token=" + this.ecs_token;
    }
    return headers;
  },

  async ttxc_post(path, payload = null, auth = true, with_user = true, ecs = false) {
    const data = Object.assign({}, payload || {});
    if (with_user) {
      if (data.userId === undefined) data.userId = this.ttxc_user_id || "";
    }
    if (data.channel === undefined) data.channel = TTXC_CHANNEL;
    const res = await this.request("post", TTXC_BASE_URL + path, { json: data, headers: await this.ttxc_headers(auth, ecs), timeout: 10 });
    if (!res) {
      return {};
    }
    try {
      return await res.json();
    } catch (e) {
      return {};
    }
  },

  async ttxc_init_ttgame() {
    this.session.setCookie("ecs_token", this.ecs_token);
    const url = TTXC_APP_BASE_URL + "/v1/login/ttGame?channel=" + TTXC_CHANNEL + "&rptId=";
    let data = {};
    for (let attempt = 1; attempt < 4; attempt++) {
      data = await this.ttxc_json(await this.request("post", url, { json: { unicomTokenId: this.unicomTokenId }, headers: await this.ttxc_headers(false, true), timeout: 10 }));
      if (data.code === "0000") {
        return true;
      }
      if (data.code === "4003" && data.data && await this.ttxc_finish_woauth(data.data)) {
        data = await this.ttxc_json(await this.request("post", url, { json: { unicomTokenId: this.unicomTokenId }, headers: await this.ttxc_headers(false, true), timeout: 10 }));
        if (data.code === "0000") {
          return true;
        }
      }
      if (attempt < 3) {
        await sleep(2 * 1000);
      }
    }
    this.log("通通乡村: 初始化失败[" + data.code + "]: " + (data.msg || ""));
    return false;
  },

  async ttxc_json(res) {
    if (!res) {
      return {};
    }
    try {
      return await res.json();
    } catch (e) {
      return {};
    }
  },

  async ttxc_finish_woauth(login_url) {
    const headers = {
      "Referer": "https://epay.10010.com/",
      "User-Agent": COMMON_CONSTANTS.MARKET_H5_UA,
    };
    let res = await this.request("get", login_url, { headers: headers, timeout: 10 });
    if (!res) {
      return false;
    }
    const match = ((await res.text()) || "").match(/var token = "([^"]+)"/);
    if (!match) {
      return false;
    }
    let next_url = "https://epay.10010.com/woauth2/after-collected-device-digest" +
      "?deviceDigestTraceId=&deviceDigestTokenId=&token=" + pyQuote(match[1]) + "&source=app_sjyyt";
    let referer = login_url;
    for (let i = 0; i < 6; i++) {
      res = await this.request("get", next_url, { headers: { "Referer": referer, "User-Agent": COMMON_CONSTANTS.MARKET_H5_UA }, allowRedirects: false, timeout: 10 });
      if (!res) {
        return false;
      }
      const location = res.headers.get("Location") || "";
      if (!location) {
        return res.status === 200;
      }
      referer = next_url;
      next_url = location;
    }
    return false;
  },

  async ttxc_login(update_nick = true) {
    if (!this.ecs_token) {
      await this.onLine();
    }
    if (!this.ecs_token) {
      this.log("通通乡村: 缺少 ecs_token，跳过");
      return false;
    }
    if (!await this.ttxc_init_ttgame()) {
      return false;
    }
    const data = await this.ttxc_post("/user/v1/login", null, false, false, true);
    if (data.code !== 0) {
      this.log("通通乡村: 登录失败[" + data.code + "]: " + (data.msg || ""));
      return false;
    }
    const user = data.data || {};
    this.ttxc_user_id = user.userId || "";
    this.ttxc_token = user.token || "";
    this.ttxc_charge_level = user.chargeLevel || {};
    if (!this.ttxc_user_id || !this.ttxc_token) {
      this.log("通通乡村: 登录响应缺少 userId/token");
      return false;
    }
    const carbon = this.ttxc_charge_level.carbonNum ?? 0;
    const eco = this.ttxc_charge_level.ecologyAmount ?? 0;
    this.log("通通乡村: 登录成功，碳能量" + carbon + "g，生态值" + eco, true);
    if (update_nick && !user.nickName) {
      await this.ttxc_update_nick();
    }
    return true;
  },

  async ttxc_update_nick() {
    const nick = (this.account_mobile || this.mobile || "").slice(-4) || String(randInt(1000, 9999));
    const data = await this.ttxc_post("/user/v1/updateNick", { nickName: nick });
    if (data.code === 0) {
      this.log("通通乡村: 已设置昵称 " + nick);
    } else {
      this.log("通通乡村: 设置昵称失败[" + data.code + "]: " + (data.msg || ""));
    }
  },

  async ttxc_sign(is_query_only = false) {
    const info = await this.ttxc_post("/client/v1/sign/info", {});
    const code = (info.data || {}).signinCode;
    if (!code) {
      this.log("通通乡村: 获取签到码失败");
      return;
    }
    const user = await this.ttxc_post("/client/v1/sign/user", { code: code });
    const last_time = String(((user.data || {}).lastSigninTime) || "");
    const now = new Date();
    const today = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
    const signed = last_time.slice(0, 10) === today;
    if (signed) {
      this.log("通通乡村: 今日已签到", true);
      return;
    }
    if (is_query_only) {
      this.log("通通乡村: 今日未签到", true);
      return;
    }
    const data = await this.ttxc_post("/client/v1/sign/signIn", { code: code });
    if (data.code === 0) {
      const awards = data.awards || [];
      const award = awards.length ? (awards[0].awardNum ?? 0) : 0;
      this.log("通通乡村: 签到成功，奖励" + award + "份", true);
    } else {
      this.log("通通乡村: 签到失败[" + data.code + "]: " + (data.msg || ""));
    }
  },

  async ttxc_get_tasks() {
    const data = await this.ttxc_post("/client/v1/task/list", {});
    if (data.code !== 0) {
      this.log("通通乡村: 获取任务列表失败[" + data.code + "]: " + (data.msg || ""));
      return [];
    }
    const tasks = [];
    for (const group of (data.data || [])) {
      for (const task of (group.taskList || [])) {
        task.taskGroupName = group.taskGroupName ?? "";
        tasks.push(task);
      }
    }
    return tasks;
  },

  async ttxc_finish_task(task) {
    const task_id = task.taskCode;
    if (!task_id) {
      return false;
    }
    const data = await this.ttxc_post("/client/v1/task/finish", { taskId: task_id });
    const name = task.taskTitle ?? task_id;
    if (data.code === 0) {
      const reward = task.carbonEnergyAmount || 0;
      this.log("通通乡村: 领取[" + name + "]成功 +" + reward + "g");
      return true;
    }
    this.log("通通乡村: 领取[" + name + "]失败[" + data.code + "]: " + (data.msg || ""));
    return false;
  },

  async ttxc_do_task(task) {
    const data = await this.ttxc_post("/client/v1/task/do", { taskId: task.taskCode });
    const name = task.taskTitle ?? task.taskCode ?? "";
    if (data.code === 0) {
      this.log("通通乡村: 已执行[" + name + "]");
      return true;
    }
    this.log("通通乡村: 执行[" + name + "]失败[" + data.code + "]: " + (data.msg || ""));
    return false;
  },

  async ttxc_claim_ready_tasks(tasks, claimed = null) {
    if (claimed === null) {
      claimed = new Set();
    }
    let count = 0;
    for (const task of tasks) {
      const task_id = task.taskCode;
      if (task.taskStatus === "UNCLA" && !claimed.has(task_id)) {
        if (await this.ttxc_finish_task(task)) {
          claimed.add(task_id);
          count += 1;
        }
      }
    }
    return count;
  },

  async ttxc_do_jump_tasks(tasks) {
    let count = 0;
    for (const task of tasks) {
      if (task.taskType === "GAME" && task.taskStatus === "UNDO" && task.jumpUrl) {
        if (await this.ttxc_do_task(task)) {
          count += 1;
        }
        await sleep(1 * 1000);
      }
    }
    return count;
  },

  async ttxc_do_garbage_task(tasks) {
    const task = tasks.find((t) => t.taskType === "GAME" && t.taskStatus === "UNDO" && (t.taskTitle || "").includes("垃圾分类")) || null;
    if (!task) {
      return false;
    }
    const start = await this.ttxc_post("/user/v1/start", {});
    const answer_no = (start.data || {}).answerNo;
    if (!answer_no) {
      this.log("通通乡村: 垃圾分类开始失败");
      return false;
    }
    await sleep(TTXC_GARBAGE_WAIT_SECONDS * 1000);
    const data = await this.ttxc_post("/user/v1/finish", { answerNo: answer_no });
    if (data.code === 0) {
      this.log("通通乡村: 垃圾分类已通关");
      return true;
    }
    this.log("通通乡村: 垃圾分类通关失败[" + data.code + "]: " + (data.msg || ""));
    return false;
  },

  async ttxc_get_lands() {
    const land = safeInt((this.ttxc_charge_level || {}).land, 4);
    const data = await this.ttxc_post("/plant/v1/user", { land: land });
    if (data.code !== 0) {
      this.log("通通乡村: 获取土地失败[" + data.code + "]: " + (data.msg || ""));
      return [];
    }
    return data.data || [];
  },

  async ttxc_get_plant_id() {
    const data = await this.ttxc_post("/client/v1/plant/page", { itemType: "SPE", pageNum: 1, pageSize: 20 });
    const items = ((data.data || {}).list) || [];
    return items.length ? (items[0].itemNo ?? "") : "";
  },

  async ttxc_plant_land(land_index, plant_id = null) {
    plant_id = plant_id || await this.ttxc_get_plant_id();
    if (!plant_id || !land_index) {
      return null;
    }
    await this.ttxc_post("/client/v1/plant/buy", { plantId: plant_id, gameCfgId: "" });
    const data = await this.ttxc_post("/plant/v1/planting", { landIndex: land_index, plantId: plant_id });
    if (data.code === 0) {
      this.log("通通乡村: 已在地块" + land_index + "种植作物");
      return { landIndex: land_index, status: 3, plant: { plantId: plant_id } };
    }
    this.log("通通乡村: 地块" + land_index + "种植失败[" + data.code + "]: " + (data.msg || ""));
    return null;
  },

  async ttxc_ensure_planted_lands(lands, needed = null) {
    const active = lands.filter((l) => [2, 3].includes(l.status) && ((l.plant || {}).plantId));
    const empty = lands.filter((l) => l.status === 1);
    if (!empty.length) {
      return active;
    }
    const plant_id = await this.ttxc_get_plant_id();
    if (!plant_id) {
      return active;
    }
    for (const land of empty) {
      const planted = await this.ttxc_plant_land(land.landIndex, plant_id);
      if (planted) {
        active.push(planted);
      }
    }
    return active;
  },

  async ttxc_charge_land(land) {
    const plant = land.plant || {};
    const plant_id = plant.plantId;
    const land_index = land.landIndex;
    if (!plant_id || !land_index) {
      return false;
    }
    const data = await this.ttxc_post("/plant/v1/charge", { landIndex: land_index, plantId: plant_id, mock: null });
    if (data.code === 0) {
      this.log("通通乡村: 地块" + land_index + "充能成功");
      // Python 语义：data["data"] 为空 dict 时视为 falsy，返回 land 本体
      const result = data.data || {};
      const hasData = Object.keys(result).length > 0;
      if (hasData && !result.plant) {
        result.plant = plant;
      }
      return hasData ? result : land;
    }
    this.log("通通乡村: 地块" + land_index + "充能失败[" + data.code + "]: " + (data.msg || ""));
    return null;
  },

  async ttxc_harvest_and_replant(land) {
    const plant = land.plant || {};
    const plant_id = plant.plantId;
    const land_index = land.landIndex;
    if (!plant_id || !land_index) {
      return null;
    }
    const data = await this.ttxc_post("/plant/v1/newHarvest", { landIndex: land_index, plantId: plant_id });
    if (data.code === 0) {
      this.log("通通乡村: 地块" + land_index + "收获成功");
      return await this.ttxc_plant_land(land_index);
    }
    this.log("通通乡村: 地块" + land_index + "收获失败[" + data.code + "]: " + (data.msg || ""));
    return null;
  },

  async ttxc_grow_land_to_harvest(land) {
    let current = land;
    if (current.status === 2) {
      await this.ttxc_harvest_and_replant(current);
      return;
    }
    let charged = 0;
    while (current.status === 3 && charged < TTXC_GROW_MAX_CHARGE_PER_LAND) {
      current = await this.ttxc_charge_land(current);
      if (!current) {
        return;
      }
      charged += 1;
      if (current.status === 2) {
        await this.ttxc_harvest_and_replant(current);
        return;
      }
      if (charged < TTXC_GROW_MAX_CHARGE_PER_LAND) {
        await sleep(1 * 1000);
      }
    }
    if (current.status === 3) {
      this.log("通通乡村: 地块" + current.landIndex + "催熟达到上限，跳过");
    }
  },

  async ttxc_replace_land(lands, updated) {
    const land_index = updated.landIndex;
    for (let i = 0; i < lands.length; i++) {
      if (lands[i].landIndex === land_index) {
        lands[i] = updated;
        return;
      }
    }
    lands.push(updated);
  },

  async ttxc_complete_charge_task(active, remaining) {
    while (remaining > 0) {
      const immature = active.filter((land) => land.status === 3 && ((land.plant || {}).plantId));
      if (!immature.length) {
        this.log("通通乡村: 未成熟作物不足，提前结束10次充能补足");
        return;
      }
      let progressed = false;
      for (const land of immature) {
        if (remaining <= 0) {
          return;
        }
        const result = await this.ttxc_charge_land(land);
        if (result) {
          await this.ttxc_replace_land(active, result);
          remaining -= 1;
          progressed = true;
        }
        await sleep(1 * 1000);
      }
      if (!progressed) {
        this.log("通通乡村: 充能未成功，提前结束10次充能补足");
        return;
      }
    }
  },

  async ttxc_farm_tasks(tasks) {
    const charge_task = tasks.find((t) => (t.taskTitle || "").includes("10次作物充能")) || null;
    const land_task = tasks.find((t) => (t.taskTitle || "").includes("三块不同")) || null;
    const harvest_task = tasks.find((t) => (t.taskTitle || "").includes("收获一次作物")) || null;
    if (!charge_task && !land_task && !harvest_task) {
      return;
    }
    const charge_pending = (charge_task && charge_task.taskStatus === "UNDO") ? charge_task : null;
    const land_pending = (land_task && land_task.taskStatus === "UNDO") ? land_task : null;
    const harvest_pending = (harvest_task && harvest_task.taskStatus === "UNDO") ? harvest_task : null;
    const lands = await this.ttxc_get_lands();
    const active = await this.ttxc_ensure_planted_lands(lands);
    const need_land = Math.max(safeInt((land_pending || {}).finishValue) - safeInt((land_pending || {}).doneValue), 0);
    if (harvest_pending && !charge_pending && !land_pending) {
      for (const land of active) {
        if (land.status === 2) {
          await this.ttxc_harvest_and_replant(land);
        }
      }
    }
    if (!active.length) {
      this.log("通通乡村: 没有可充能作物");
      return;
    }
    let charged = 0;
    const firstBatch = active.slice(0, need_land);
    for (let i = 0; i < firstBatch.length; i++) {
      const result = await this.ttxc_charge_land(firstBatch[i]);
      if (result) {
        active[i] = result;
        charged += 1;
        await sleep(1 * 1000);
      }
    }
    const need_charge = Math.max(safeInt((charge_pending || {}).finishValue) - safeInt((charge_pending || {}).doneValue) - charged, 0);
    await this.ttxc_complete_charge_task(active, need_charge);
    for (const land of active) {
      await this.ttxc_grow_land_to_harvest(land);
    }
  },

  async ttxc_task(is_query_only = false) {
    this.log("==== 通通乡村 ====");
    try {
      if (!await this.ttxc_login(!is_query_only)) {
        return;
      }
      await this.ttxc_sign(is_query_only);
      let tasks = await this.ttxc_get_tasks();
      if (is_query_only) {
        const todo = tasks.filter((t) => t.taskStatus === "UNDO").length;
        const claim = tasks.filter((t) => t.taskStatus === "UNCLA").length;
        this.log("通通乡村: 待做" + todo + "个，可领取" + claim + "个", true);
        return;
      }
      const claimed = new Set();
      await this.ttxc_claim_ready_tasks(tasks, claimed);
      await this.ttxc_do_jump_tasks(tasks);
      await this.ttxc_do_garbage_task(tasks);
      await this.ttxc_farm_tasks(tasks);
      tasks = await this.ttxc_get_tasks();
      await this.ttxc_claim_ready_tasks(tasks, claimed);
    } catch (e) {
      this.log("通通乡村异常: " + e);
    }
  },
});
// Part 09: 积分 + 联通爱听
// 对应 Python 源码行: 4279-4343 (aiting_query_integral/aiting_jf_headers/update_aiting_jea_id/get_secret_key_aiting/build_signature_headers_aiting)
//                  5007-5278 (aiting_get_aes ~ aiting_get_ticket, 含 generate_random_imei)
//                  5279-5460 (jf_get_task_detail/jf_to_finish/jf_pop_up/aiting_complete_task_api/aiting_get_secretkey/aiting_add_read_time/aiting_new_read_add/aiting_task)

// ---- 本 Part 专用的模块级小函数 ----
// 对应 Python urllib.parse.unquote（不转换 '+'）
function pyUnquote(s) {
  try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
}
// Python datetime.now().strftime("%Y%m%d%H%M%S")（无毫秒，与骨架 fmtYmdHms 区别在于不带毫秒）
// Python datetime.now().strftime("%y%m%d%H%M%S")（两位年份）
function fmtYmHms12(d) {
  d = d || new Date();
  return String(d.getFullYear()).slice(2) + pad2(d.getMonth()+1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

Object.assign(UserService.prototype, {

  async aiting_query_integral() {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/userInfo";
    const response = await this.httpPost(url, { json: {}, headers: await this.aiting_jf_headers() });
    await this.update_aiting_jea_id(response);
    const res = await response.json();
    if (res.code === "0000") {
      const data = res.data || {};
      this.log(`爱听任务: 积分概览 - 今日已赚 ${data.todayEarnScore}, 当前余额 ${data.availableScore}`, true);
    }
  },

  async aiting_jf_headers(with_signature) {
    with_signature = with_signature || false;
    const headers = {
      "ticket": pyUnquote(this.aiting_biz_ticket || ""),
      "pageid": "s789081246969976832",
      "clienttype": "aiting_android",
      "partnersid": "1706",
      "content-type": "application/json;charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36 WoReaderApp/Android",
      "Origin": "https://m.jf.10010.com",
      "Host": "m.jf.10010.com",
    };
    const jea_id = this.aiting_jeaId || "";
    if (jea_id) {
      headers["Cookie"] = `_jea_id=${jea_id};`;
    }
    if (with_signature) {
      Object.assign(headers, await this.build_signature_headers_aiting());
    }
    return headers;
  },

  async update_aiting_jea_id(response) {
    let jea_id = "";
    if (response !== undefined && response !== null) {
      const cookie = response.headers.get("Set-Cookie") || "";
      const match = cookie.match(/_jea_id=([^;]+)/);
      if (match) {
        jea_id = match[1];
      }
    }
    if (!jea_id) {
      const jar = this.session.getCookieDict();
      if (jar["_jea_id"]) {
        jea_id = jar["_jea_id"];
      }
    }
    if (jea_id) {
      this.aiting_jeaId = jea_id;
    }
    return jea_id;
  },

  async get_secret_key_aiting() {
    if (this.aiting_secretKey) {
      return this.aiting_secretKey;
    }
    try {
      await this.update_aiting_jea_id();
      const res = await this.httpGet(
        "https://m.jf.10010.com/jf-external-application/jftask/getSecretKey",
        {
          headers: await this.aiting_jf_headers(),
          timeout: 10,
        }
      );
      await this.update_aiting_jea_id(res);
      const data = await res.json();
      const secret = (data.data || {}).secretKey;
      if (data.code === "0000" && secret) {
        this.aiting_secretKey = utf8Bytes(secret);
        return this.aiting_secretKey;
      }
      this.log(`爱听任务: getSecretKey 失败: ${JSON.stringify(data)}`);
    } catch (e) {
      this.log(`爱听任务: getSecretKey 异常: ${e && e.message ? e.message : e}`);
    }
    return null;
  },

  async build_signature_headers_aiting() {
    const secret_key = await this.get_secret_key_aiting();
    if (!secret_key) {
      return {};
    }
    const request_ts = String(Math.round(Date.now()));
    const nonce = randomString(8, "0123456789abcdefghijklmnopqrstuvwxyz");
    const signature = hmacSha256(secret_key, `${nonce}${request_ts}`);
    return {
      "x-request-timestamp": request_ts,
      "x-request-nonce": nonce,
      "x-request-signature": signature,
    };
  },

  async aiting_get_aes(data, key) {
    const iv_str = "16-Bytes--String";
    const key_bytes = utf8Bytes(key.slice(0, 16));
    const iv_bytes = utf8Bytes(iv_str.slice(0, 16));
    const text = (isObj(data) || Array.isArray(data)) ? JSON.stringify(data) : String(data);
    const padded_data = pkcs7Pad(utf8Bytes(text), 16);
    const ciphertext = aesCbcEncrypt(padded_data, key_bytes, iv_bytes);
    const hex_str = bytesToHex(ciphertext);
    return b64encode(utf8Bytes(hex_str));
  },

  async aiting_aes_encrypt(data, key, iv) {
    const key_bytes = utf8Bytes(key);
    const iv_bytes = utf8Bytes(iv);
    const text = (isObj(data) || Array.isArray(data)) ? JSON.stringify(data) : String(data);
    const padded_data = pkcs7Pad(utf8Bytes(text), 16);
    const ciphertext = aesCbcEncrypt(padded_data, key_bytes, iv_bytes);
    const hex_str = bytesToHex(ciphertext).toUpperCase();
    return b64encode(utf8Bytes(hex_str));
  },

  async aiting_md5(text) {
    return md5(text);
  },

  async aiting_generate_sign(params, key) {
    const sorted_keys = Object.keys(params).sort();
    const sign_str = sorted_keys.map((k) => `${k}=${params[k]}`).join("&");
    const final_str = `${sign_str}&key=${key}`;
    return await this.aiting_md5(final_str);
  },

  async aiting_timestamp() {
    return String(Date.now());
  },

  async aiting_nonce() {
    return String(randInt(100000, 999999));
  },

  async aiting_generate_woid(imei) {
    const random6 = randomString(6);
    const imei8 = imei.length >= 8 ? imei.slice(0, 8) : imei.padEnd(8, "0");
    const random4 = randomString(4);
    const random2 = randomString(2);
    return `WOA${random6}${imei8}LOT${random4}LV${random2}`;
  },

  async aiting_calculate_clientconfirm(userid, imei) {
    const plaintext = `android${userid}${imei}`;
    return await this.aiting_aes_encrypt(plaintext, AITING_AES_KEY, AITING_AES_IV);
  },

  async aiting_calculate_passcode(timestamp, phone) {
    return await this.aiting_md5(timestamp + phone + AITING_CLIENT_KEY);
  },

  async aiting_build_statisticsinfo(userid, useraccount, imei, clientconfirm) {
    const params = {
      "channelid": "28015001",
      "sid": randomString(20, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"),
      "eid": randomString(20, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"),
      "osversion": "Android12",
      "clientallid": "000000100000000000058.0.2.1225",
      "display": "2400_1080",
      "ip": "192.168.3.24",
      "nettypename": "wifi",
      "version": "802",
      "versionname": "8.0.2",
      "terminalName": "Redmi",
      "terminalType": "Redmi_K30_Pro",
      "udid": "null",
      "woid": await this.aiting_generate_woid(imei),
      "useraccount": useraccount,
      "userid": userid,
      "clientconfirm": clientconfirm,
    };
    return Object.keys(params).map((k) => `${k}=${params[k]}`).join("&");
  },

  async generate_random_imei() {
    let tac = "";
    for (let i = 0; i < 8; i++) tac += String(randInt(0, 9));
    let snr = "";
    for (let i = 0; i < 6; i++) snr += String(randInt(0, 9));
    const imei_raw = tac + snr;
    const digits = imei_raw.split("").map((d) => parseInt(d, 10));
    for (let i = digits.length - 1; i >= 0; i -= 2) {
      digits[i] *= 2;
      if (digits[i] > 9) digits[i] -= 9;
    }
    const total = digits.reduce((a, b) => a + b, 0);
    const check_digit = (10 - (total % 10)) % 10;
    return imei_raw + String(check_digit);
  },

  async aiting_woread_login(phone) {
    const access_token = "ODZERTZCMjA1NTg1MTFFNDNFMThDRDYw";
    let token_enc = "";
    if (this.token_online) {
      token_enc = await this.aiting_get_aes(this.token_online, WOREAD_KEY);
    } else {
      this.log("阅读专区: 未找到 token_online，尝试仅使用手机号登录");
    }
    const phone_enc = await this.aiting_get_aes(phone, WOREAD_KEY);
    const timestamp = fmtYmdHms14(new Date());
    let inner_data;
    if (token_enc) {
      inner_data = {
        "tokenOnline": token_enc,
        "phone": phone_enc,
        "timestamp": timestamp,
      };
    } else {
      inner_data = {
        "phone": phone_enc,
        "timestamp": timestamp,
      };
    }
    const sign_result = await this.aiting_get_aes(inner_data, WOREAD_KEY);
    const url = "https://10010.woread.com.cn/ng_woread_service/rest/account/login";
    const body = { "sign": sign_result };
    const headers = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; Redmi Note 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36",
      "accesstoken": access_token,
      "Content-Type": "application/json;charset=UTF-8",
      "Origin": "https://10010.woread.com.cn",
    };
    const res = await (await this.httpPost(url, { json: body, headers: headers })).json();
    if (res.code === "0000") {
      return (res.data || {}).token;
    }
    this.log(`爱听登录: 沃阅读登录失败: ${JSON.stringify(res)}`);
    return null;
  },

  async aiting_get_jwt_token(statisticsinfo) {
    const timestamp = await this.aiting_timestamp();
    const sign_params = {
      "clientSource": "3",
      "clientId": "android",
      "source": "3",
      "timestamp": timestamp,
    };
    const sign_val = await this.aiting_generate_sign(sign_params, AITING_SIGN_KEY_APPKEY);
    const client_id_const = "395DEDE9C1D6FE11B7C9C0D82B353E74";
    const client_id_b64 = b64encode(utf8Bytes(client_id_const));
    const body = {
      "clientSource": "3",
      "clientId": client_id_b64,
      "source": "3",
      "timestamp": timestamp,
      "sign": sign_val,
    };
    const url = `${AITING_BASE_URL}/oauth/client/appkey`;
    const headers = {
      "Skip-Authorization-Check": "true",
      "statisticsinfo": statisticsinfo,
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; Redmi K30 Pro Build/SKQ1.220303.001)",
    };
    try {
      const res = await (await this.httpPost(url, { json: body, headers: headers })).json();
      if (res.code === "0000" && res.key) {
        return res.key;
      }
      this.log(`爱听登录: 获取JWT失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`爱听登录: 获取JWT异常: ${e && e.message ? e.message : e}`);
    }
    return null;
  },

  async aiting_api_login(phone, useraccount, jwt_token, statisticsinfo) {
    const timestamp = fmtYmdHms14(new Date());
    const passcode = await this.aiting_calculate_passcode(timestamp, phone);
    const query_params_list = [
      "networktype=3", "ua=Redmi+K30+Pro", "isencode=false",
      "clientversion=8.0.2", "versionname=Android_1_1080x2356",
      "channelid=28015001", "userlabelisencode=0", "validatecode=", "sid=",
      `timestamp=${timestamp}`, `passcode=${passcode}`,
    ];
    const query_str = query_params_list.join("&");
    const final_account = useraccount;
    const url = `${AITING_BASE_URL}/mainrest/rest/read/user/ulogin/3/${final_account}/1/1/0?${query_str}`;
    const req_time = await this.aiting_timestamp();
    const nonce = await this.aiting_nonce();
    const sign_params = {
      "jwt": jwt_token,
      "nonestr": nonce,
      "osversion": "Android12",
      "terminalName": "Redmi",
      "timestamp": req_time,
    };
    const sorted_keys = Object.keys(sign_params).sort();
    const sign_str = sorted_keys.map((k) => `${k}=${sign_params[k]}`).join("&");
    const requertid = await this.aiting_md5(`${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`);
    const headers = {
      "statisticsinfo": statisticsinfo,
      "requerttime": req_time,
      "nonestr": nonce,
      "requertid": requertid,
      "AuthorizationClient": `Bearer ${jwt_token}`,
      "User-Agent": "okhttp/4.9.0",
    };
    try {
      const res = await (await this.httpGet(url, { headers: headers })).json();
      if (res.code === "0000" && res.message) {
        const msg = res.message;
        let token = msg.token;
        let userid = msg.userid;
        if (msg.accountinfo) {
          token = (msg.accountinfo || {}).token || token;
          userid = (msg.accountinfo || {}).userid || userid;
        }
        return { "token": token, "userid": userid };
      }
      this.log(`爱听登录: 业务API登录失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`爱听登录: 业务API异常: ${e && e.message ? e.message : e}`);
    }
    return null;
  },

  async aiting_login_flow() {
    this.log("正在执行爱听登录流程...");
    if (!this.mobile && this.account_mobile) this.mobile = this.account_mobile;
    const woread_token = await this.aiting_woread_login(this.mobile);
    if (!woread_token) return false;
    this.aiting_woread_token = woread_token;
    const imei = await this.generate_random_imei();
    const userid = this.mobile;
    const useraccount = this.mobile;
    const clientconfirm = await this.aiting_calculate_clientconfirm(userid, imei);
    const statisticsinfo = await this.aiting_build_statisticsinfo(userid, useraccount, imei, clientconfirm);
    this.aiting_statisticsinfo = statisticsinfo;
    const jwt = await this.aiting_get_jwt_token(statisticsinfo);
    if (!jwt) return false;
    this.aiting_jwt = jwt;
    const login_data = await this.aiting_api_login(this.mobile, useraccount, jwt, statisticsinfo);
    if (!login_data) return false;
    this.aiting_biz_token = login_data.token;
    this.aiting_base_userid = login_data.userid || this.mobile;
    this.log(`✅ 爱听业务登录成功! Token已获取`);
    const biz_ticket = await this.aiting_get_ticket();
    if (biz_ticket) {
      this.aiting_biz_ticket = biz_ticket;
      return true;
    }
    return false;
  },

  async aiting_get_ticket() {
    const url = `${AITING_BASE_URL}/activity/rest/unicom/points/getInfoTicket`;
    const timestamp = await this.aiting_timestamp();
    const sign_params = {
      "token": this.aiting_biz_token,
      "timestamp": timestamp,
      "userid": this.aiting_base_userid,
    };
    const sign_val = await this.aiting_generate_sign(sign_params, AITING_SIGN_KEY_API);
    const body = {
      "sign": sign_val,
      "timestamp": timestamp,
      "token": this.aiting_biz_token,
      "userid": this.aiting_base_userid,
    };
    const nonce = await this.aiting_nonce();
    const head_sign_params = {
      "jwt": this.aiting_jwt,
      "nonestr": nonce,
      "osversion": "Android12",
      "terminalName": "Redmi",
      "timestamp": timestamp,
    };
    const sorted_keys = Object.keys(head_sign_params).sort();
    const sign_str = sorted_keys.map((k) => `${k}=${head_sign_params[k]}`).join("&");
    const final_sign_str = `${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`;
    const requertid = await this.aiting_md5(final_sign_str);
    const headers = {
      "AuthorizationClient": `Bearer ${this.aiting_jwt}`,
      "statisticsinfo": this.aiting_statisticsinfo,
      "requerttime": timestamp,
      "nonestr": nonce,
      "requertid": requertid,
    };
    try {
      const res = await (await this.httpPost(url, { json: body, headers: headers })).json();
      if (res.code === "0000") {
        const msg = res.message || "";
        if (msg.includes("ticket=")) {
          const match = msg.match(/ticket=([^&]+)/);
          if (match) {
            return match[1];
          }
        }
        return msg; // Fallback if message is ticket itself? No, standard is URL.
      }
      this.log(`爱听登录: 获取Ticket失败: ${JSON.stringify(res)}`);
    } catch (e) {
      this.log(`爱听登录: 获取Ticket异常: ${e && e.message ? e.message : e}`);
    }
    return null;
  },

  async jf_get_task_detail(ticket) {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/taskDetail";
    const headers = await this.aiting_jf_headers();
    headers["Referer"] = `https://m.jf.10010.com/jf-external-application/index.html?ticket=${ticket}&pageID=s789081246969976832`;
    const response = await this.httpPost(url, { json: {}, headers: headers });
    await this.update_aiting_jea_id(response);
    let res;
    try {
      res = await response.json();
    } catch (e) {
      this.log(`  ⚠️ 积分任务列表响应非JSON (状态码${response.status})`);
      return [];
    }
    return (((res.data || {}).taskDetail || {}).taskList || []);
  },

  async jf_to_finish(ticket, task_code) {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/toFinish";
    const response = await this.httpPost(
      url,
      {
        json: { "taskCode": task_code },
        headers: await this.aiting_jf_headers(true),
      }
    );
    await this.update_aiting_jea_id(response);
  },

  async jf_pop_up(ticket) {
    const url = "https://m.jf.10010.com/jf-external-application/jftask/popUp";
    const response = await this.httpPost(url, { json: {}, headers: await this.aiting_jf_headers() });
    await this.update_aiting_jea_id(response);
    let res;
    try {
      res = await response.json();
    } catch (e) {
      this.log(`  └─ ⚠️ 积分弹窗响应非JSON (状态码${response.status})`);
      return {};
    }
    if (isObj(res)) {
      if (res.code === "0000" && (res.data || {}).score) {
        this.log(`  └─ 🎉 爱听任务: 获得 ${res.data.score}`, true);
      } else if (res.code !== "0000") {
        const desc = (res.desc !== undefined && res.desc !== null) ? res.desc : JSON.stringify(res);
        this.log(`  └─ 📝 积分弹窗返回: ${desc}`);
      }
    }
    return res;
  },

  async aiting_complete_task_api(type_val) {
    const timestamp = await this.aiting_timestamp();
    const nonce = await this.aiting_nonce();
    const sign_params = { "jwt": this.aiting_jwt, "nonestr": nonce, "osversion": "Android12", "terminalName": "Redmi", "timestamp": timestamp };
    const sign_str = Object.keys(sign_params).sort().map((k) => `${k}=${sign_params[k]}`).join("&");
    const requertid = await this.aiting_md5(`${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`);
    const body_params = { "source": "3", "timestamp": timestamp, "token": this.aiting_woread_token, "type": String(type_val), "userid": this.aiting_base_userid };
    const body_str = Object.keys(body_params).sort().map((k) => `${k}=${body_params[k]}`).join("&");
    const sign = await this.aiting_md5(`${body_str}&key=${AITING_SIGN_KEY_API}`);
    const url = `${AITING_BASE_URL}/activity/rest/unicom/points/completiontask`;
    const payload = Object.assign({}, body_params, { "sign": sign });
    const headers = {
      "AuthorizationClient": `Bearer ${this.aiting_jwt}`,
      "requerttime": timestamp,
      "nonestr": nonce,
      "requertid": requertid,
      "statisticsinfo": this.aiting_statisticsinfo,
    };
    await this.httpPost(url, { json: payload, headers: headers });
  },

  async aiting_get_secretkey() {
    const timestamp = await this.aiting_timestamp();
    const nonce = await this.aiting_nonce();
    const sign_params = { "jwt": this.aiting_jwt, "nonestr": nonce, "osversion": "Android12", "terminalName": "Redmi", "timestamp": timestamp };
    const sign_str = Object.keys(sign_params).sort().map((k) => `${k}=${sign_params[k]}`).join("&");
    const requertid = await this.aiting_md5(`${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`);
    const url = `https://woread.com.cn/rest/read/statistics/getsecretkey/3/${this.aiting_base_userid}`;
    const headers = {
      "AuthorizationClient": `Bearer ${this.aiting_jwt}`,
      "requerttime": timestamp, "nonestr": nonce, "requertid": requertid,
      "statisticsinfo": this.aiting_statisticsinfo, "User-Agent": "okhttp/4.9.0",
    };
    const params = { "token": this.aiting_woread_token };
    const res = await (await this.httpGet(url, { params: params, headers: headers })).json();
    if (res.code === "0000") {
      return res.message;
    }
    return null;
  },

  async aiting_add_read_time(read_time_seconds) {
    const secretkey = await this.aiting_get_secretkey();
    if (!secretkey) return;
    const timestamp = await this.aiting_timestamp();
    const count_time_str = String(read_time_seconds * 1000);
    const book_id = "4524960";
    const data_obj = {
      "userid": this.aiting_base_userid,
      "counttime": count_time_str,
      "timestamp": timestamp,
      "secretkey": secretkey,
      "cntindex": book_id,
      "cnttype": 1,
      "readtype": 1,
    };
    const encrypted = await this.aiting_aes_encrypt(data_obj, ADDREADTIME_AES_KEY, AITING_AES_IV);
    const nonce = await this.aiting_nonce();
    const sign_params = { "jwt": this.aiting_jwt, "nonestr": nonce, "osversion": "Android12", "terminalName": "Redmi", "timestamp": timestamp };
    const sign_str = Object.keys(sign_params).sort().map((k) => `${k}=${sign_params[k]}`).join("&");
    const requertid = await this.aiting_md5(`${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`);
    const url = `https://woread.com.cn/rest/read/statistics/addreadtime/3/${encrypted}`;
    const random_uuid = uuid32();
    const body = {
      "channelid": "28015001", "creadertime": fmtYmHms12(new Date()),
      "imei": await this.generate_random_imei(),
      "list": { "cntindex": book_id, "cnttype": 1, "readtime": count_time_str, "readtype": 1 },
      "list1": [{ "cntindex": book_id, "cnttype": 1, "readtime": count_time_str, "readtype": 1 }],
      "listentimes": count_time_str, "uuid": random_uuid,
    };
    const headers = {
      "AuthorizationClient": `Bearer ${this.aiting_jwt}`,
      "requerttime": timestamp, "nonestr": nonce, "requertid": requertid,
      "statisticsinfo": this.aiting_statisticsinfo, "User-Agent": "okhttp/4.9.0",
    };
    const res = await this.httpPost(url, { json: body, headers: headers });
    if (res.status === 200) {
      this.last_read_submission_time = Date.now() / 1000;
      this.log(`✅ 阅读时长上报成功 (${read_time_seconds}s)`);
    }
  },

  async aiting_new_read_add() {
    const timestamp = await this.aiting_timestamp();
    const nonce = await this.aiting_nonce();
    const sign_params = { "jwt": this.aiting_jwt, "nonestr": nonce, "osversion": "Android12", "terminalName": "Redmi", "timestamp": timestamp };
    const sign_str = Object.keys(sign_params).sort().map((k) => `${k}=${sign_params[k]}`).join("&");
    const requertid = await this.aiting_md5(`${sign_str}&key=${AITING_SIGN_KEY_REQUERTID}`);
    const url = `https://woread.com.cn/rest/read/new/newreadadd/3/${this.aiting_base_userid}/${this.aiting_woread_token}`;
    const params = { "isfreeLimt": "0", "isgray": "true" };
    const body = { "source": 3, "cntindex": "4524960", "chapterallindex": "100136247350", "readtype": 3 };
    const headers = {
      "AuthorizationClient": `Bearer ${this.aiting_jwt}`, "requerttime": timestamp, "nonestr": nonce, "requertid": requertid, "statisticsinfo": this.aiting_statisticsinfo, "User-Agent": "Redmi K30 Pro",
    };
    await this.httpPost(url, { params: params, json: body, headers: headers });
  },

  async aiting_task(is_query_only) {
    is_query_only = is_query_only || false;
    this.log("==== 联通爱听任务 ====");
    if (!await this.aiting_login_flow()) {
      this.log("爱听任务: 登录失败，跳过");
      return;
    }
    this.log("爱听任务: 登录成功，正在获取任务列表...");
    try {
      await this.aiting_query_integral();
    } catch (e) {}
    const task_list = await this.jf_get_task_detail(this.aiting_biz_ticket);
    const done_list = task_list.filter((t) => t.finish === 1);
    const printed_names = new Set();
    for (const t of done_list) {
      const name = t.taskName;
      if (!printed_names.has(name)) {
        this.log(`  ✅ ${name} (${t.finishCount}/${t.needCount})`);
        printed_names.add(name);
      }
    }
    const todo_list = task_list.filter((t) => t.finish === 0 && !(t.taskName || "").includes("邀请"));
    if (todo_list.length === 0) {
      this.log("爱听任务: ✅ 所有任务已完成");
      if (is_query_only) {
        this.log("爱听任务: [查询模式] 跳过任务执行...");
      }
      return;
    }
    this.log(`爱听任务: 发现 ${todo_list.length} 个待办任务`);
    if (is_query_only) {
      this.log("爱听任务: [查询模式] 跳过任务执行...");
      return;
    }
    const read_tasks = todo_list.filter((t) => (((t.taskName || "").includes("阅读") || (t.taskName || "").includes("听读")) && !(t.taskName || "").includes("邀请")));
    for (const task of read_tasks) {
      const remaining = safeInt(task.needCount, 1) - safeInt(task.finishCount, 0);
      if (remaining <= 0) continue;
      this.log(`执行阅读任务: ${task.taskName} (剩余 ${remaining} 次)`);
      for (let i = 0; i < remaining; i++) {
        await this.jf_to_finish(this.aiting_biz_ticket, task.taskCode);
        this.log(`  └─ 第 ${i + 1}/${remaining} 次: 极速提交中...`);
        await this.aiting_new_read_add();
        await sleep(5 * 1000);
        await this.aiting_add_read_time(120);
        await sleep(2 * 1000);
        await this.jf_pop_up(this.aiting_biz_ticket);
      }
    }
    const other_tasks = todo_list.filter((t) => !["通知", "阅读", "听读", "邀请", "签到"].some((x) => (t.taskName || "").includes(x)));
    const notify_task = todo_list.find((t) => (t.taskName || "").includes("通知")) || null;
    if (notify_task) {
      this.log(`执行通知任务: ${notify_task.taskName}`);
      await this.jf_to_finish(this.aiting_biz_ticket, notify_task.taskCode);
      await sleep(1 * 1000);
      await this.aiting_complete_task_api(2);
      await sleep(2 * 1000);
      await this.jf_pop_up(this.aiting_biz_ticket);
    }
    for (const task of other_tasks) {
      const remaining = safeInt(task.needCount, 1) - safeInt(task.finishCount, 0);
      if (remaining <= 0) continue;
      this.log(`执行通用任务: ${task.taskName} (剩余 ${remaining} 次)`);
      for (let i = 0; i < remaining; i++) {
        await this.jf_to_finish(this.aiting_biz_ticket, task.taskCode);
        await sleep(1.5 * 1000);
        await this.aiting_complete_task_api(4); // Type 4
        await sleep(2 * 1000);
        await this.jf_pop_up(this.aiting_biz_ticket);
      }
    }
    try {
      await this.aiting_query_integral();
    } catch (e) {}
  },

});
// Part 10: 沃云手机 + 区域专区(云南)
// 对应 Python 源码 19705.py 行 5471-5840（wostore_cloud_login ~ yunnan_life_task）

// 对应 Python urllib.parse.quote(s, safe="")：除 A-Za-z0-9_.-~ 外全部百分号编码
// pyQuote/jsonDumpsAscii 已移入骨架 part00（带 safe 参数版本）
// 对应 Python json.dumps(o, ensure_ascii=True, separators=(',', ':'))

Object.assign(UserService.prototype, {
  async wostore_cloud_login(ticket) {
    try {
      const url1 = "https://member.zlhz.wostore.cn/wcy_member/yunPhone/h5Awake/businessHall";
      const body1 = {
        "cpId": "91002997", "channelId": "ST-Zujian001-gs", "ticket": ticket,
        "env": "prod", "transId": "S2ndpage1235+开福袋！+F1+CJDD00D0001+iphone_c@12.0801",
        "qkActId": null
      };
      const headers1 = {"Origin": "https://h5forphone.wostore.cn", "Content-Type": "application/json"};
      const json_data = jsonDumpsAscii(body1);
      const res1 = await (await this.httpPost(url1, {data: json_data, headers: headers1, timeout: 15})).json();
      if (String(res1["code"]) !== "0") {
        const msg = res1["msg"] ?? String(res1);
        this.log(`沃云手机: 登录第一步失败 - ${msg}`);
        return null;
      }
      const redirect_url = (res1["data"] || {})["url"] || "";
      this.log(`沃云手机: businessHall 返回 data: ${JSON.stringify(res1["data"]).slice(0, 300)}`);
      const match = redirect_url.match(/token=([^&]+)/);
      if (!match) {
        if (redirect_url.includes("protocol") || redirect_url.includes("sign")) {
          this.log("沃云手机: 未开通业务 (检测到协议签署跳转)，跳过");
        } else {
          this.log(`沃云手机: 无法提取 Token, 跳转URL: ${redirect_url}`);
        }
        return null;
      }
      const first_token = match[1];
      await sleep(1*1000);
      const url2 = "https://uphone.wostore.cn/h5api/activity-service/user/login";
      const body2 = {
        "identityType": "cloudPhoneLogin", "code": first_token, "channelId": "ST-Zujian001-gs",
        "activityId": "Lottery_251201", "device": "device"
      };
      const headers2 = {"Origin": "https://uphone.wostore.cn", "X-USR-TOKEN": first_token};
      const res2 = await (await this.httpPost(url2, {json: body2, headers: headers2, timeout: 15})).json();
      if (String(res2["code"]) === "200") {
        const user_token = (res2["data"] || {})["user_token"];
        return {"firstToken": first_token, "user_token": user_token};
      } else {
        this.log(`沃云手机: 登录第二步失败 - ${res2["msg"] ?? String(res2)}`);
        return null;
      }
    } catch (e) {
      this.log(`沃云手机: 登录异常 ${e}`);
      return null;
    }
  },

  async wostore_cloud_sign(user_token) {
    try {
      const url = "https://uphone.wostore.cn/h5api/activity-service/points/v1/sign";
      const body = {"activityCode": "Points_Sign_2507"};
      const headers = {"X-USR-TOKEN": user_token, "Origin": "https://uphone.wostore.cn"};
      const res = await (await this.httpPost(url, {json: body, headers: headers})).json();
      if (res["code"] == 200) {
        this.log("沃云手机: 积分签到成功", true);
      } else {
        // Fail silently or log if needed context
      }
    } catch (e) {}
  },

  async wostore_cloud_task_list(user_token) {
    try {
      const url = "https://uphone.wostore.cn/h5api/activity-service/user/task/list";
      const body = {"activityCode": "Lottery_251201"};
      const headers = {"X-USR-TOKEN": user_token};
      await this.httpPost(url, {json: body, headers: headers});
    } catch (e) {}
  },

  async wostore_cloud_get_chance(user_token, task_code) {
    try {
      const url = "https://uphone.wostore.cn/h5api/activity-service/user/task/raffle/get";
      const body = {"activityCode": "Lottery_251201", "taskCode": task_code};
      const headers = {"X-USR-TOKEN": user_token};
      await this.httpPost(url, {json: body, headers: headers});
    } catch (e) {}
  },

  async wostore_cloud_draw(user_token) {
    try {
      const url = "https://uphone.wostore.cn/h5api/activity-service/lottery";
      const body = {"activityCode": "Lottery_251201"};
      const headers = {"X-USR-TOKEN": user_token};
      const res = await (await this.httpPost(url, {json: body, headers: headers})).json();
      if (res["code"] == 200) {
        const prize = (res["data"] || {})["prizeName"] ?? "未中奖";
        this.log(`沃云手机: 抽奖结果 - ${prize}`, true);
      } else {
        this.log(`沃云手机: 抽奖失败 - ${res["msg"] ?? String(res)}`);
      }
    } catch (e) {
      this.log(`沃云手机: 抽奖异常 ${e}`);
    }
  },

  async wostore_cloud_task(is_query_only=false) {
    this.log("==== 沃云手机 ====");
    if (is_query_only) {
      this.log("沃云手机: [查询模式] 此平台暂无资产或余额可供查询", true);
      return;
    }
    const target_url = "https://h5forphone.wostore.cn/cloudPhone/dialogCloudPhone.html?channel_id=ST-Zujian001-gs&cp_id=91002997";
    const ticket_res = await this.openPlatLineNew(target_url);
    if (!ticket_res) {
      this.log("沃云手机: 获取入口 Ticket 失败");
      return;
    }
    let ticket = ticket_res;
    if (isObj(ticket)) {
      ticket = ticket["ticket"];
    }
    if (!ticket) {
      this.log("沃云手机: 获取入口 Ticket 失败 (为空)");
      return;
    }
    const tokens = await this.wostore_cloud_login(ticket);
    if (!tokens) {
      this.log("沃云手机: 登录失败，跳过后续任务");
      return;
    }
    const user_token = tokens["user_token"];
    await this.wostore_cloud_sign(user_token);
    await sleep(2*1000);
    await this.wostore_cloud_task_list(user_token);
    await sleep(1*1000);
    await this.wostore_cloud_get_chance(user_token, "2508-01");
    await sleep(2*1000);
    await this.wostore_cloud_draw(user_token);
  },

  async regional_task(is_query_only=false) {
    // 区域专区任务入口
    let is_xinjiang = false;
    let is_henan = false;
    let is_yunnan = false;
    let is_liaoning = false;
    let is_anhui = false;
    if (("city_info" in this) && this.city_info && Array.isArray(this.city_info)) {
      try {
        for (const city of this.city_info) {
          const pro_name = city["proName"] ?? "";
          if (pro_name.includes("新疆")) is_xinjiang = true;
          if (pro_name.includes("河南")) is_henan = true;
          if (pro_name.includes("云南")) is_yunnan = true;
          if (pro_name.includes("辽宁")) is_liaoning = true;
          if (pro_name.includes("安徽")) is_anhui = true;
        }
      } catch (e) {}
    }
    const rc = globalConfig.regional_config;
    if (is_query_only) {
      this.log("==== 区域专区 (查询模式) ====");
      if (is_xinjiang) {
        this.log("新疆专区: [查询模式] 跳过每日打卡，尝试查询每月抽奖记录");
        try {
          const ticket_res = await this.openPlatLineNew("https://zy100.xj169.com/touchpoint/openapi/jumpHandRoom1G?source=155&type=02");
          if (ticket_res && ticket_res["ticket"]) {
            const token = await this.xj_get_token(ticket_res["ticket"]);
            if (token) {
              await this.xj_query_monthly_draw_records(token);
            }
          }
        } catch (e) {
          this.log(`新疆专区: [查询模式] 查询每月抽奖记录异常 ${e}`);
        }
      }
      if (is_henan) {
        const is_signed = await this.shangdu_get_sign_status();
        if (is_signed === true) {
          this.log("河南商都: [状态查询] 今日已签到");
        } else if (is_signed === false) {
          this.log("河南商都: [状态查询] 今日未签到");
        } else {
          this.log("河南商都: [状态查询] 查询失败");
        }
      }
      if (is_yunnan) {
        await this.yunnan_life_task(true);
      }
      if (is_liaoning) {
        await this.ln_flmf_task(true);
      }
      if (is_anhui && AH_FRIDAY_AMOUNT) {
        this.log(`安徽超级星期五: [查询模式] 目标面额${AH_FRIDAY_AMOUNT}元 (仅周五10点执行)`);
      }
      return;
    }
    if (is_xinjiang) {
      this.log("==== 新疆专区 ====");
      await this.xj_task_main();
    }
    if (is_henan) {
      this.log("==== 河南商都 ====");
      await this.shangdu_task_main();
    }
    if (is_yunnan) {
      this.log("==== 云南生活 ====");
      await this.yunnan_life_task();
    }
    if (is_liaoning) {
      this.log("==== 辽宁福利魔方 ====");
      await this.ln_flmf_task();
    }
    if (is_anhui && AH_FRIDAY_AMOUNT && (rc["run_ah_friday"] ?? true)) {
      this.log("==== 安徽超级星期五 ====");
      await this.ah_friday_task();
    }
  },

  async yunnan_life_base_headers(token=null, extra=null) {
    const headers = {
      "Referer": "https://wsm.wx.yn10010.com/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json;charset=UTF-8",
      "Accept-Language": "zh-CN,en-US;q=0.8",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.1001};ltst;OSVersion/16.6",
    };
    if (token) {
      headers["token"] = token;
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  },

  async yunnan_life_calc_sign(payload) {
    const parts = [];
    for (const key of Object.keys(payload).sort()) {
      const value = payload[key];
      let encoded;
      if (isObj(value)) {
        encoded = pyQuote(JSON.stringify(value), "");
      } else {
        encoded = pyQuote(String(value), "");
      }
      parts.push(`${key}=${encoded}`);
    }
    const raw = parts.join("&").toLowerCase() + YUNNAN_LIFE_SIGN_SALT;
    return md5(md5(raw));
  },

  async yunnan_life_signed_headers(token, payload) {
    return await this.yunnan_life_base_headers(token, {
      "Origin": YUNNAN_LIFE_BASE_URL,
      "accessKeyId": YUNNAN_LIFE_ACCESS_KEY,
      "time": String(Math.round(Date.now())),
      "sign": await this.yunnan_life_calc_sign(payload),
    });
  },

  async yunnan_life_get_ticket() {
    if (!this.ecs_token) {
      return null;
    }
    try {
      const res = await this.httpGet(
        "https://m.client.10010.com/mobileService/openPlatform/openPlatLineNew.htm",
        {
          params: {
            "to_url": YUNNAN_LIFE_TO_URL,
            "amp;s": "100000425",
            "amp;boothCode": "YN-QCQYCS245",
            "amp;boothAccessMode": "24",
          },
          headers: {
            "Cookie": `ecs_token=${this.ecs_token}`,
            "Referer": "https://wsm.wx.yn10010.com/",
            "Accept-Language": "zh-CN,zh-Hans;q=0.9",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Site": "cross-site",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": (await this.yunnan_life_base_headers())["User-Agent"],
          },
          allowRedirects: false,
          timeout: 15,
        }
      );
      const location = res.headers.get("Location") || "";
      const match = location.match(/ticket=([^&]+)/);
      return match ? match[1] : null;
    } catch (e) {
      this.log(`云南生活: 获取 ticket 异常: ${e}`);
      return null;
    }
  },

  async yunnan_life_get_token(ticket) {
    if (!ticket) {
      return null;
    }
    try {
      const resp = await this.httpGet(
        `${YUNNAN_LIFE_BASE_URL}/2b2c-mobile/getPhoneNumber`,
        {
          params: {"ticket": ticket},
          headers: await this.yunnan_life_base_headers(null, {"Content-Type": "application/json;charset=gb2312"}),
          timeout: 15,
        }
      );
      let token = resp.headers.get("token") || resp.headers.get("Token");
      if (!token) {
        let data;
        try {
          data = await resp.json();
        } catch (e) {
          data = {};
        }
        token = data["token"] || (data["data"] || {})["token"];
      }
      if (!token) {
        this.log(`云南生活: 未找到 token，响应: ${(await resp.text()).slice(0, 160)}`);
        return null;
      }
      return String(token).startsWith("Bearer ") ? token : `Bearer ${token}`;
    } catch (e) {
      this.log(`云南生活: 获取 token 异常: ${e}`);
      return null;
    }
  },

  async yunnan_life_login() {
    const ticket = await this.yunnan_life_get_ticket();
    if (!ticket) {
      this.log("云南生活: 获取 ticket 失败");
      return null;
    }
    const token = await this.yunnan_life_get_token(ticket);
    if (!token) {
      this.log("云南生活: 获取 token 失败");
      return null;
    }
    return token;
  },

  async yunnan_life_do_task(token, payload) {
    const task_name = payload["taskName"] ?? payload["taskCode"] ?? "未知任务";
    try {
      const res = await (await this.httpPost(
        `${YUNNAN_LIFE_BASE_URL}/2b2c-mobile/activity/task/addTaskUser`,
        {
          data: JSON.stringify(payload),
          headers: await this.yunnan_life_signed_headers(token, payload),
          timeout: 15,
        }
      )).json();
      if (res["resultCode"] === "0000") {
        this.log(`云南生活: ✅ ${task_name}`);
      } else {
        this.log(`云南生活: ❌ ${task_name}: ${res["resultMsg"] ?? ""}`);
      }
    } catch (e) {
      this.log(`云南生活: [${task_name}] 异常: ${e}`);
    }
  },

  async yunnan_life_do_lottery(token, times=2) {
    const payload = {"actId": YUNNAN_LIFE_ACT_ID, "boothCode": ""};
    const headers = await this.yunnan_life_base_headers(token, {"Origin": YUNNAN_LIFE_BASE_URL});
    for (let i = 0; i < times; i++) {
      try {
        const res = await (await this.httpPost(
          `${YUNNAN_LIFE_BASE_URL}/2b2c-mobile/acttmpl/lottery/actLuckyDrawy`,
          {
            data: JSON.stringify(payload),
            headers: headers,
            timeout: 15,
          }
        )).json();
        if (res["resultCode"] === "0000") {
          this.log(`云南生活: ✅ 第${i + 1}次抽奖请求成功`);
        } else {
          this.log(`云南生活: ❌ 第${i + 1}次抽奖失败: ${res["resultMsg"] ?? ""}`);
        }
      } catch (e) {
        this.log(`云南生活: 第${i + 1}次抽奖异常: ${e}`);
      }
      if (i < times - 1) {
        await sleep(2*1000);
      }
    }
  },

  async yunnan_life_get_lottery_results(token) {
    try {
      const resp = await this.httpGet(
        `${YUNNAN_LIFE_BASE_URL}/2b2c-mobile/acttmpl/lottery/getUserRecordListActInfo`,
        {
          params: {"actId": YUNNAN_LIFE_ACT_ID, "periodId": YUNNAN_LIFE_ACT_ID},
          headers: await this.yunnan_life_base_headers(token, {"Content-Type": "application/json;charset=gb2312"}),
          timeout: 15,
        }
      );
      const data = await resp.json();
      const _d = new Date();
      const today = _d.getFullYear() + "-" + pad2(_d.getMonth() + 1) + "-" + pad2(_d.getDate());
      const awards = [];
      for (const item of ((data["data"] || {})["recordList"] || [])) {
        if (String(item["createTime"] ?? "").startsWith(today)) {
          awards.push(item["awardName"] ?? "未知");
        }
      }
      if (awards.length) {
        for (const award of awards) {
          this.log(`云南生活: 🎁 抽奖结果 - ${award}`, true);
        }
      } else {
        this.log("云南生活: 今日暂无抽奖记录");
      }
    } catch (e) {
      this.log(`云南生活: 查询抽奖结果异常: ${e}`);
    }
  },

  async yunnan_life_get_bean_balance(token) {
    try {
      const payload = {};
      const res = await (await this.httpPost(
        `${YUNNAN_LIFE_BASE_URL}/user/beans/api/getTotalAvailableBeansByPhone`,
        {
          data: JSON.stringify(payload),
          headers: await this.yunnan_life_signed_headers(token, payload),
          timeout: 15,
        }
      )).json();
      if (res["resultCode"] === "0000") {
        this.log(`云南生活: 💰 当前云豆余额: ${res["data"] ?? 0}`, true);
      } else {
        this.log(`云南生活: 获取云豆失败: ${res["resultMsg"] ?? ""}`);
      }
    } catch (e) {
      this.log(`云南生活: 查询云豆异常: ${e}`);
    }
  },

  async yunnan_life_task(is_query_only=false) {
    const token = await this.yunnan_life_login();
    if (!token) {
      return;
    }
    if (is_query_only) {
      this.log("云南生活: [查询模式] 查询云豆余额");
      await this.yunnan_life_get_bean_balance(token);
      return;
    }
    for (const task of YUNNAN_LIFE_TASKS) {
      await this.yunnan_life_do_task(token, task);
      await sleep(2*1000);
    }
    await this.yunnan_life_do_lottery(token, 2);
    await this.yunnan_life_get_lottery_results(token);
    await this.yunnan_life_get_bean_balance(token);
  },
});
// Part 11: 区域专区(新疆/商都/辽宁/安徽)
// 对应 Python 19705.py 行 5841-6387（xj_* / shangdu_* / ln_* / ah_* 共 17 个方法）
// regional_task 调度器与 yunnan_* 归其他 Part，本文件只含上述四省方法。
Object.assign(UserService.prototype, {
  // ---------------- 新疆专区 ----------------
  async xj_task_main() {
    const ticket_res = await this.openPlatLineNew("https://zy100.xj169.com/touchpoint/openapi/jumpHandRoom1G?source=155&type=02");
    if (!ticket_res || !ticket_res["ticket"]) {
      this.log("新疆专区: 获取入口 ticket 失败");
      return;
    }
    const token = await this.xj_get_token(ticket_res);
    if (token) {
      await this.xj_do_draw(token, "Jan2026Act");
      const day = new Date().getDate();
      if (19 <= day && day <= 25) {
        await this.xj_usersday_task(token);
      }
      await this.xj_monthly_draw_task(token);
    }
  },

  async xj_get_token(ticket) {
    try {
      const url = "https://zy100.xj169.com/touchpoint/openapi/getTokenAndCity";
      if (isObj(ticket)) {
        ticket = ticket["ticket"];
      }
      const data = { "ticket": ticket };
      const headers = {
        "Referer": "https://zy100.xj169.com/touchpoint/openapi/jumpHandRoom1G?source=155&type=02&ticket=" + ticket,
        "User-Agent": XJ_USER_AGENT,
      };
      const res = await (await this.httpPost(url, { data: data, headers: headers })).json();
      const result = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
      const resultData = (result["data"] !== undefined && result["data"] !== null) ? result["data"] : {};
      if (result["code"] === 0 && resultData["token"]) {
        return resultData["token"];
      }
      const token = resultData["userToken"];
      if (token) {
        return token;
      }
      return null;
    } catch (e) {
      this.log("新疆专区: 获取 token 异常 " + e);
      return null;
    }
  },

  async xj_do_draw(token, act_id) {
    try {
      const url = "https://zy100.xj169.com/touchpoint/openapi/marchAct/draw_" + act_id;
      const data = { "activityId": "daka" + act_id, "prizeId": "" };
      const headers = { "userToken": token, "User-Agent": XJ_USER_AGENT };
      const res = await (await this.httpPost(url, { data: data, headers: headers })).json();
      const r = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
      const msg = r["msg"] || r["data"] || "失败";
      this.log("新疆专区: 每日打卡 - " + msg, true);
    } catch (e) {
      this.log("新疆专区: 打卡异常 " + e);
    }
  },

  async xj_usersday_task(token) {
    try {
      const url = "https://zy100.xj169.com/touchpoint/openapi/marchAct/draw_UsersDay2025Act";
      const data = { "activityId": "usersDay2025Act", "prizeId": "hfq_twenty" };
      const headers = { "userToken": token, "User-Agent": XJ_USER_AGENT };
      const res = await (await this.httpPost(url, { data: data, headers: headers })).json();
      const r = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
      const msg = r["msg"] || r["data"] || "失败";
      this.log("新疆客户日: 秒杀结果 - " + msg, true);
    } catch (e) {
      this.log("新疆客户日: 秒杀异常 " + e);
    }
  },

  async xj_monthly_draw_once(token) {
    const headers = {
      "User-Agent": XJ_USER_AGENT,
      "userToken": token,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    };
    const payload = { "activityId": XJ_ACTIVITY_ID, "prizeId": "", "commHighFlag": "false" };
    try {
      const res = await (await this.httpPost(
        "https://zy100.xj169.com/touchpoint/openapi/themeAct/draw_" + XJ_ACTIVITY_ID,
        { data: payload, headers: headers, timeout: 10 }
      )).json();
      const code = res["code"];
      const msg = String((res["msg"] !== undefined && res["msg"] !== null) ? res["msg"] : "");
      const msg_type = String((res["msgType"] !== undefined && res["msgType"] !== null) ? res["msgType"] : "");
      const data = (res["data"] !== undefined && res["data"] !== null) ? res["data"] : "";
      if (code === "ERROR") {
        const data_str = String(data);
        if (data_str.includes("已用完") || data_str.includes("已抽完") || msg_type === "101") {
          return ["done", "今日机会已用尽 (" + (data_str || msg || "无可用次数") + ")"];
        }
        if (msg.includes("频率过高")) {
          return ["done", "接口频率限制"];
        }
        if (msg.includes("缺少参数")) {
          return ["invalid", "token 已失效"];
        }
        return ["done", "抽奖失败: " + (data_str || msg || "未知错误")];
      }
      if (code === "SUCCESS") {
        if (msg === "thanks1") {
          return ["continue", "未中奖 (" + (data || msg) + ")"];
        }
        return ["won", "中奖: " + (data || "未知奖品")];
      }
      if (String(code) === "401") {
        return ["invalid", "token 已失效"];
      }
      return ["continue", "未中奖 (" + (msg || data || code) + ")"];
    } catch (e) {
      return ["error", "请求异常: " + e];
    }
  },

  async xj_query_monthly_draw_records(token) {
    const headers = {
      "User-Agent": XJ_USER_AGENT,
      "userToken": token,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    };
    try {
      const res = await (await this.httpPost(
        "https://zy100.xj169.com/touchpoint/openapi/drawAct/getPrizesScroll",
        { data: { "activityId": XJ_ACTIVITY_ID }, headers: headers, timeout: 10 }
      )).json();
      let data = (res["data"] !== undefined && res["data"] !== null) ? res["data"] : [];
      if (!data || (Array.isArray(data) && data.length === 0)) {
        this.log("新疆专区: 每月抽奖暂无中奖记录");
        return;
      }
      if (isObj(data)) {
        data = [data];
      }
      if (Array.isArray(data) && data.length && typeof data[0] === "string") {
        for (const item of data.slice(0, 5)) {
          this.log("新疆专区: 每月抽奖记录 - " + item, true);
        }
        return;
      }
      let displayed = 0;
      for (const item of data) {
        if (!isObj(item)) {
          continue;
        }
        const prize_name = item["prizeName"] || item["prizeId"] || "未知奖品";
        const draw_ts = safeInt(item["drawDate"], 0);
        let draw_date = "未知时间";
        if (draw_ts) {
          const dd = new Date(draw_ts);
          draw_date = pad2(dd.getMonth() + 1) + "-" + pad2(dd.getDate());
        }
        this.log("新疆专区: 每月抽奖记录 - " + prize_name + " (" + draw_date + ")", true);
        displayed += 1;
        if (displayed >= 5) {
          break;
        }
      }
      if (displayed === 0) {
        this.log("新疆专区: 每月抽奖暂无可展示记录");
      }
    } catch (e) {
      this.log("新疆专区: 查询每月抽奖记录异常 " + e);
    }
  },

  async xj_monthly_draw_task(token) {
    this.log("新疆专区: 每月抽奖活动 " + XJ_ACTIVITY_ID);
    for (let i = 0; i < XJ_MONTHLY_DRAW_ATTEMPT_COUNT; i++) {
      const pair = await this.xj_monthly_draw_once(token);
      const status = pair[0], msg = pair[1];
      this.log(
        "新疆专区: 每月抽奖第" + (i + 1) + "次 - " + msg,
        status === "won"
      );
      if (["done", "won", "invalid"].indexOf(status) >= 0) {
        break;
      }
      await sleep(randFloat(1, 2) * 1000);
    }
    await this.xj_query_monthly_draw_records(token);
  },

  // ---------------- 河南商都 ----------------
  async shangdu_get_sign_status() {
    try {
      const url = "https://app.shangdu.com/monthlyBenefit/v1/signIn/queryCumulativeSignAxis";
      const headers = {
        "Origin": "https://app.shangdu.com",
        "Referer": "https://app.shangdu.com/monthlyBenefit/index.html",
        "edop_flag": "0", "Content-Type": "application/json"
      };
      const res = await (await this.httpPost(url, { json: {}, headers: headers })).json();
      const r = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
      if (r["code"] === "0000") {
        const rd = (r["data"] !== undefined && r["data"] !== null) ? r["data"] : {};
        return rd["todaySignFlag"] === "1";
      }
      return null;
    } catch (e) { return null; }
  },

  async shangdu_sign_retry() {
    try {
      const url = "https://app.shangdu.com/monthlyBenefit/v1/signIn/userSignIn";
      const headers = {
        "Origin": "https://app.shangdu.com",
        "Referer": "https://app.shangdu.com/monthlyBenefit/index.html",
        "edop_flag": "0", "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json"
      };
      const res = await (await this.httpPost(url, { json: {}, headers: headers })).json();
      const r = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
      const code = r["code"];
      const data = (r["data"] !== undefined && r["data"] !== null) ? r["data"] : {};
      if (code === "0000") {
        const pr = (data["prizeResp"] !== undefined && data["prizeResp"] !== null) ? data["prizeResp"] : {};
        const prize = pr["prizeName"];
        if (prize) this.log("河南商都: 签到成功(重试) - 获得 " + prize, true);
        else this.log("河南商都: 签到成功(重试)");
      } else if (code === "0019") {
        this.log("河南商都: 重试仍返回重复签到");
      } else {
        this.log("河南商都: A签到重试失败 - " + r["msg"]);
      }
    } catch (e) {
      this.log("河南商都: 签到重试异常 " + e);
    }
  },

  async shangdu_task_main() {
    if (!this.ecs_token) {
      this.log("河南商都: 缺少ecs_token，跳过");
      return;
    }
    const url = "https://m.client.10010.com/edop_ng/getTicketByNative?appId=edop_unicom_4b80047a&token=" + this.ecs_token;
    const res = await (await this.httpGet(url)).json();
    const r = (res["result"] !== undefined && res["result"] !== null) ? res["result"] : {};
    const ticket = r["ticket"];
    if (!ticket) {
      this.log("河南商都: 获取Ticket失败");
      return;
    }
    const login_url = "https://app.shangdu.com/monthlyBenefit/v1/common/config?ticket=" + ticket;
    const headers_login = {
      "Origin": "https://app.shangdu.com",
      "Referer": "https://app.shangdu.com/monthlyBenefit/index.html",
      "edop_flag": "0", "Accept": "application/json, text/plain, */*"
    };
    await this.httpGet(login_url, { headers: headers_login });
    await sleep(1.5 * 1000);
    const sign_url = "https://app.shangdu.com/monthlyBenefit/v1/signIn/userSignIn";
    const headers_sign = {
      "Origin": "https://app.shangdu.com",
      "Referer": "https://app.shangdu.com/monthlyBenefit/index.html",
      "edop_flag": "0", "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/json"
    };
    const res_sign = await (await this.httpPost(sign_url, { json: {}, headers: headers_sign })).json();
    const rs = (res_sign["result"] !== undefined && res_sign["result"] !== null) ? res_sign["result"] : {};
    const code = rs["code"];
    const data = (rs["data"] !== undefined && rs["data"] !== null) ? rs["data"] : {};
    if (code === "0000") {
      if (data["value"] === "0001") {
        this.log("河南商都: 签到失败 - Cookie无效");
      } else {
        const pr = (data["prizeResp"] !== undefined && data["prizeResp"] !== null) ? data["prizeResp"] : {};
        const prize = pr["prizeName"] || "已签到";
        this.log("河南商都: 签到结果 - " + prize, true);
      }
    } else if (code === "0019") {
      await sleep(1 * 1000);
      const is_signed = await this.shangdu_get_sign_status();
      if (is_signed === true) {
        this.log("河南商都: 今日已签到");
      } else if (is_signed === false) {
        this.log("河南商都: 状态未签到但返回重复，尝试重试...");
        await sleep(2 * 1000);
        await this.shangdu_sign_retry();
      } else {
        this.log("河南商都: 今日已签到 (状态未知)");
      }
    } else {
      this.log("河南商都: 签到失败 - " + code + " : " + rs["msg"]);
    }
  },

  // ---------------- 辽宁福利魔方 ----------------
  async ln_flmf_get_sid() {
    try {
      const ticket_res = await this.openPlatLineNew("https://weixin.linktech.hk/lv-web/handHall/autoLogin?actcode=sign");
      if (!ticket_res || !ticket_res["ticket"]) {
        this.log("辽宁福利魔方: 获取ticket失败");
        return null;
      }
      const ticket = ticket_res["ticket"];
      const type_val = (ticket_res["type"] !== undefined && ticket_res["type"] !== null) ? ticket_res["type"] : "06";
      const mobile = (this.account_mobile !== undefined) ? this.account_mobile : ((this.mobile !== undefined) ? this.mobile : "");
      // Python: datetime.now().strftime('%Y%m%d%H%M%S')（无毫秒；骨架 fmtYmdHms 会多带毫秒，故此处手写）
      const _d = new Date();
      const timestamp = _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()) + pad2(_d.getHours()) + pad2(_d.getMinutes()) + pad2(_d.getSeconds());
      const postage = md5(mobile + timestamp);
      const login_url = "https://weixin.linktech.hk/lv-web/handHall/autoLogin";
      const params = {
        "actcode": "sign",
        "type": type_val,
        "ticket": ticket,
        "version": COMMON_CONSTANTS["APP_VERSION"],
        "timestamp": timestamp,
        "desmobile": mobile,
        "num": "0",
        "postage": postage,
        "userNumber": mobile
      };
      const res = await this.httpGet(login_url, { params: params, allowRedirects: false, timeout: 15 });
      if (res.status !== 302 || !res.headers.get("Location")) {
        this.log("辽宁福利魔方: autoLogin期望302, 实际" + res.status);
        return null;
      }
      const loc = res.headers.get("Location");
      // 方法内局部函数（非全局）：对应 Python 的 parse_qs（值为数组）
      const parseQuery = (qs) => {
        const out = {};
        String(qs).replace(/^\?/, "").split("&").forEach((pair) => {
          if (!pair) return;
          const i = pair.indexOf("=");
          const k = decodeURIComponent(i >= 0 ? pair.slice(0, i) : pair);
          const v = decodeURIComponent(i >= 0 ? pair.slice(i + 1) : "");
          (out[k] = out[k] || []).push(v);
        });
        return out;
      };
      let sid;
      const sid_match = loc.match(/sid[=%]3[Dd]?([a-f0-9]{32})/);
      if (!sid_match) {
        const parsed = new URL(decodeURIComponent(loc));
        const qs = parseQuery(parsed.search);
        const params_val = (qs["params"] || [""])[0];
        if (params_val.includes("sid=")) {
          const inner_qs = parseQuery(params_val);
          sid = (inner_qs["sid"] || [""])[0];
        } else {
          sid = (qs["sid"] || [""])[0];
        }
      } else {
        sid = sid_match[1];
      }
      if (sid && sid.length === 32) {
        this.log("辽宁福利魔方: 获取sid成功 (" + sid.slice(0, 8) + "...)");
        return sid;
      }
      this.log("辽宁福利魔方: 重定向中未找到sid");
    } catch (e) {
      this.log("辽宁福利魔方: 获取sid异常 - " + e);
    }
    return null;
  },

  async ln_flmf_api(sid, endpoint, extra_data) {
    const url = "https://weixin.linktech.hk/lv-apiaccess/welfareCenter/" + endpoint;
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://weixin.linktech.hk",
      "Referer": "https://weixin.linktech.hk/app/flmf/LV-202111-04/moreShatter?sid=" + sid + "&actcode=welfareCenter",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36; unicom{version:android@11.0802}"
    };
    let data = "sid=" + sid + "&actcode=welfareCenter";
    if (extra_data) {
      data += "&" + extra_data;
    }
    try {
      const res = await (await this.httpPost(url, { headers: headers, data: data, timeout: 15 })).json();
      return res;
    } catch (e) {
      this.log("辽宁福利魔方: " + endpoint + " 请求异常 - " + e);
      return null;
    }
  },

  async ln_flmf_task(is_query_only) {
    if (is_query_only === undefined) is_query_only = false;
    const sid = await this.ln_flmf_get_sid();
    if (!sid) {
      return;
    }
    const res = await this.ln_flmf_api(sid, "addUser");
    if (!res || res["resultCode"] !== "0000") {
      this.log("辽宁福利魔方: 用户初始化失败 - " + (((res || {})["resultMsg"] !== undefined && (res || {})["resultMsg"] !== null) ? (res || {})["resultMsg"] : "无响应"));
      return;
    }
    await sleep(1 * 1000);
    const init_res = await this.ln_flmf_api(sid, "signInInit");
    if (init_res && init_res["resultCode"] === "0000") {
      const init_data = (init_res["data"] !== undefined && init_res["data"] !== null) ? init_res["data"] : {};
      const is_signed = (init_data["isSigned"] !== undefined && init_data["isSigned"] !== null) ? init_data["isSigned"] : 0;
      const consecutive = (init_data["consecutiveDays"] !== undefined && init_data["consecutiveDays"] !== null) ? init_data["consecutiveDays"] : 0;
      if (is_signed) {
        this.log("辽宁福利魔方: 今日已签到 (连续" + consecutive + "天)");
      } else if (is_query_only) {
        this.log("辽宁福利魔方: 今日未签到 (连续" + consecutive + "天)");
      } else {
        await sleep(1 * 1000);
        const sign_res = await this.ln_flmf_api(sid, "signIn");
        if (sign_res && sign_res["resultCode"] === "0000") {
          this.log("辽宁福利魔方: ✅ 签到成功 (连续" + (consecutive + 1) + "天)", true);
        } else {
          this.log("辽宁福利魔方: 签到失败 - " + (((sign_res || {})["resultMsg"] !== undefined && (sign_res || {})["resultMsg"] !== null) ? (sign_res || {})["resultMsg"] : "无响应"));
        }
      }
    } else {
      this.log("辽宁福利魔方: 查询签到状态失败 - " + (((init_res || {})["resultMsg"] !== undefined && (init_res || {})["resultMsg"] !== null) ? (init_res || {})["resultMsg"] : "无响应"));
    }
    await sleep(1 * 1000);
    const info_res = await this.ln_flmf_api(sid, "getUserInfo");
    if (info_res && info_res["resultCode"] === "0000") {
      const info = (info_res["data"] !== undefined && info_res["data"] !== null) ? info_res["data"] : {};
      const wobi = (info["woBi"] !== undefined && info["woBi"] !== null) ? info["woBi"] : 0;
      const sign_times = (info["signTimes"] !== undefined && info["signTimes"] !== null) ? info["signTimes"] : 0;
      const member_wobi = (info["memberwobi"] !== undefined && info["memberwobi"] !== null) ? info["memberwobi"] : 0;
      const member_trun = (info["membertrun"] !== undefined && info["membertrun"] !== null) ? info["membertrun"] : 0;
      const rights_num = (info["rightsNum"] !== undefined && info["rightsNum"] !== null) ? info["rightsNum"] : "0";
      this.log("辽宁福利魔方: 沃币" + wobi + " | 累计签到" + sign_times + "天 | 会员碎片" + member_wobi + " | 等级" + member_trun + " | 权益" + rights_num + "次", true);
    }
    if (is_query_only) {
      return;
    }
    await sleep(1 * 1000);
    const task_res = await this.ln_flmf_api(sid, "taskList", "refresh=0&nowTask=");
    if (task_res && task_res["resultCode"] === "0000") {
      const task_data = (task_res["data"] !== undefined && task_res["data"] !== null) ? task_res["data"] : {};
      const groups = (task_data["taskInfoList"] !== undefined && task_data["taskInfoList"] !== null) ? task_data["taskInfoList"] : [];
      for (const group of groups) {
        const tasks = (group["taskInfoList"] !== undefined && group["taskInfoList"] !== null) ? group["taskInfoList"] : [];
        for (const t of tasks) {
          const t_done = (t["done"] !== undefined && t["done"] !== null) ? t["done"] : 0;
          const t_count = (t["count"] !== undefined && t["count"] !== null) ? t["count"] : 0;
          const status = t_done > 0 ? "✅" : "⏳";
          this.log("辽宁福利魔方: " + status + " " + t["taskName"] + " (" + t_done + "/" + t_count + ")");
        }
      }
    }
  },

  // ---------------- 安徽超级星期五 ----------------
  async ah_friday_get_entry() {
    try {
      const entry_url = AH_FRIDAY_BASE_URL + "/wxopen/hh/activity/superFriday/index?chnlId=app-ty&type=02";
      const ticket_res = await this.openPlatLineNew(entry_url);
      if (!ticket_res || !ticket_res["ticket"]) {
        this.log("安徽超级星期五: 获取入口ticket失败");
        return null;
      }
      const ticket = ticket_res["ticket"];
      const mobile = (this.account_mobile !== undefined) ? this.account_mobile : ((this.mobile !== undefined) ? this.mobile : "");
      // Python: datetime.now().strftime('%Y%m%d%H%M%S')（无毫秒；骨架 fmtYmdHms 会多带毫秒，故此处手写）
      const _d = new Date();
      const timestamp = _d.getFullYear() + pad2(_d.getMonth() + 1) + pad2(_d.getDate()) + pad2(_d.getHours()) + pad2(_d.getMinutes()) + pad2(_d.getSeconds());
      const postage = md5(mobile + timestamp);
      const page_url = AH_FRIDAY_BASE_URL + "/wxopen/hh/activity/superFriday/index";
      const params = {
        "chnlId": "app-ty",
        "type": "02",
        "ticket": ticket,
        "version": COMMON_CONSTANTS["APP_VERSION"],
        "timestamp": timestamp,
        "desmobile": mobile,
        "num": "0",
        "postage": postage,
        "userNumber": mobile
      };
      const headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": COMMON_CONSTANTS["UA"],
      };
      const res = await this.httpGet(page_url, { params: params, headers: headers, timeout: 15 });
      // TODO(PY-6220): Python 版依次查 res.cookies → history 各跳 Set-Cookie → session.cookies → 最终响应头 → 响应体正文。
      // Egern 骨架的 EgernSession 在重定向链中已把全部 Set-Cookie 并入 jar，无 history 暴露；jar 检查即覆盖前三者。
      let act_ticket = this.session.getCookieDict()["ticket"] || "";
      if (!act_ticket) {
        const cookie_header = res.headers.get("Set-Cookie") || "";
        const m = cookie_header.match(/ticket=([^;,\s]+)/);
        if (m) {
          act_ticket = m[1];
        }
      }
      if (!act_ticket) {
        const body = await res.text();
        const m2 = body.match(/ticket[=:]\s*["']?([a-zA-Z0-9_-]{8,})/);
        if (m2) {
          act_ticket = m2[1];
        }
      }
      if (!act_ticket) {
        this.log("安徽超级星期五: 页面未返回独立ticket，使用入口ticket兜底");
        act_ticket = ticket;
      }
      this.log("安徽超级星期五: 获取活动ticket成功 (" + act_ticket.slice(0, 12) + "...)");
      return {
        "ticket": act_ticket,
        "mobile": mobile,
        "timestamp": timestamp,
        "postage": postage,
        "app_ticket": ticket,
      };
    } catch (e) {
      this.log("安徽超级星期五: 获取入口异常 - " + e);
      return null;
    }
  },

  async ah_friday_get_items(entry_info) {
    try {
      const url = AH_FRIDAY_BASE_URL + "/wxopen/app-activity/AHSecKill/querySecKillInfo";
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": AH_FRIDAY_BASE_URL,
        "Cookie": "ticket=" + entry_info["ticket"],
        "User-Agent": COMMON_CONSTANTS["UA"],
      };
      const res = await this.httpPost(url, { json: {}, headers: headers, timeout: 10 });
      const result = await res.json();
      if (!result["success"] && !result["data"]) {
        this.log("安徽超级星期五: 查询奖品列表失败 - " + ((result["alertMsg"] !== undefined && result["alertMsg"] !== null) ? result["alertMsg"] : "未知"));
        return null;
      }
      const _data = (result["data"] !== undefined && result["data"] !== null) ? result["data"] : {};
      let items;
      if (isObj(_data)) {
        items = (_data["itemList"] !== undefined && _data["itemList"] !== null) ? _data["itemList"] : [];
      } else {
        // TODO(PY-6272): Python 原代码 result.get('data', {}).get('itemList', []) 在 data 为 list 时抛
        // AttributeError，直接走 except 返回默认 itemCode（其后的 isinstance 兜底是死代码）。此处抛错以复刻该行为。
        throw new Error("'list' object has no attribute 'get'");
      }
      if (!items || items.length === 0) {
        items = Array.isArray(result["data"]) ? result["data"] : [];
      }
      const target_amount = String(AH_FRIDAY_AMOUNT);
      for (const item of items) {
        const item_code = (item["itemCode"] !== undefined && item["itemCode"] !== null) ? item["itemCode"] : "";
        const item_name = (item["itemName"] !== undefined && item["itemName"] !== null) ? item["itemName"] : "";
        if (item_name.includes(target_amount) || item_code.includes("hb" + target_amount)) {
          const key_val = (item["key"] !== undefined && item["key"] !== null) ? item["key"] : "";
          this.log("安徽超级星期五: 匹配到目标 [" + item_name + "] (code: " + item_code + ")");
          return {
            "itemCode": item_code,
            "itemName": item_name,
            "key": key_val,
          };
        }
      }
      const item_code = "AWARD_AHFridaySecKill_10_hb" + target_amount;
      this.log("安徽超级星期五: 未从列表匹配到" + target_amount + "元, 使用默认itemCode: " + item_code);
      return { "itemCode": item_code, "itemName": target_amount + "元红包", "key": "" };
    } catch (e) {
      this.log("安徽超级星期五: 查询奖品异常 - " + e);
      const item_code = "AWARD_AHFridaySecKill_10_hb" + AH_FRIDAY_AMOUNT;
      return { "itemCode": item_code, "itemName": AH_FRIDAY_AMOUNT + "元红包", "key": "" };
    }
  },

  async ah_friday_seckill(entry_info, item_info) {
    const ticket = entry_info["ticket"];
    const item_code = item_info["itemCode"];
    const key_val = (item_info["key"] !== undefined && item_info["key"] !== null) ? item_info["key"] : "";
    const mobile = entry_info["mobile"];
    const timestamp_str = entry_info["timestamp"];
    const postage = entry_info["postage"];
    const referer = (
      AH_FRIDAY_BASE_URL + "/wxopen/hh/activity/superFriday/index" +
      "?chnlId=app-ty&type=02&ticket=" + entry_info["app_ticket"] +
      "&version=" + COMMON_CONSTANTS["APP_VERSION"] + "&timestamp=" + timestamp_str +
      "&desmobile=" + mobile + "&num=0&postage=" + postage + "&userNumber=" + mobile
    );
    let success_count = 0;
    let fail_count = 0;
    this.log("安徽超级星期五: 开始批量抢购 [" + item_info["itemName"] + "]，共" + AH_FRIDAY_SECKILL_TIMES + "次");
    for (let i = 1; i <= AH_FRIDAY_SECKILL_TIMES; i++) {
      try {
        const ts = String(Date.now());
        const params = {
          "ticket": ticket,
          "itemCode": item_code,
          "time": ts,
        };
        if (key_val) {
          params["key"] = key_val;
        }
        const url = AH_FRIDAY_BASE_URL + "/wxopen/app-activity/AHSecKill/lotteryAction";
        const headers = {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Origin": AH_FRIDAY_BASE_URL,
          "Referer": referer,
          "Cookie": "ticket=" + ticket,
          "User-Agent": COMMON_CONSTANTS["UA"],
          "Connection": "keep-alive",
        };
        const res = await this.httpPost(url, { params: params, json: {}, headers: headers, timeout: 5 });
        const data = await res.json();
        if (data["success"]) {
          success_count += 1;
          this.log("安徽超级星期五: 🎉 第" + i + "次抢购成功！" + JSON.stringify(data), true);
          return true;
        } else {
          fail_count += 1;
          const alert = (data["alertMsg"] !== undefined && data["alertMsg"] !== null) ? data["alertMsg"] : "";
          if (i <= 3 || i % 20 === 0) {
            this.log("安徽超级星期五: 第" + i + "次 - " + (alert || ((data["statusCode"] !== undefined && data["statusCode"] !== null) ? data["statusCode"] : "未知")));
          }
          if (alert.includes("已抢完") || alert.includes("已结束") || alert.includes("已领取")) {
            this.log("安徽超级星期五: ⚠️ " + alert + "，停止抢购");
            break;
          }
        }
      } catch (e) {
        fail_count += 1;
        if (i <= 3) {
          this.log("安徽超级星期五: 第" + i + "次异常 - " + e);
        }
      }
      if (i < AH_FRIDAY_SECKILL_TIMES) {
        await sleep(AH_FRIDAY_INTERVAL * 1000);
      }
    }
    this.log("安徽超级星期五: 抢购完成 (共" + AH_FRIDAY_SECKILL_TIMES + "次, 失败" + fail_count + "次)", true);
    return false;
  },

  async ah_friday_task() {
    if (!AH_FRIDAY_AMOUNT) {
      return;
    }
    const rc = globalConfig.regional_config || {};
    const run_ah_friday = (rc["run_ah_friday"] !== undefined && rc["run_ah_friday"] !== null) ? rc["run_ah_friday"] : true;
    if (!run_ah_friday) {
      this.log("安徽超级星期五: ⏭️ 已被子开关关闭，跳过");
      return;
    }
    // Python weekday(): 周一=0..周日=6；JS getDay(): 周日=0..周六=6
    const weekday = (new Date().getDay() + 6) % 7;
    if (weekday !== 4) {
      this.log("安徽超级星期五: 今天不是周五 (当前周" + (weekday + 1) + ")，跳过");
      return;
    }
    this.log("安徽超级星期五: 🎯 目标面额 " + AH_FRIDAY_AMOUNT + "元");
    const entry_info = await this.ah_friday_get_entry();
    if (!entry_info) {
      return;
    }
    const item_info = await this.ah_friday_get_items(entry_info);
    if (!item_info) {
      return;
    }
    const now = new Date();
    const target = new Date(now);
    target.setHours(10, 0, 0, 0);
    const wait_seconds = (target.getTime() - now.getTime()) / 1000;
    if (wait_seconds > 300) {
      this.log("安徽超级星期五: ⏳ 距10:00还有 " + wait_seconds.toFixed(0) + "秒，大于5分钟，建议临近时启动");
      return;
    }
    if (wait_seconds > 0) {
      this.log("安徽超级星期五: ⏳ 等待开抢 (剩余 " + wait_seconds.toFixed(1) + "秒)...");
      const at10 = () => { const t = new Date(); t.setHours(10, 0, 0, 0); return t.getTime(); };
      while ((at10() - Date.now()) / 1000 > 0.3) {
        await sleep(0.1 * 1000);
      }
      this.log("安徽超级星期五: ⚡ 时间到！开始抢购！");
    } else {
      this.log("安徽超级星期五: ⚡ 已过10点 " + Math.abs(wait_seconds).toFixed(1) + "秒，直接抢购！");
    }
    await this.ah_friday_seckill(entry_info, item_info);
  },
});
// Part 12: 联通阅读 + 主流程（对应 Python 19705.py 6388-7124 行）
// 包含：woread_*（8 个）、query_market_raffle_records、query_phone_recharge_records、
// execute_daily_tasks；模块级：cross_view_security_share_keys、do_notify、egernMain
// 注意：sign_task_main / sign_query_my_prizes 已在 part02_sign.js 中，不在此重复。

// do_notify 组装的推送正文（由最终 export 入口调用 ctx.notify 发送）
var notifyBody = "";

// Python: datetime.now().strftime('%Y%m%d%H%M%S')（14 位，无毫秒）

Object.assign(UserService.prototype, {
  // ---- 联通阅读 ----
  async woread_encrypt(data) {
    try {
      const key = utf8Bytes(WOREAD_KEY); // b'woreadst^&*12345'
      const iv = utf8Bytes("16-Bytes--String");
      let dataStr;
      if (isObj(data)) {
        dataStr = JSON.stringify(data); // separators=(',',':'), ensure_ascii=False
      } else {
        dataStr = String(data);
      }
      // Python 手动 PKCS7：pad_len = 16 - (len % 16)，恒补齐（含整块补 16）
      const padded = pkcs7Pad(utf8Bytes(dataStr));
      const ciphertext = aesCbcEncrypt(padded, key, iv);
      const hexStr = bytesToHex(ciphertext);
      return b64encode(utf8Bytes(hexStr));
    } catch (e) {
      this.log(`woread_encrypt error: ${e}`);
      return "";
    }
  },

  async woread_auth() {
    try {
      const product_id = "10000002";
      const secret_key = "7k1HcDL8RKvc";
      const timestamp = String(Math.round(Date.now()));
      const sign_str = `${product_id}${secret_key}${timestamp}`;
      const md5_hash = md5(sign_str);
      const date_str = fmtYmdHms14(new Date());
      const crypt_text_obj = { timestamp: date_str };
      const encoded_sign = await this.woread_encrypt(crypt_text_obj);
      const url = `https://10010.woread.com.cn/ng_woread_service/rest/app/auth/${product_id}/${timestamp}/${md5_hash}`;
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": COMMON_CONSTANTS.UA,
      };
      const res = await (await this.httpPost(url, { json: { sign: encoded_sign }, headers: headers })).json();
      if (res.code === "0000") {
        this.woread_accesstoken = (res.data || {}).accesstoken;
        return true;
      } else {
        this.log(`阅读专区认证失败: ${res.message}`);
        return false;
      }
    } catch (e) {
      this.log(`woread_auth error: ${e}`);
      return false;
    }
  },

  async woread_login() {
    try {
      if (!this.woread_accesstoken) {
        if (!await this.woread_auth()) {
          return false;
        }
      }
      if (!this.token_online) {
        this.log("阅读专区: 缺少 token_online，无法登录");
        return false;
      }
      const token_enc = await this.woread_encrypt(this.token_online);
      const phone_str = this.account_mobile ? this.account_mobile : "13800000000";
      const phone_enc = await this.woread_encrypt(phone_str);
      const timestamp = fmtYmdHms14(new Date());
      const inner_json = JSON.stringify({
        tokenOnline: token_enc,
        phone: phone_enc,
        timestamp: timestamp
      });
      const encoded_sign = await this.woread_encrypt(inner_json);
      const url = "https://10010.woread.com.cn/ng_woread_service/rest/account/login";
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": COMMON_CONSTANTS.UA,
      };
      if (this.woread_accesstoken) {
        headers["accesstoken"] = this.woread_accesstoken;
      }
      const res = await (await this.httpPost(url, { json: { sign: encoded_sign }, headers: headers, timeout: 15 })).json();
      if (res.code === "0000") {
        const data = res.data || {};
        this.woread_token = data.token;
        this.woread_userid = data.userid;
        this.woread_userindex = data.userindex;
        this.woread_verifycode = data.verifycode;
        if (data.phone) {
          this.mobile = data.phone;
        }
        this.log("阅读专区: 登录成功");
        return true;
      } else {
        this.log(`阅读专区登录失败: ${res.message}`);
        return false;
      }
    } catch (e) {
      this.log(`woread_login error: ${e}`);
      return false;
    }
  },

  async woread_queryTicketAccount() {
    try {
      if (!this.woread_token) {
        if (!await this.woread_login()) {
          return;
        }
      }
      const timestamp = fmtYmdHms14(new Date());
      const params = {
        timestamp: timestamp,
        phone: this.mobile ? this.mobile : "",
        token: this.woread_token
      };
      const sign = await this.woread_encrypt(params);
      const url = "https://10010.woread.com.cn/ng_woread_service/rest/phone/vouchers/queryTicketAccount";
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": COMMON_CONSTANTS.UA,
      };
      if (this.woread_accesstoken) {
        headers["accesstoken"] = this.woread_accesstoken;
      }
      const res = await (await this.httpPost(url, { json: { sign: sign }, headers: headers })).json();
      if (res.code === "0000") {
        const data = res.data || {};
        const usable_num = safeInt(data.usableNum, 0);
        const balance_yuan = (usable_num / 100).toFixed(2);
        this.log(`💰 [资产-阅读红包] 余额: ${balance_yuan}元`, true);
      } else {
        this.log(`阅读红包查询失败: ${res.message}`);
      }
    } catch (e) {
      this.log(`woread_queryTicketAccount error: ${e}`);
    }
  },

  async woread_get_book_info() {
    try {
      const url1 = "https://10010.woread.com.cn/ng_woread_service/rest/basics/recommposdetail/14856";
      const headers = {
        "User-Agent": COMMON_CONSTANTS.UA,
        "accesstoken": this.woread_accesstoken
      };
      const res1raw = await this.httpGet(url1, { headers: headers });
      let res1;
      try {
        res1 = await res1raw.json();
      } catch (e) {
        this.log(`阅读专区: 获取书架响应非JSON: ${(await res1raw.text()).slice(0, 100)}`);
        return false;
      }
      if (res1.code === "0000") {
        const msg_list = ((res1.data || {}).booklist || {}).message || [];
        if (msg_list.length) {
          this.wr_catid = msg_list[0].catindex;
          this.wr_cntindex = msg_list[0].cntindex;
        }
        const bind_info = (res1.data || {}).bindinfo || [];
        if (bind_info.length) {
          this.wr_cardid = bind_info[0].recommposiindex;
        }
      } else {
        this.log("阅读专区: 获取书架失败");
        return false;
      }
      if (!this.wr_cntindex) return false;
      const timestamp = fmtYmdHms14(new Date());
      const param = {
        curPage: 1, limit: 30, index: this.wr_cntindex, sort: 0, finishFlag: 1,
        timestamp: timestamp,
        phone: this.mobile ? this.mobile : "",
        token: this.woread_token || "",
        userid: this.woread_userid || "",
        userId: this.woread_userid || "",
        userIndex: this.woread_userindex || "",
        verifyCode: this.woread_verifycode || ""
      };
      const sign = await this.woread_encrypt(param);
      const url2 = "https://10010.woread.com.cn/ng_woread_service/rest/cnt/chalist";
      const res2_raw = await this.httpPost(url2, { json: { sign: sign }, headers: headers });
      let res2;
      try {
        res2 = await res2_raw.json();
      } catch (e) {
        this.log(`阅读专区: 获取章节响应非JSON: ${(await res2_raw.text()).slice(0, 100)}`);
        return false;
      }
      let lst = res2.list || [];
      if (!lst.length) lst = (res2.data || {}).list || [];
      if (lst.length) {
        const content = lst[0].charptercontent || [];
        if (content.length) {
          this.wr_chapterallindex = content[0].chapterallindex;
          this.wr_chapterid = content[0].chapterid;
          return true;
        }
      }
      return false;
    } catch (e) {
      this.log(`阅读专区: 获取书籍信息异常: ${e}`);
      return false;
    }
  },

  async woread_read_process() {
    if (!await this.woread_get_book_info()) {
      this.log("阅读专区: 无法获取书籍信息，跳过阅读");
      return;
    }
    const headers = {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301}",
      "accesstoken": this.woread_accesstoken
    };
    const timestamp = fmtYmdHms14(new Date());
    const phone = this.mobile ? this.mobile : "";
    const token = this.woread_token;
    const userid = this.woread_userid || "";
    const userindex = this.woread_userindex || "";
    const verifycode = this.woread_verifycode || "";
    const common_params = {
      timestamp: timestamp,
      phone: phone,
      token: token,
      userid: userid,
      userId: userid,
      userIndex: userindex,
      userAccount: phone,
      verifyCode: verifycode
    };
    const param = Object.assign({
      chapterAllIndex: this.wr_chapterallindex,
      cntIndex: this.wr_cntindex,
      cntTypeFlag: "1"
    }, common_params);
    const sign = await this.woread_encrypt(param);
    const hb_url = `https://10010.woread.com.cn/ng_woread_service/rest/cnt/wordsDetail?catid=${this.wr_catid}&cardid=${this.wr_cardid}&cntindex=${this.wr_cntindex}&chapterallindex=${this.wr_chapterallindex}&chapterseno=1`;
    await this.httpPost(hb_url, { json: { sign: sign }, headers: headers });
    const add_param = Object.assign({
      readTime: "2",
      cntIndex: this.wr_cntindex,
      cntType: "1",
      catid: "0",
      pageIndex: "",
      cardid: this.wr_cardid,
      cntindex: this.wr_cntindex,
      cnttype: "1",
      chapterallindex: this.wr_chapterallindex,
      chapterseno: "1",
      channelid: "",
      chapterid: this.wr_chapterid,
      readtype: 1,
      isend: "0"
    }, common_params);
    const add_sign = await this.woread_encrypt(add_param);
    const add_url = "https://10010.woread.com.cn/ng_woread_service/rest/history/addReadTime";
    const res = await (await this.httpPost(add_url, { json: { sign: add_sign }, headers: headers })).json();
    const res_code = String(res.code !== undefined && res.code !== null ? res.code : "");
    const res_msg = String(res.message !== undefined && res.message !== null ? res.message : "");
    if (res_code === "0000") {
      this.log("阅读专区: 模拟阅读成功");
    } else if (res_code === "9999" || res_msg.includes("9999") || res_msg.includes("不存在阅读记录")) {
      // addReadTime 返回9999不影响实际阅读结果
      this.log("阅读专区: 模拟阅读成功（阅读记录已提交）");
    } else {
      this.log(`阅读专区: 模拟阅读失败: ${res_msg || JSON.stringify(res)}`);
    }
  },

  async woread_draw_new() {
    try {
      const headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@12.0301}",
        "accesstoken": this.woread_accesstoken
      };
      const timestamp = fmtYmdHms14(new Date());
      const param = {
        activeindex: "8051",
        timestamp: timestamp, phone: this.mobile ? this.mobile : "", token: this.woread_token
      };
      const sign = await this.woread_encrypt(param);
      const url = "https://10010.woread.com.cn/ng_woread_service/rest/basics/doDraw";
      const res = await (await this.httpPost(url, { json: { sign: sign }, headers: headers })).json();
      if (res.code === "0000") {
        const prize = (res.data || {}).prizedesc;
        if (prize) {
          this.log(`阅读专区: 抽奖成功: ${prize}`, true);
        } else {
          this.log("阅读专区: 抽奖完成 (未中奖)");
        }
      } else {
        this.log(`阅读专区: 抽奖失败: ${res.message}`);
      }
    } catch (e) {
      this.log(`woread_draw_new error: ${e}`);
    }
  },

  async woread_task() {
    this.log("==== 联通阅读 ====");
    if (!await this.woread_login()) {
      this.log("阅读专区: 登录失败，跳过任务");
      return;
    }
    await this.woread_queryTicketAccount();
    await this.woread_read_process();
    await sleep(3 * 1000);
    await this.woread_draw_new();
  },

  // ---- 权益超市查询 helper（P4 market 模块依赖） ----
  async query_market_raffle_records(user_token) {
    this.log("权益超市: 正在查询抽奖记录...");
    try {
      const url = "https://backward.bol.wo.cn/prod-api/market/contactReceive/queryReceiveRecord";
      const headers = {
        "Authorization": `Bearer ${user_token}`,
        "User-Agent": COMMON_CONSTANTS.MARKET_UA,
        "Origin": "https://contact.bol.wo.cn",
        "Referer": "https://contact.bol.wo.cn/"
      };
      const mobile = this.account_mobile || this.mobile || "";
      const payload = {
        isReceive: null,
        receiveStatus: null,
        limit: 20,
        page: 1,
        mobile: mobile,
        businessSources: ["3", "4", "5", "6", "99"],
        isPromotion: 1,
        returnFormatType: 1
      };
      const res = await (await this.httpPost(url, { json: payload, headers: headers })).json();
      if (res.code === 200) {
        const records = (res.data || {}).recordObjs || [];
        if (records.length) {
          const display_records = records.slice(0, 10);
          this.log(`权益超市: 最近 ${display_records.length} 条抽奖记录:`, true);
          for (const item of display_records) {
            this.log(`    - [${item.receiveTime || ""}] ${item.recordName}`, true);
          }
        } else {
          this.log("权益超市: 无近期抽奖记录。");
        }
      } else {
        this.log(`权益超市: 查询抽奖记录失败: ${res.msg}`);
      }
    } catch (e) {
      this.log(`query_market_raffle_records error: ${e}`);
    }
  },

  async query_phone_recharge_records(user_token) {
    this.log("权益超市: 正在查询本月话费抢购记录...");
    try {
      const url = "https://backward.bol.wo.cn/prod-api/market/contactReceive/queryReceiveRecord";
      const headers = {
        "Authorization": `Bearer ${user_token}`,
        "User-Agent": COMMON_CONSTANTS.MARKET_UA,
        "Origin": "https://contact.bol.wo.cn",
        "Referer": "https://contact.bol.wo.cn/"
      };
      const mobile = this.account_mobile || this.mobile || "";
      const payload = {
        isReceive: null,
        receiveStatus: null,
        limit: 50,
        page: 1,
        mobile: mobile,
        businessSources: ["3", "4", "5", "6", "99"],
        isPromotion: 1,
        returnFormatType: 1
      };
      const res = await (await this.httpPost(url, { json: payload, headers: headers })).json();
      if (res.code === 200) {
        const records = (res.data || {}).recordObjs || [];
        let total_amount = 0.0;
        const nowD = new Date();
        const current_month = nowD.getFullYear() + "-" + pad2(nowD.getMonth() + 1);
        let count = 0;
        for (const item of records) {
          const create_time = item.receiveTime || "";
          const name = item.recordName || "";
          if (!create_time || !create_time.includes(current_month)) {
            continue;
          }
          if (["话费", "充值", "红包"].some(k => name.includes(k))) {
            const match = name.match(/(\d+(\.\d+)?)元/);
            if (match) {
              const amount = parseFloat(match[1]);
              total_amount += amount;
              count += 1;
            }
          }
        }
        if (count > 0) {
          this.log(`💰 [资产-抢购] 本月权益超市话费累计: ${total_amount.toFixed(2)}元`, true);
        } else {
          this.log("权益超市: 本月暂无话费抢购记录");
        }
      } else {
        this.log(`权益超市: 查询话费记录失败: ${res.msg}`);
      }
    } catch (e) {
      this.log(`query_phone_recharge_records error: ${e}`);
    }
  },

  // ---- 主流程 ----
  async execute_daily_tasks(query_only) {
    query_only = !!query_only;
    if (query_only) {
      this.log("📋 [查询模式] 仅查询资产，跳过任务执行", true);
      try {
        await this.queryRemain();
        if (globalConfig.enable_sign) {
          try {
            await this.sign_getContinuous(true);
            await this.sign_getTelephone();
          } catch (e) {
            this.log(`首页签到查询异常: ${e}`);
          }
          try {
            await this.sign_query_my_prizes();
          } catch (e) {
            this.log(`抢兑记录查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_ttlxj) {
          try {
            await this.ttlxj_task(true);
          } catch (e) {
            this.log(`天天领现金查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_ttxc) {
          try {
            await this.ttxc_task(true);
          } catch (e) {
            this.log(`通通乡村查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_market) {
          try {
            await this.market_task(true);
          } catch (e) {
            this.log(`权益超市查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_woread) {
          try {
            await this.woread_queryTicketAccount();
          } catch (e) {
            this.log(`联通阅读查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_aiting) {
          try {
            await this.aiting_task(true);
          } catch (e) {
            this.log(`联通爱听查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_security) {
          try {
            await this.securityButlerTask(true);
          } catch (e) {
            this.log(`安全管家查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_ltyp) {
          try {
            await this.ltyp_task(true);
          } catch (e) {
            this.log(`联通云盘查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_wostore) {
          try {
            await this.wostore_cloud_task(true);
          } catch (e) {
            this.log(`沃云手机查询异常: ${e}`);
          }
        }
        if (globalConfig.enable_regional) {
          try {
            await this.regional_task(true);
          } catch (e) {}
        }
      } catch (e) {
        this.log(`查询异常: ${e}`);
      }
      return;
    }
    if (globalConfig.enable_sign) {
      await this.sign_task_main();
    } else {
      this.log("==== 签到区 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_ltzf) {
      await this.ltzf_task();
    } else {
      this.log("==== 联通祝福 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_ttlxj) {
      await this.ttlxj_task();
    } else {
      this.log("==== 天天领现金 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_ttxc) {
      await this.ttxc_task();
    } else {
      this.log("==== 通通乡村 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_market) {
      await this.market_task();
    } else {
      this.log("==== 权益超市 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_woread) {
      await this.woread_task();
    } else {
      this.log("==== 联通阅读 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    const need_cooldown = globalConfig.enable_woread && globalConfig.enable_aiting;
    if (need_cooldown) {
      this.log("⏳ 等待120秒（阅读冷却：联通限制两次阅读间隔2分钟）...");
      await sleep(120 * 1000);
    }
    if (globalConfig.enable_aiting) {
      await this.aiting_task();
    } else {
      this.log("==== 联通爱听 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_security) {
      await this.securityButlerTask();
    } else {
      this.log("==== 安全管家 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_ltyp) {
      await this.ltyp_task();
    } else {
      this.log("==== 联通云盘 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_wostore) {
      await this.wostore_cloud_task();
    } else {
      this.log("==== 沃云手机 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
    if (globalConfig.enable_regional) {
      await this.regional_task();
    } else {
      this.log("==== 区域专区 ====");
      this.log("⏭️ 已被总开关关闭，跳过");
    }
  },
});

// ---------------- 模块级函数 ----------------

async function cross_view_security_share_keys(users) {
const participants = users.filter(u => u.sec_ai_share_key && u.sec_token && u.sec_share_task_code);
if (!participants.length) {
return;
}
if (participants.length < 2) {
participants[0].log("联通助理-分享AI助手对话：仅 1 个账号拿到分享key，跳过跨账号互看");
return;
}
blog("");
blog("========= 联通助理-开始跨账号查看AI分享对话 =========");
const n = participants.length;
for (let i = 0; i < n; i++) {
const viewer = participants[i];
const target = participants[(i + 1) % n];
viewer.log(`联通助理-分享AI助手对话：查看账号[${target.index}]分享`);
try {
await viewer.sec_view_share_detail(target.sec_ai_share_key, viewer.sec_token);
} catch (e) {
viewer.log(`联通助理-分享AI助手对话：互看异常 ${e}`);
}
await sleep(2 * 1000);
}
for (const u of participants) {
try {
await u.sec_refresh_security_context(false);
await u.sec_finalize_share_ai_task();
await u.sec_recover_pending_claims(2, 6, true);
} catch (e) {
u.log(`联通助理-分享AI助手对话：互看后领奖异常 ${e}`);
}
}
}

async function do_notify(users) {
// Egern 版：把通知内容拼好存入全局 notifyBody，由最终 export 入口调用 ctx.notify 发送
const notify_content = [];
for (const u of users) {
if (u.notifyLogs && u.notifyLogs.length) {
const phone = u.mobile || u.account_mobile;
const phone_str = phone? mask_str(phone): "";
notify_content.push(`${phone_str}`);
for (const line of u.notifyLogs) notify_content.push(line);
notify_content.push("");
}
}
if (notify_content.length) {
notifyBody = notify_content.join("\n");
blog(`推送内容已组装 (内容长度: ${notifyBody.length})，等待 export 入口发送`);
} else {
blog("无推送内容");
}
}

async function egernMain(ctx) {
blog(`[${fmtTime()}] [Script Start] chinaUnicom Python v1.0.8`);
const cookies = env("UNICOM_COOKIE", "");
if (!cookies) {
blog("[-] 未在环境变量 UNICOM_COOKIE 中找到配置");
return;
}
const accounts = String(cookies).split(/[&\n]/).map(c => c.trim()).filter(c => c);
blog(`[${fmtTime()}] 发现 ${accounts.length} 个账号`);
blog("");
const users = [];
for (let idx = 0; idx < accounts.length; idx++) {
const config = accounts[idx];
const u = new UserService(ctx, idx + 1, config);
users.push(u);
if (u.appId) {
blog(`账号[${idx + 1}] 识别到 Token#AppId 模式，使用自定义AppId: ${u.appId}`);
} else if (u.account_mobile) {
blog(`账号[${idx + 1}] 识别到账号密码模式: ${mask_str(u.account_mobile)}`);
}
try {
if (u.token_online) {
await u.get_city_info();
}
} catch (e) {}
}
blog(`共找到${accounts.length}个账号`);
blog("");
const env_amount = env("UNICOM_GRAB_AMOUNT", "");
if (env_amount && /^\d+$/.test(env_amount)) {
GRAB_AMOUNT = parseInt(env_amount, 10);
}
const query_only = env("UNICOM_TEST_MODE", "").trim().toLowerCase() === "query";
if (query_only) {
blog("[Test Mode] 仅查询模式，跳过任务执行");
}
const sc = globalConfig.sign_config;
const mc = globalConfig.market_config;
const rc = globalConfig.regional_config;
let grab_mode = false;
let ah_friday_grab = false;
const nowD = new Date();
const hour = nowD.getHours();
const current_min = nowD.getMinutes();
const is_friday = nowD.getDay() === 5; // Python weekday(): 周一=0 … 周五=4
if (!query_only) {
if (sc.run_grab_coupon && globalConfig.enable_sign) {
if ((hour === 9 || hour === 17) && current_min >= 58 && current_min <= 59) {
grab_mode = true;
}
}
if (AH_FRIDAY_AMOUNT && is_friday && rc.run_ah_friday
&& globalConfig.enable_regional
&& hour === 9 && current_min >= 58 && current_min <= 59) {
ah_friday_grab = true;
grab_mode = true;
}
}
blog("-".repeat(36));
const switch_map = [
["enable_sign", "首页签到"],
["enable_ltzf", "联通祝福"],
["enable_ttlxj", "天天领现金"],
["enable_ttxc", "通通乡村"],
["enable_market", "权益超市"],
["enable_woread", "联通阅读"],
["enable_aiting", "联通爱听"],
["enable_security", "安全管家"],
["enable_ltyp", "联通云盘"],
["enable_wostore", "沃云手机"],
["enable_regional", "区域专区"],
];
for (const pair of switch_map) {
const key = pair[0], label = pair[1];
const enabled = globalConfig[key];
let status;
if (grab_mode) {
if (key === "enable_sign" && sc.run_grab_coupon) {
status = "运行(仅抢兑)";
} else if (key === "enable_regional" && ah_friday_grab) {
status = "运行(安徽抢红包)";
} else {
status = "跳过(抢兑模式)";
}
} else if (query_only) {
status = enabled? "仅查询": "关闭";
} else {
status = enabled? "运行": "关闭";
}
blog(`${label}设置为: ${status}`);
if (key === "enable_sign" && enabled &&!query_only) {
blog(` └─ 抢话费券: ${sc.run_grab_coupon? "开启": "关闭"}`);
}
if (key === "enable_regional" && enabled &&!query_only) {
const ah_status = (rc.run_ah_friday && AH_FRIDAY_AMOUNT)? "开启": "关闭";
blog(` └─ 安徽超级星期五: ${ah_status}` + (AH_FRIDAY_AMOUNT? ` (面额${AH_FRIDAY_AMOUNT}元)`: ""));
}
if (key === "enable_market" && enabled &&!query_only &&!grab_mode) {
blog(` └─ 浇水: ${mc.run_water? "开启": "关闭"}`);
blog(` └─ 做任务: ${mc.run_task? "开启": "关闭"}`);
blog(` └─ 会员中心: ${mc.run_member_center? "开启": "关闭"}`);
blog(` └─ 抽奖: ${mc.run_draw? "开启": "关闭"}`);
blog(` └─ 自动领奖: ${mc.run_claim? "开启": "关闭"}`);
}
}
blog(`设备ID刷新: ${globalConfig.refresh_device_id? "强制刷新": "使用缓存"}`);
blog("-".repeat(36));
blog("");
if (grab_mode) {
blog(`⏰ [自动触发] 检测到抢兑时间点 (${hour}:${pad2(current_min)})，进入并发抢兑模式`);
const tasks_desc = [];
if (sc.run_grab_coupon && globalConfig.enable_sign) {
tasks_desc.push(`${GRAB_AMOUNT}元话费券`);
}
if (ah_friday_grab) {
tasks_desc.push(`安徽${AH_FRIDAY_AMOUNT}元红包`);
}
blog(`🚨🚨🚨 [抢兑模式已启动] 目标: ${tasks_desc.join(" + ")} 🚨🚨🚨`);
blog("");
// Egern JS 无线程：Python 版 ThreadPoolExecutor 并发改为串行执行
async function run_grab_task(u) {
u.configure_proxy();
if (!u.token_online && u.account_mobile) {
await u.load_token_from_cache();
}
let is_valid = await u.onLine();
if (!is_valid && u.account_mobile && u.account_password) {
await u.unicom_login();
is_valid = await u.onLine();
}
if (is_valid) {
await u.save_token_to_cache();
try {
if (sc.run_grab_coupon && globalConfig.enable_sign) {
await u.sign_grabCoupon();
}
} catch (e) {
u.log(`抢兑子任务异常: ${e}`);
}
try {
if (ah_friday_grab) {
await u.ah_friday_task();
}
} catch (e) {
u.log(`抢兑子任务异常: ${e}`);
}
} else {
u.log("登录流程失败，跳过该账号");
}
}
blog(`🚀 [串行模式] 开始 ${accounts.length} 个账号抢兑...`);
for (const u of users) {
try {
await run_grab_task(u);
} catch (e) {
blog(`[-] Task Error: ${e}`);
}
}
await do_notify(users);
return;
}
blog("🚀 开始串行执行日常任务...");
blog("");
for (const u of users) {
blog("");
blog(`🔄 正在初始化账号[${u.index}]...`);
u.configure_proxy();
if (!u.token_online && u.account_mobile) {
await u.load_token_from_cache();
}
if (!u.token_online && u.account_mobile && u.account_password) {
await u.unicom_login();
}
if (await u.onLine()) {
await u.save_token_to_cache();
blog("");
blog(`------------------ 账号[${u.index}][${mask_str(u.account_mobile)}] ------------------`);
blog("");
await u.execute_daily_tasks(query_only);
blog("⏳ 账号处理完毕，等待 2 秒...");
await sleep(2 * 1000);
} else {
u.log("登录流程失败，跳过该账号");
}
}
await cross_view_security_share_keys(users);
await do_notify(users);
}
// 中国联通 Egern 版 - 最终 export 入口
// 由组装脚本自动追加

export default async function(ctx) {
  try {
    // 从 Egern 注入环境变量（模块设置页填写的值）
    try { if (ctx && ctx.env && typeof ctx.env === "object") ctxEnv = ctx.env; } catch (_) {}
    // 注入存储（token 缓存用）
    try { if (ctx && ctx.storage) ctxStorage = ctx.storage; } catch (_) {}
    refreshGlobalConfig();
    refreshEnvConsts();
    await egernMain(ctx);
    if (typeof notifyBody !== "undefined" && notifyBody) {
      await ctx.notify("中国联通", notifyBody);
    }
  } catch (e) {
    const msg = "脚本异常: " + (e && e.message ? e.message : e);
    try { blog(msg); } catch (_) {}
    try { await ctx.notify("中国联通", msg); } catch (_) {}
  }
}
