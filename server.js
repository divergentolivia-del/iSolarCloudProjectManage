/* 多人实时协同服务端。零依赖，仅用 Node 内置模块。
   启动： node server.js  [端口]
   数据： 同目录 data/state.json（每次变更落盘 + 时间戳备份）

   实时机制：SSE（Server-Sent Events）。任一浏览器提交变更后，
   服务端广播给所有连接的客户端，各端自动刷新，无需手动刷新页面。 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

/* 配置优先级：命令行参数 > 环境变量 > 默认值
   PORT           监听端口
   DATA_DIR       数据目录（部署时建议指向服务器上的持久化路径）
   ACCESS_TOKEN   访问口令，设置后所有请求需带 ?token=xxx，留空则不校验 */
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8770;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/* ---------- 状态存取 ---------- */
function ensureDirs() {
  [DATA_DIR, HISTORY_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

const EMPTY_STATE = {
  cycles: [{ name: '方案一', seal: '', online: '', workdays: 0, saturdays: 0, active: true, note: '' }],
  headcount: {}, locked: [], totals: [], board: [], iterations: [], sources: {},
  rev: 0, updatedAt: '', updatedBy: ''
};

/* 读取状态。文件不存在属正常（首次启动），返回空态；
   文件存在但解析失败说明已损坏（如写盘中途断电），此时绝不能返回空态 ——
   那会让各端把空数据当成最新版，一提交就把所有人的填写覆盖掉。
   改为自动回退到 history 里最近一个可用快照。 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('state.json 解析失败：' + e.message + '，尝试回退历史快照');
    const snap = latestSnapshot();
    if (snap) {
      console.error('  已回退到快照：' + snap.name);
      return snap.data;
    }
    console.error('  无可用快照，返回空态。原文件已另存为 state.json.broken 供人工检查');
    try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.broken'); } catch (x) { }
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
}

/* 取 history 中 rev 最大且能正常解析的快照 */
function latestSnapshot() {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const sorted = files.map(f => ({
      name: f, rev: Number((/-rev(\d+)\.json$/.exec(f) || [])[1] || 0)
    })).sort((a, b) => b.rev - a.rev);
    for (const s of sorted) {
      try {
        return { name: s.name, data: JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, s.name), 'utf8')) };
      } catch (e) { /* 这份也坏了，试下一份 */ }
    }
  } catch (e) { }
  return null;
}

/* 原子写入：先写临时文件再 rename，避免并发读到半截 JSON */
function writeState(s) {
  ensureDirs();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/* 归档快照，便于回溯月度历史 */
function archive(s) {
  try {
    ensureDirs();
    const c = (s.cycles || []).find(x => x.active) || {};
    const tag = String(c.online || 'unnamed').replace(/[^\w.-]/g, '_');
    const name = tag + '-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/* ---------- SSE 广播 ---------- */
let clients = [];

function broadcast(rev, by) {
  const payload = 'data: ' + JSON.stringify({ rev: rev, by: by }) + '\n\n';
  clients = clients.filter(res => {
    try { res.write(payload); return true; }
    catch (e) { return false; }
  });
}

/* 优雅关闭：Ctrl+C 时先告知所有在线页面，让它们立即转入本机暂存模式，
   否则各端要等到 TCP 超时才发现服务没了，这期间的填写会静默丢失。 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在关闭（' + sig + '）…');
  console.log('  在线页面数：' + clients.length + '，已通知其转入本机暂存');
  clients.forEach(res => {
    try { res.write('event: shutdown\ndata: {}\n\n'); res.end(); } catch (e) { }
  });
  clients = [];
  server.close(() => {
    console.log('已停止。数据保存在：' + STATE_FILE);
    console.log('重新启动后，同事页面会自动重连并补交断连期间的填写。');
    process.exit(0);
  });
  // 有长连接卡住时兜底，1 秒后强制退出
  setTimeout(() => process.exit(0), 1000).unref();
}
['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach(s =>
  process.on(s, () => shutdown(s)));

/* Windows 的部分终端（Git Bash / MinTTY 等）下 Ctrl+C 不一定能转成 SIGINT，
   用 readline 再兜一层。仅在交互式终端启用，装成服务运行时不受影响。
   即便这两层都没捕获到、进程被硬杀，各端仍会通过 SSE 断连在数秒内察觉，
   本机暂存不会丢 —— 主动通知只是让感知更及时。 */
if (process.platform === 'win32' && process.stdin.isTTY) {
  try {
    require('readline')
      .createInterface({ input: process.stdin, output: process.stdout })
      .on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) { /* 无 TTY 时忽略 */ }
}

/* ---------- 请求处理 ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  // 去掉前导斜杠；空路径（/ 或 //）一律回首页
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  // 阻断路径穿越，并禁止读取 data 目录
  const target = path.resolve(ROOT, rel);
  if (!target.startsWith(ROOT) || target.startsWith(DATA_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404).end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;

  /* 访问口令校验。ACCESS_TOKEN 为空则跳过。
     口令可放在 ?token= 或 Cookie 里；命中查询串时写入 Cookie，
     这样同事只需第一次点带 token 的链接，后续刷新无需重复带参。 */
  if (ACCESS_TOKEN) {
    const qs = String(u.query.token || '');
    const cookie = /(?:^|;\s*)wb_token=([^;]+)/.exec(req.headers.cookie || '');
    const got = qs || (cookie ? decodeURIComponent(cookie[1]) : '');
    if (got !== ACCESS_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>需要访问口令</h3><p>请使用管理员提供的完整链接访问（含 ?token= 参数）。</p>');
      return;
    }
    if (qs) {
      res.setHeader('Set-Cookie',
        'wb_token=' + encodeURIComponent(qs) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
    }
  }

  // 读取当前状态
  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, readState());
  }

  // 提交变更。乐观锁：客户端带上 baseRev，落后则拒绝并要求先合并
  if (p === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 64 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let incoming;
      try { incoming = JSON.parse(body); }
      catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }

      const cur = readState();
      const baseRev = Number(incoming.baseRev);
      const curRev = Number(cur.rev || 0);
      /* 乐观锁。仅当客户端基于的版本比服务端旧时才拒绝。
         客户端 rev 反而更大，说明服务端数据被回滚或 data 目录被重建过 ——
         此时若照常拒绝，该客户端将永远无法提交，故放行并接续其版本号。 */
      if (isFinite(baseRev) && baseRev < curRev) {
        return sendJson(res, 409, {
          error: '数据已被他人更新', currentRev: cur.rev, state: cur
        });
      }

      const next = incoming.state || {};
      next.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
      next.updatedAt = new Date().toLocaleString('zh-CN');
      next.updatedBy = String(incoming.by || '未署名').slice(0, 40);

      try { writeState(next); }
      catch (e) { return sendJson(res, 500, { error: '写入失败：' + e.message }); }

      archive(next);
      broadcast(next.rev, next.updatedBy);
      sendJson(res, 200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
    });
    return;
  }

  // SSE 订阅
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    clients.push(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients = clients.filter(c => c !== res);
    });
    return;
  }

  serveStatic(req, res, p);
});

ensureDirs();
server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(k => (nets[k] || []).forEach(n => {
    if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }));
  console.log('人力产能工作台已启动');
  console.log('  本机访问：http://localhost:' + PORT);
  ips.forEach(ip => console.log('  同事访问：http://' + ip + ':' + PORT));
  console.log('  数据文件：' + STATE_FILE);
  console.log('  停止服务：在本窗口按 Ctrl+C（会先通知在线页面，不会丢数据）');
  if (ACCESS_TOKEN) {
    console.log('\n已启用访问口令。分享给同事的链接需带参数：');
    ips.forEach(ip => console.log('  http://' + ip + ':' + PORT + '/?token=' + ACCESS_TOKEN));
  } else {
    console.log('\n注意：未设访问口令（ACCESS_TOKEN 为空），能访问端口的人都可读写。');
    console.log('仅适合内网可信网络。如需限制，启动前设置 ACCESS_TOKEN 环境变量。');
  }
});
