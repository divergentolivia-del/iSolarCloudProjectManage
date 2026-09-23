#!/usr/bin/env node
/* dingtalk-ping.js — 钉钉最小连通性验证
 *
 * 目的（对应 docs/plan-dingtalk-checklist.md 第五节第 8 项）：
 *   换 token → 解析文档链接 → 读一个区间打印出来。
 *   **这一步跑通之前，同步逻辑一行都不写。** TB 那次的教训：不先实测就设计同步 = 空中楼阁。
 *
 * 用法：
 *   node dingtalk-ping.js
 *   node dingtalk-ping.js --range A1:F20      # 指定读哪个区间
 *   node dingtalk-ping.js --sheet 3           # 指定读第几个 sheet（1 起）
 *
 * 凭据来源：data/dingtalk/secret.json（已 gitignore）。
 * 环境变量 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_OPERATOR_ID / DINGTALK_DOC_URL 优先。
 *
 * 本脚本只读不写，不改任何状态文件，可以随便跑。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, 'data', 'dingtalk', 'secret.json');
const API = 'https://api.dingtalk.com';
const TIMEOUT_MS = 15000;

const argv = process.argv.slice(2);
const arg = (name, dft) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dft;
};
const RANGE = arg('range', 'A1:F20');
const SHEET_IDX = parseInt(arg('sheet', '1'), 10);

/* 三跳的真实结果，供结尾小结判断。
   踩过两次：
     1) 小结只看「配置填没填」，于是 hop2 报错、hop3 被跳过的那一次，
        结尾照样打印「三跳都跑完了」—— 和同一屏里的 ❌ 自相矛盾。
     2) 改成看结果后仍漏报：失败分支从没把值写成 false，undefined 既不进
        「通过」也不进「未通过」，被静默跳过 → 又打印了一次假成功。
   所以默认值必须是 false：只有明确成功才置 true，没走到的就是没通过。 */
const hop = { token: false, node: false, sheet: false };

/* ---------- 小工具 ---------- */

const ok = s => '\x1b[32m' + s + '\x1b[0m';
const bad = s => '\x1b[31m' + s + '\x1b[0m';
const dim = s => '\x1b[90m' + s + '\x1b[0m';
const step = n => console.log('\n' + '─'.repeat(60) + '\n' + n);

/* 占位值识别：secret.example.json 里的说明文字、或者忘了填的空壳，都算"没填" */
function missing(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  if (!s) return true;
  if (s === '待填' || s === '待填 ') return true;
  if (/^(「|请|填|your|xxx|TODO)/i.test(s)) return true;
  return false;
}

function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
  } catch (e) {
    console.log(dim('  (读不到 ' + path.relative(__dirname, SECRET_FILE) + '，只走环境变量)'));
  }
  const env = process.env;
  const doc = file['_文档定位_二选一'] || {};
  return {
    appKey: env.DINGTALK_APP_KEY || file.appKey,
    appSecret: env.DINGTALK_APP_SECRET || file.appSecret,
    operatorId: env.DINGTALK_OPERATOR_ID || file.operatorId,
    docUrl: env.DINGTALK_DOC_URL || doc.docUrl,
    nodeId: env.DINGTALK_NODE_ID || doc.nodeId,
    robotCode: env.DINGTALK_ROBOT_CODE || file.robotCode
  };
}

