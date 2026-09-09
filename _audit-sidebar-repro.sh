#!/bin/bash
# 复现「收起又自动展开」：必须先访问「阳光云迭代项目」把 iframe 建起来，
# 再进「项目计划」切到宽表 Tab —— iframe 会在侧栏收起引发的 resize 里反向请求展开
# 用法: _audit-sidebar-repro.sh <port> <label>
PORT=$1; LABEL=$2
S=rp$RANDOM
A="timeout 40 agent-browser --session $S"
click() { $A eval "(()=>{const e=[...document.querySelectorAll('*')].filter(x=>x.children.length===0&&x.textContent.trim()==='$1');if(!e.length)return 0;e[0].click();return 1})()" >/dev/null 2>&1; }

echo "=============== $LABEL ==============="
for VW in 1280 1440 1600; do
  $A open "http://localhost:$PORT/api/plan/config" >/dev/null 2>&1
  $A set viewport $VW 900 >/dev/null 2>&1
  $A eval "localStorage.setItem('wb_who','审计员');localStorage.removeItem('sidebar_collapsed');1" >/dev/null 2>&1
  $A open "http://localhost:$PORT/platform.html" >/dev/null 2>&1
  sleep 2
  # ★ 关键前置：先进迭代模块，把 iframe 创建出来
  click "阳光云迭代项目"; sleep 3
  IFR=$($A eval "(()=>{const f=document.getElementById('iterationFrame');return f?('iframe存在 loaded='+!!(f.contentDocument&&f.contentDocument.body)):'无iframe'})()" 2>&1|tail -1)
  # 再进项目计划
  click "项目计划"; sleep 2.5
  $A eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/新建计划/.test(x.textContent));b.click();return 1})()" >/dev/null 2>&1
  sleep 2
  for T in overview market reference; do
    $A eval "(()=>{document.querySelector('[data-form-tab=\"basic\"]').click();return 1})()" >/dev/null 2>&1
    sleep 0.8
    $A eval "$(cat _audit-sidebar-watch.js)" >/dev/null 2>&1
    $A eval "(()=>{document.querySelector('[data-form-tab=\"$T\"]').click();return 1})()" >/dev/null 2>&1
    sleep 2.0
    LOG=$($A eval "JSON.stringify(window.__sbLog)" 2>&1 | tail -1)
    STATE=$($A eval "JSON.stringify($(cat _audit-sidebar.js))" 2>&1 | tail -1)
    echo "$LOG|$STATE" | python3 -c "
import json,sys
logs,state=sys.stdin.read().strip().split('|',1)
L=json.loads(json.loads(logs)); S=json.loads(json.loads(state))
flips=len(L)-1
seq=' -> '.join(('收' if e['collapsed'] else '展')+'@'+str(e['t'])+'ms' for e in L)
print('  [${VW}px/${T}] 翻转%d次 %s | %s | 终态:%s %s' % (
  flips, '★震荡' if flips>1 else '稳定', seq,
  '收起' if S['collapsed'] else '展开', '表格被裁' if S['clipped'] else '表格完整'))
" 2>/dev/null || echo "  [${VW}px/${T}] parse-fail $LOG"
  done
  echo "     ($IFR)"
done
