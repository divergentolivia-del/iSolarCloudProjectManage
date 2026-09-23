/* modules/skill/client.js — Skill 前端客户端（按钮 → 运行 → 结果渲染）
   用途：把 Skill 落在业务页面的真实按钮上。
   流程：点击 → POST /api/skill/:id/run → GET /:id/latest → 渲染 output.markdown。
   自带轻量 markdown 渲染（转义 + 标题/列表/粗体/引用）与一键复制。 */
'use strict';

/* eslint-disable no-unused-vars */
const SkillClient = (() => {

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderMarkdown(md) {
    if (!md) return '<p class="sc-empty">（无内容）</p>';
    const lines = String(md).split(/\r?\n/);
    let html = '', inUl = false, inQuote = false;
    const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
    const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };
    const inline = t => esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { closeUl(); closeQuote(); continue; }
      if (t.startsWith('### ')) { closeUl(); closeQuote(); html += '<h5>' + inline(t.slice(4)) + '</h5>'; }
      else if (t.startsWith('## ')) { closeUl(); closeQuote(); html += '<h4>' + inline(t.slice(3)) + '</h4>'; }
      else if (t.startsWith('# ')) { closeUl(); closeQuote(); html += '<h4>' + inline(t.slice(2)) + '</h4>'; }
      else if (t.startsWith('> ')) { closeUl(); if (!inQuote) { html += '<blockquote>'; inQuote = true; } html += '<p>' + inline(t.slice(2)) + '</p>'; }
      else if (/^[-*] /.test(t)) { closeQuote(); if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + inline(t.slice(2)) + '</li>'; }
      else { closeUl(); closeQuote(); html += '<p>' + inline(t) + '</p>'; }
    }
    closeUl(); closeQuote();
    return html;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e2) { return false; }
    }
  }

  function bindCopyOnce() {
    if (SkillClient._copyBound) return;
    SkillClient._copyBound = true;
    document.addEventListener('click', async ev => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-sc-copy]') : null;
      if (!b) return;
      const id = b.getAttribute('data-sc-copy');
      const ta = document.querySelector('[data-sc-text="' + id + '"]');
      const ok = ta ? await copyText(ta.value) : false;
      const orig = b.textContent;
      b.textContent = ok ? '✓ 已复制' : '复制失败';
      setTimeout(() => { if (b.isConnected) b.textContent = orig; }, 1500);
    });
  }

  function resultHtml(skillId, label, r, md) {
    const head = '<div class="sc-head"><span class="sc-badge">' + esc(label) + '</span>'
      + '<span class="sc-meta">生成 ' + (r && r.itemCount != null ? esc(r.itemCount) : '?') + ' 条待确认项'
      + (r && r.expired ? '（' + esc(r.expired) + ' 条旧项已失效）' : '')
      + ' · <a href="#/dashboard/inbox">去今日待确认 →</a></span></div>';
    if (!md) {
      return head + '<p class="sc-empty">' + esc(label) + ' 已完成，无可展示文本，待确认项在「今日待确认」。</p>';
    }
    return head
      + '<div class="sc-markdown">' + renderMarkdown(md) + '</div>'
      + '<button class="sc-copy" data-sc-copy="' + esc(skillId) + '">📋 复制全文</button>'
      + '<textarea class="sc-hidden" data-sc-text="' + esc(skillId) + '">' + esc(md) + '</textarea>';
  }

  /**
   * 运行 Skill 并在目标容器展示结果。
   * @param {string} skillId  wbs / report / charter / retro / stakeholder / meeting
   * @param {object} opts    { target: '#id'|Element, btn: 按钮(可选，运行中禁用), label: 显示名 }
   */
  async function runAndShow(skillId, opts) {
    opts = opts || {};
    const target = typeof opts.target === 'string' ? document.querySelector(opts.target) : opts.target;
    const btn = opts.btn ? (typeof opts.btn === 'string' ? document.querySelector(opts.btn) : opts.btn) : null;
    const label = opts.label || skillId;
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + label + ' 生成中…'; }
    if (target) target.innerHTML = '<p class="sc-loading">⏳ 正在运行 ' + esc(label) + '…</p>';
    try {
      const resp = await fetch('/api/skill/' + encodeURIComponent(skillId) + '/run', { method: 'POST', credentials: 'same-origin' });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok || !r.ok) throw new Error((r && r.error) || ('HTTP ' + resp.status));
      const lr = await fetch('/api/skill/' + encodeURIComponent(skillId) + '/latest', { credentials: 'same-origin' });
      const latest = await lr.json().catch(() => ({}));
      const md = latest && latest.result && latest.result.output && latest.result.output.markdown;
      if (target) target.innerHTML = resultHtml(skillId, label, r, md);
      bindCopyOnce();
      return r;
    } catch (e) {
      if (target) target.innerHTML = '<p class="sc-error">⚠ ' + esc(e.message || String(e)) + '</p>';
      throw e;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  /**
   * 预载最近一次结果（进入页面时展示，不用再点一次）。
   */
  async function preload(skillId, target, label) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    try {
      const r = await (await fetch('/api/skill/' + encodeURIComponent(skillId) + '/latest', { credentials: 'same-origin' })).json();
      if (!r || !r.result || !r.result.output || !r.result.output.markdown) return;
      const at = new Date(r.result.at);
      const when = at.toLocaleDateString('zh-CN') + ' ' + at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = '<div class="sc-head"><span class="sc-badge">' + esc(label || skillId) + '</span>'
        + '<span class="sc-meta">最近一次：' + when + ' · <a href="#/dashboard/inbox">去今日待确认 →</a></span></div>'
        + '<div class="sc-markdown">' + renderMarkdown(r.result.output.markdown) + '</div>'
        + '<button class="sc-copy" data-sc-copy="' + esc(skillId) + '">📋 复制全文</button>'
        + '<textarea class="sc-hidden" data-sc-text="' + esc(skillId) + '">' + esc(r.result.output.markdown) + '</textarea>';
      bindCopyOnce();
    } catch (e) { /* 预载失败不打扰 */ }
  }

  return { esc, renderMarkdown, copyText, runAndShow, preload };
})();