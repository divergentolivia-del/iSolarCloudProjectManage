/* check-network.js — 钉钉连通性自检（不写任何数据、不读凭据）

   用途：动手写钉钉代码之前，先确认「你这台机器 / 将来部署的服务器」能不能访问钉钉开放平台。
   这是整条打通链路的头号前置条件 —— 不通的话，后面所有设计和代码都是纸上谈兵。

   用法： node check-network.js

   输出：逐个测试目标的连通结果，以及最终结论。
*/

'use strict';

const dns = require('dns');
const https = require('https');

/* 钉钉用到的主机。api / oapi 是接口域名，后面几个是文档里可能出现的静态资源域名，
   一起测掉省得来回问。 */
const TARGETS = [
  { host: 'api.dingtalk.com', path: '/v1.0/robot/oToMessages/batchSend', why: '新版 OpenAPI（免登换用户信息、文档读写都走这里）' },
  { host: 'oapi.dingtalk.com', path: '/gettoken', why: '旧版 OpenAPI（部分接口仍在用）' },
  { host: 'login.dingtalk.com', path: '/', why: '扫码登录页（免登不一定用到，一并测）' }
];

function dnsLookup(host) {
  return new Promise(resolve => {
    dns.lookup(host, (err, address, family) => {
      resolve(err ? { ok: false, reason: err.code || err.message } : { ok: true, address, family });
    });
  });
}

/* 用 GET 而不是 HEAD：有些网关对 HEAD 响应不友好。
   任何 HTTP 状态码（含 4xx/5xx）都算「网络通」——说明包出去了、TLS 握手成功、对方回话了。 */
function httpsProbe(host, path) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = https.request(
      { host, path, method: 'GET', timeout: 8000, headers: { 'User-Agent': 'pm-platform-netcheck' } },
      res => {
        res.resume();   // 丢弃响应体，只关心能不能连上
        resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: '超时（8 秒无响应）' }); });
    req.on('error', e => resolve({ ok: false, reason: (e.code || e.message) }));
    req.end();
  });
}

(async function main() {
  console.log('钉钉连通性自检');
  console.log('  本机时间：' + new Date().toLocaleString('zh-CN'));
  console.log('');

  let dnsOk = 0, httpOk = 0;

  for (const t of TARGETS) {
    console.log('── ' + t.host + '  (' + t.why + ')');

    const d = await dnsLookup(t.host);
    if (d.ok) {
      dnsOk++;
      console.log('   DNS 解析  ✔ ' + d.address + ' (IPv' + d.family + ')');
    } else {
      console.log('   DNS 解析  ✘ ' + d.reason + '   ← 连域名都解析不出来，通常是 DNS 被限制或没有外网');
    }

    const h = await httpsProbe(t.host, t.path);
    if (h.ok) {
      httpOk++;
      console.log('   HTTPS 访问 ✔ HTTP ' + h.status + '，耗时 ' + h.ms + 'ms');
    } else {
      console.log('   HTTPS 访问 ✘ ' + h.reason);
      if (/ENOTFOUND|EAI_AGAIN/.test(h.reason)) console.log('              域名解析失败，同上');
      else if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|超时/.test(h.reason)) console.log('              能通到某处但连不上，多半被防火墙/代理拦了');
      else if (/CERT|TLS|SSL/.test(h.reason)) console.log('              证书问题，可能被中间设备做了 HTTPS 拦截（需换代理方式）');
    }
    console.log('');
  }

  console.log('════════════════════════════════════');
  console.log('结论：域名解析 ' + dnsOk + '/' + TARGETS.length + ' 通，HTTPS 访问 ' + httpOk + '/' + TARGETS.length + ' 通');
  console.log('');
  if (httpOk === TARGETS.length) {
    console.log('✔ 这台机器可以直接访问钉钉开放平台。');
    console.log('  下一步：去钉钉开放平台建应用、拿凭据（见 docs/plan-dingtalk-checklist.md）。');
  } else if (dnsOk > 0) {
    console.log('⚠ 域名能解析，但 HTTPS 连不上 —— 典型的「有 DNS 但被防火墙拦」或「需要走代理」。');
    console.log('  请找 IT/网络同事确认：');
    console.log('    1) 出网是否必须走代理？代理地址端口是什么？');
    console.log('    2) 防火墙是否放行了 api.dingtalk.com？');
    console.log('  拿到代理信息后告诉我，我在代码里加上代理支持再重测。');
  } else {
    console.log('✘ 完全出不去外网。');
    console.log('  这台机器（或是它所在的内网段）没有外网出口。三条路：');
    console.log('    1) 换一台有外网出口的机器做数据同步（平台仍在内网）；');
    console.log('    2) 申请开通该 IP/网段到钉钉域名的出网策略；');
    console.log('    3) 如果公司有统一代理，走代理（同上，需要代理地址）。');
  }
  console.log('');
  console.log('提示：将来平台部署到服务器上时，要在「那台服务器」上重新跑一次本脚本 ——');
  console.log('      你这台开发机通了，不代表服务器通。');
})();
