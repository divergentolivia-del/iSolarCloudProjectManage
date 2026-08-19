/* 服务端行为测试：乐观锁、rev 倒退放行、损坏文件回退、shutdown 通知。
   在子进程里起服务，跑完自动清理。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8791;
const DATA = path.join(os.tmpdir(), 'wbtest-' + process.pid);
let pass = 0, fail = 0;
function ck(n, c, extra) {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      resp => {
        let b = '';
        resp.on('data', c => b += c);
        resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(b) }); } catch (e) { res({ code: resp.statusCode, body: b }); } });
      });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Windows 上 child.kill('SIGINT') 走 TerminateProcess，直接杀死进程而不触发
   信号处理函数，无法用它验证优雅关闭。改为用一层 wrapper 加载 server.js，
   由父进程通过 IPC 通知 wrapper 触发 SIGINT 处理流程，
   等价于终端里真实按下 Ctrl+C 的效果，且不必往 server.js 里塞测试专用代码。 */
const WRAPPER = path.join(DATA, '_wrap.js');
function writeWrapper() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(WRAPPER,
    'require(' + JSON.stringify(path.resolve('server.js')) + ');\n' +
    'process.on("message", m => { if (m && m.cmd === "sigint") process.emit("SIGINT"); });\n',
    'utf8');
}

function start() {
  const p = spawn(process.execPath, [WRAPPER], {
    env: Object.assign({}, process.env, { DATA_DIR: DATA, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let out = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => out += d);
  p.getOut = () => out;
  return p;
}

function gracefulStop(p) {
  try { p.send({ cmd: 'sigint' }); } catch (e) { p.kill(); }
}

(async () => {
  writeWrapper();
  let srv = start();
  await sleep(1200);

  {
    console.log('\n[0] 归档不可变性');
    const archiveDir = path.join(DATA, 'archive');
    const archivePath = path.join(archiveDir, 'test-archive.json');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(archivePath, JSON.stringify({
      meta: { id: 'test-archive', name: '原始标题', note: '原始备注' },
      state: { rev: 1 }
    }), 'utf8');
    const patchResp = await req('PATCH', '/api/archive/test-archive', { name: '修改标题', note: '修改备注' });
    ck('已归档内容不提供 PATCH', patchResp.code === 404, patchResp.code);
    const archiveAfterPatch = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    ck('PATCH 不改变归档文件', archiveAfterPatch.meta.name === '原始标题' && archiveAfterPatch.meta.note === '原始备注', archiveAfterPatch.meta);
  }
  console.log('\n[1] 基本读写与乐观锁');
  let r = await req('POST', '/api/state', { baseRev: 0, by: '甲', state: { headcount: { 'APP开发-阳光云': { regular: 5 } } } });
  ck('首次提交 rev=1', r.code === 200 && r.body.rev === 1, r.body);
  r = await req('POST', '/api/state', { baseRev: 1, by: '乙', state: { headcount: { 'APP开发-阳光云': { regular: 5 }, 'WEB开发-阳光云': { regular: 3 } } } });
  ck('第二次提交 rev=2', r.code === 200 && r.body.rev === 2, r.body);
  r = await req('POST', '/api/state', { baseRev: 1, by: '丙', state: { headcount: {} } });
  ck('过期 baseRev 返回 409', r.code === 409, r.code);
  ck('409 带回服务端最新数据（供合并用基线）', r.code === 409 && !!r.body.state && r.body.currentRev === 2, r.body.currentRev);

  console.log('\n[2] rev 倒退放行（data 被回滚/重建后客户端不至于永久锁死）');
  r = await req('POST', '/api/state', { baseRev: 99, by: '丁', state: { headcount: { x: 1 } } });
  ck('baseRev 大于服务端时放行', r.code === 200, r.code);
  ck('新 rev 接续客户端版本号', r.body.rev === 100, r.body.rev);

  console.log('\n[3] SSE shutdown 通知');
  const evReq = http.request({ host: 'localhost', port: PORT, path: '/api/events' });
  let gotShutdown = false, sseClosed = false;
  evReq.on('error', () => { sseClosed = true; });   // 服务退出时连接被重置，等同于关闭
  evReq.on('response', resp => {
    resp.on('error', () => { sseClosed = true; });
    resp.on('data', c => { if (String(c).indexOf('event: shutdown') >= 0) gotShutdown = true; });
    resp.on('end', () => { sseClosed = true; });
  });
  evReq.end();
  await sleep(500);
  gracefulStop(srv);
  await sleep(900);
  ck('Ctrl+C 前推送 shutdown 事件', gotShutdown);
  ck('SSE 连接被主动关闭', sseClosed);
  ck('关闭日志提示在线页面数', /已通知其转入本机暂存/.test(srv.getOut()), srv.getOut().slice(-200));
  ck('关闭日志提示数据位置', /数据保存在/.test(srv.getOut()));

  console.log('\n[4] 重启后数据保留');
  srv = start();
  await sleep(1200);
  r = await req('GET', '/api/state');
  ck('重启后 rev 保留', r.body.rev === 100, r.body.rev);
  ck('重启后数据保留', JSON.stringify(r.body.headcount) === JSON.stringify({ x: 1 }), r.body.headcount);
  gracefulStop(srv);
  await sleep(700);

  console.log('\n[5] iteration/state.json 损坏时回退历史快照，而非返回空态');
  fs.writeFileSync(path.join(DATA, 'iteration', 'state.json'), '{"headcount": {broken', 'utf8');
  srv = start();
  await sleep(1200);
  r = await req('GET', '/api/state');
  ck('未返回空态（rev>0）', Number(r.body.rev) > 0, r.body.rev);
  ck('从快照恢复出数据', !!r.body.headcount && Object.keys(r.body.headcount).length > 0, r.body.headcount);
  ck('日志提示已回退', /回退到快照/.test(srv.getOut()), srv.getOut().slice(-300));
  gracefulStop(srv);
  await sleep(700);

  console.log('\n[6] 无快照且文件损坏时留存 .broken 供人工检查');
  fs.rmSync(path.join(DATA, 'iteration', 'history'), { recursive: true, force: true });
  fs.writeFileSync(path.join(DATA, 'iteration', 'state.json'), 'not json at all', 'utf8');
  srv = start();
  await sleep(1200);
  r = await req('GET', '/api/state');
  ck('降级为空态', Number(r.body.rev || 0) === 0, r.body.rev);
  ck('原损坏文件已另存 .broken', fs.existsSync(path.join(DATA, 'iteration', 'state.json.broken')));
  gracefulStop(srv);
  await sleep(700);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