/** 带超时的请求。钉钉接口的 token 走请求头，不放 query —— 这点与 TB 不同。 */
async function req(method, url, { token, body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-acs-dingtalk-access-token'] = token;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON（比如网关 HTML 报错页） */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 遮蔽敏感值：token 只留头尾，避免密钥进聊天/截图。
 *  ⚠ 按【键名】判断，所以调用方必须用 token/secret/password 这类键。
 *  踩过：写成 maskDeep({ t: token }).t，键名是 t 不匹配规则，token 明文打了出来。 */
function maskToken(v) {
  const s = String(v || '');
  return s.length > 16 ? s.slice(0, 6) + '…(' + s.length + ' 位)…' + s.slice(-4) : s;
}
function maskDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskDeep);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/token|secret|password/i.test(k) && typeof v === 'string') {
      out[k] = maskToken(v);
    } else {
      out[k] = maskDeep(v);
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */

(async function main() {
  console.log('钉钉最小连通性验证');
  console.log(dim('  只读操作，不写任何状态文件。'));

  /* ---- 0. 凭据体检 ---- */
  step('0) 凭据体检');
  const cfg = readConfig();
  const rows = [
    ['appKey', cfg.appKey],
    ['appSecret', cfg.appSecret],
    ['operatorId', cfg.operatorId],
    ['docUrl / nodeId', cfg.docUrl && !missing(cfg.docUrl) ? cfg.docUrl : cfg.nodeId]
  ];
  let credOk = true;
  for (const [k, v] of rows) {
    const miss = missing(v);
    console.log('  ' + k.padEnd(18) + (miss ? bad('❌ 未填') : ok('✅ 已填') + dim('  ' + (k.indexOf('Secret') >= 0 ? '(已遮蔽)' : String(v).slice(0, 60)))));
    if (miss && (k === 'appKey' || k === 'appSecret')) credOk = false;
  }
  if (!credOk) {
    console.log(bad('\n  缺少 appKey / appSecret，无法继续。填 data/dingtalk/secret.json 后重跑。'));
    process.exit(1);
  }

  /* ---- 1. 换 token（这一步就是对 api.dingtalk.com 的连通性证明）---- */
  step('1) 换取 access_token（同时验证出网连通性）');
  let token = null;
  try {
    const r = await req('POST', API + '/v1.0/oauth2/accessToken', {
      body: { appKey: cfg.appKey, appSecret: cfg.appSecret }
    });
    if (r.status === 200 && r.json && r.json.accessToken) {
      token = r.json.accessToken;
      hop.token = true;
      console.log('  ' + ok('✅ 连通且鉴权通过'));
      console.log('  ' + dim('  有效期：' + (r.json.expireIn || '?') + ' 秒'));
      console.log('  ' + dim('  token：' + maskToken(token)));
    } else {
      console.log('  ' + bad('❌ HTTP ' + r.status));
      console.log('  ' + JSON.stringify(maskDeep(r.json) || r.text.slice(0, 300), null, 2).split('\n').join('\n  '));
      console.log(bad('\n  常见原因：appKey/appSecret 写错、应用未发布、或机器出不了网。'));
      process.exit(1);
    }
  } catch (e) {
    console.log('  ' + bad('❌ 请求失败：' + (e && e.message)));
    if (e && e.name === 'AbortError') console.log(dim('  超时 ' + TIMEOUT_MS + 'ms —— 大概率是内网不通，需要网关/代理/白名单。'));
    console.log(dim('  自测命令：curl -sS -o /dev/null -w "%{http_code}\\n" https://api.dingtalk.com/v1.0/gateway/connections/open'));
    process.exit(1);
  }

  /* ---- 2. 解析文档链接 ---- */
  step('2) 解析文档链接 → nodeId');
  let nodeId = missing(cfg.nodeId) ? null : cfg.nodeId;
  if (!missing(cfg.docUrl)) {
    try {
      /* 路径是 queryByUrl，不是 query。
         踩过：写成 /v2.0/wiki/nodes/query → 404 InvalidAction.NotFound。
         这类 404 很容易被误读成「没权限」，其实是路径根本不存在。
         判据：没权限会回 403/Forbidden，404 + InvalidAction.NotFound 是路径错。 */
      const r = await req('POST', API + '/v2.0/wiki/nodes/queryByUrl', {
        token,
        body: { url: cfg.docUrl, operatorId: cfg.operatorId || undefined }
      });
      if (r.status === 200 && r.json && r.json.node) {
        nodeId = r.json.node.nodeId || r.json.node.id;
        hop.node = true;
        console.log('  ' + ok('✅ 解析成功') + dim('  nodeId=' + nodeId));
        console.log('  ' + dim('  名称：' + (r.json.node.name || '?')));
      } else {
        console.log('  ' + bad('❌ HTTP ' + r.status) + dim('  （链接解析需要「知识库」类权限点）'));
        console.log('  ' + JSON.stringify(maskDeep(r.json) || r.text.slice(0, 300), null, 2).split('\n').join('\n  '));
      }
    } catch (e) {
      console.log('  ' + bad('❌ 请求失败：' + (e && e.message)));
    }
  } else if (nodeId) {
    console.log('  ' + dim('  跳过：直接用 secret.json 里的 nodeId'));
  } else {
    console.log('  ' + dim('  跳过：docUrl 与 nodeId 都没填。'));
  }

  /* ---- 3. 读文档内容 ---- */
  step('3) 读取表格内容（区间 ' + RANGE + '）');
  if (!nodeId) {
    console.log('  ' + dim('  跳过：还没拿到 nodeId。'));
  } else {
    try {
      const r = await req('GET', API + '/v1.0/doc/workbooks/' + nodeId + '/sheets?operatorId=' + (cfg.operatorId || ''), { token });
      if (r.status === 200 && r.json && r.json.value) {
        const sheets = r.json.value;
        hop.sheet = true;
        console.log('  ' + ok('✅ 拿到 ' + sheets.length + ' 个 sheet'));
        sheets.forEach((s, i) => console.log('  ' + dim('  [' + (i + 1) + '] ' + (s.name || s.id) + '  id=' + (s.id || '?'))));
        const sh = sheets[Math.min(SHEET_IDX, sheets.length) - 1];
        const wid = sh.id || sh.workbookId;
        const rr = await req('GET',
          API + '/v1.0/doc/workbooks/' + nodeId + '/sheets/' + wid + '/ranges/' + RANGE + '?operatorId=' + (cfg.operatorId || ''),
          { token });
        if (rr.status === 200) {
          console.log('  ' + ok('✅ 读到区间内容：'));
          console.log(JSON.stringify(maskDeep(rr.json), null, 2).split('\n').slice(0, 40).join('\n'));
        } else {
          console.log('  ' + bad('❌ 读区间 HTTP ' + rr.status));
          console.log('  ' + JSON.stringify(maskDeep(rr.json) || rr.text.slice(0, 300), null, 2).split('\n').join('\n  '));
        }
      } else {
        console.log('  ' + bad('❌ 读 sheet 列表 HTTP ' + r.status));
        console.log('  ' + JSON.stringify(maskDeep(r.json) || r.text.slice(0, 300), null, 2).split('\n').join('\n  '));
      }
    } catch (e) {
      console.log('  ' + bad('❌ 请求失败：' + (e && e.message)));
    }
  }

  /* ---- 小结 ---- */
  step('结果');
  /* 小结看的是【真实结果】，不是配置填没填 —— 配置齐全但接口报错的那次，
     旧版照样打印「三跳都跑完了」，和上面的 ❌ 自相矛盾。 */
  const names = ['换 token', '解析文档链接', '读表格内容'];
  const flags = [hop.token, hop.node, hop.sheet];
  const failed = names.filter((n, i) => flags[i] === false);
  const passed = names.filter((n, i) => flags[i] === true);

  if (passed.length) console.log(ok('  通过：') + passed.join(' → '));
  if (failed.length) {
    console.log(bad('  未通过：' + failed.join('、')));
    if (failed.indexOf('解析文档链接') >= 0) {
      console.log(dim('   解析失败先分清两类原因：'));
      console.log(dim('     404 InvalidAction.NotFound → 路径写错了（本脚本曾把 queryByUrl 写成 query，就是这类）'));
      console.log(dim('     403 / Forbidden            → 路径对，但缺权限点或 operatorId 无权访问该文档'));
    }
  }

  /* 配置层还没补齐的，单独提示 —— 这是「没开始」，不是「跑挂了」 */
  const blocker = [];
  if (missing(cfg.operatorId)) blocker.push('operatorId 未填（读文档需要「有权访问该文档的人」的 userId）');
  if (missing(cfg.docUrl) && missing(cfg.nodeId)) blocker.push('docUrl / nodeId 未填（还不知道要读哪份文档）');
  if (blocker.length) {
    console.log(bad('\n  还不能跑完整的「读一份文档」验证，卡在：'));
    blocker.forEach(b => console.log('   · ' + b));
  } else if (failed.length === 0) {
    console.log(ok('\n  三跳都跑完了 —— 读文档这条链路是通的。'));
  } else {
    console.log(bad('\n  配置齐全，但上面有跳没通过，先解决它再谈同步。'));
  }
  console.log(dim('  下一步：按 docs/plan-dingtalk-checklist.md 补齐上面两项，再重跑本脚本。'));
})();
