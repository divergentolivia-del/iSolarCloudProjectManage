/* modules/notify/lib/scheduler.js — 定时调度
 *
 * 由 routes.js 的 ensureData() 在服务启动时调用一次 start()，
 * 之后按 config.schedule 的节奏跑 checkAll()：
 *   启动后 startupDelaySeconds 秒做首次检查，
 *   然后每 intervalMinutes 分钟一次。
 *
 * 调度器只负责"到点调用 + 打日志"，检查逻辑全在 checker.js。
 * 所有异常都被吞掉记日志 —— 定时任务绝不能把服务进程带崩。
 */

'use strict';

const checker = require('./checker');
const pusher = require('./pusher');

let timer = null;      // 周期定时器
let bootTimer = null;  // 启动延时
let running = false;   // 防重入（一次检查没跑完，下一次到点直接跳过）

function scheduleSeconds() {
  const cfg = pusher.readConfig();
  const sc = cfg.schedule || {};
  const interval = Math.max(1, Number(sc.intervalMinutes) || 60) * 60;
  const delay = Math.max(5, Number(sc.startupDelaySeconds) || 45);
  return { interval, delay };
}

/** 执行一次检查（防重入，异常不外抛） */
async function tick(manual) {
  if (running) {
    console.log('[notify] 上一次检查未结束，本次' + (manual ? '手动' : '定时') + '检查跳过');
    return { skipped: true };
  }
  running = true;
  try {
    const r = await checker.checkAll();
    const hs = r.highSeverity || {};
    const rm = r.reminders || {};
    console.log('[notify] 检查完成：新增高严重度 ' + hs.newItems + ' 条（推送 ' + hs.pushed + ' / 入队 ' + hs.queued + ' / 跳过 ' + hs.skipped + '），提醒 ' + rm.reminded.length + ' 条（推送 ' + rm.pushed + ' / 入队 ' + rm.queued + '）');
    return r;
  } catch (e) {
    console.error('[notify] 检查异常：' + (e && e.stack || e));
    return { error: String(e && e.message || e) };
  } finally {
    running = false;
  }
}

/** 启动调度（幂等：重复调用不叠加定时器） */
function start() {
  if (timer || bootTimer) return;
  const { interval, delay } = scheduleSeconds();

  bootTimer = setTimeout(() => {
    tick(false);
    timer = setInterval(() => tick(false), interval * 1000);
    if (timer.unref) timer.unref();
  }, delay * 1000);
  if (bootTimer.unref) bootTimer.unref();

  console.log('[notify] 调度已启动：' + delay + ' 秒后首次检查，之后每 ' + interval + ' 秒一次');
}

/** 停止调度（测试用） */
function stop() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick };