/* SSO 登录链路测试：state 一次性校验、回跳地址白名单、返回体取字段、配置完整性。
 *
 * 为什么这些点必须测：
 *   这些都是「错了也不会报错、但会悄悄放人进来或把人挡在外面」的逻辑 ——
 *   state 若能重复用，一次登录链接可被反复重放；safeNext 若能跳外站，
 *   就成了钓鱼跳板；dig 取错字段，是把别人认成你的风险。
 *   它们平时跑得通、看不出来，所以必须钉死。
 *
 * 不测的部分：换工号（要真连 SSO）、建会话（要真 DB 数据）——
 *   前者是外部依赖，后者已经在 _test-gate.js 覆盖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 必须在 require 之前设 DATA_DIR —— db.js 在模块加载时就定好了库文件位置，
   不设的话这个测试会挂在真实的 data/ 上，污染正在被同事使用的数据。 */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sso-'));

const sso = require('./modules/sso/routes');

let pass = 0, fail = 0;
function ck(n, c, extra) {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n, extra !== undefined ? JSON.stringify(extra) : ''); }
}

console.log('\n[SSO · 回跳地址白名单]');
/* safeNext：只放行站内相对路径。开头的 '//' 是协议相对 URL（//evil.com 会跳外站），必须挡掉。 */
ck('普通站内路径放行', sso.safeNext('/plan') === '/plan');
ck('带查询串放行', sso.safeNext('/plan?x=1') === '/plan?x=1');
ck('空值回落首页', sso.safeNext('') === '/');
ck('undefined 回落首页', sso.safeNext(undefined) === '/');
ck('绝对 URL 挡住', sso.safeNext('https://evil.com') === '/', sso.safeNext('https://evil.com'));
ck('协议相对 URL 挡住', sso.safeNext('//evil.com') === '/', sso.safeNext('//evil.com'));
ck('裸域名挡住', sso.safeNext('evil.com') === '/', sso.safeNext('evil.com'));

console.log('\n[SSO · state 一次性校验]');
const s1 = sso.newNonce('/plan');
ck('生成的 state 足够长（≥32 字符，防爆破）', typeof s1 === 'string' && s1.length >= 32, s1);
const c1 = sso.consumeNonce(s1);
ck('首次消费成功', c1.ok === true, c1);
ck('首次消费带回原回跳地址', c1.next === '/plan', c1.next);

const c2 = sso.consumeNonce(s1);
ck('★ 同一 state 第二次消费失败（防重放）', c2.ok === false && c2.reason === 'unknown', c2);

const s2 = sso.newNonce('/plan');
ck('next 在写入时就已被 safeNext 洗过',
  sso._nonces.get(s2).next === '/plan', sso._nonces.get(s2));

const c3 = sso.consumeNonce('不存在的state');
ck('陌生 state 拒绝', c3.ok === false && c3.reason === 'unknown', c3);

const c4 = sso.consumeNonce('');
ck('空 state 拒绝（reason=missing）', c4.ok === false && c4.reason === 'missing', c4);

/* 过期：直接改 map 里的 createdAt 把它老化，比等 10 分钟现实 */
const s3 = sso.newNonce('/plan');
sso._nonces.get(s3).createdAt = Date.now() - 11 * 60 * 1000;
const c5 = sso.consumeNonce(s3);
ck('★ 超时 10 分钟的 state 拒绝（reason=expired）', c5.ok === false && c5.reason === 'expired', c5);
ck('过期的那条已被删除，不留残渣', sso._nonces.has(s3) === false);

const s4 = sso.newNonce('/plan');
sso._nonces.get(s4).createdAt = Date.now() - 9 * 60 * 1000;
ck('9 分钟的 state 仍有效（边界内）', sso.consumeNonce(s4).ok === true);

console.log('\n[SSO · 返回体取字段]');
/* SSO 各家返回体嵌套层级不一样，dig 负责把工号从任意深度挖出来 */
ck('顶层命中', sso.dig({ empNo: '10017968' }, 'empNo', 0) === '10017968');
ck('嵌套两层命中', sso.dig({ data: { result: { empNo: '10017968' } } }, 'empNo', 0) === '10017968');
ck('顶层空串继续往下找', sso.dig({ empNo: '', data: { empNo: '999' } }, 'empNo', 0) === '999');
ck('顶层 null 继续往下找', sso.dig({ empNo: null, data: { empNo: '999' } }, 'empNo', 0) === '999');
ck('找不到返回 undefined', sso.dig({ foo: 'bar' }, 'empNo', 0) === undefined);
ck('null 输入不崩', sso.dig(null, 'empNo', 0) === undefined);
ck('非对象输入不崩', sso.dig('x', 'empNo', 0) === undefined);
/* 深度上限：防止畸形/自引用结构把栈打爆 */
ck('超过深度上限不返回', sso.dig({ a: { b: { c: { d: { e: { empNo: '999' } } } } } }, 'empNo', 0) === undefined);

console.log('\n[SSO · 配置完整性]');
const miss = sso.missingConfig();
/* 未配置时必须能列出「缺哪几项」。联调期一句「配置错误」查半天，
   列出来才知道该找流程数字化中心要什么。 */
ck('未配置时 missingConfig 非空', Array.isArray(miss) && miss.length > 0, miss);
ck('missingConfig 明确点名 clientId', miss.some(m => m.indexOf('clientId') >= 0), miss);
ck('missingConfig 明确点名 tokenUrl', miss.some(m => m.indexOf('tokenUrl') >= 0), miss);
ck('missingConfig 明确点名 idField', miss.some(m => m.indexOf('idField') >= 0), miss);
ck('未配置时 isConfigured 为 false', sso.isConfigured() === false);

/* 回调地址必须与申请登记值一致，写错了 SSO 会直接拒绝，且报错信息很难懂 */
ck('默认回调地址 = 申请登记值',
  sso.CONFIG.redirectUri === 'http://10.63.139.103:9680/sso/callback', sso.CONFIG.redirectUri);
ck('默认授权端点非空', !!sso.CONFIG.authorizeUrl, sso.CONFIG.authorizeUrl);
ck('默认 debug 关闭（生产不能默认放人进来）', sso.CONFIG.debug === false);

console.log('\n[SSO · 路由挂载]');
/* 断言「哪些路径必须在册」，不写死总数 —— 加一个端点（如 /sso/logout）
   不该让测试变红。真正要守住的是这几个端点一个都不能少。 */
ck('四个必需路径都在册',
  Array.isArray(sso.paths) &&
  ['/sso/login', '/sso/callback', '/sso/status', '/sso/logout'].every(p => sso.paths.includes(p)),
  sso.paths);
ck('路径都在站点根下（非 /api）', sso.paths.every(p => p.indexOf('/sso/') === 0), sso.paths);
ck('handle 是函数', typeof sso.handle === 'function');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
