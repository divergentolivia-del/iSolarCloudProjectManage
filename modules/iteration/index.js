/* modules/iteration/index.js — 阳光云迭代项目客户端模块（占位）
   现阶段为占位实现：显示加载提示和到原版工作台的链接。
   完整的 app.js 迁移为独立任务，后续迭代完成。
*/

// eslint-disable-next-line no-unused-vars
const IterationModule = (() => {
  'use strict';

  let container = null;
  let initialized = false;

  /**
   * 渲染迭代工作台内容
   * 当前以 iframe 嵌入原始 index.html 以保持完整功能
   */
  function renderContent() {
    if (!container) return;

    container.innerHTML = `
      <div class="iteration-module">
        <iframe
          src="/index.html"
          class="iteration-iframe"
          id="iterationFrame"
          frameborder="0"
          style="width:100%;height:calc(100vh - 120px);border:none;"
        ></iframe>
      </div>
    `;
  }

  /* ---------- ModuleDefinition 接口 ---------- */

  return {
    id: 'iteration',
    name: '阳光云迭代项目',
    icon: '📊',
    order: 1,
    sidebar: true,

    /**
     * init(container, context) — 首次进入模块
     */
    init(el, context) {
      container = el;
      initialized = true;
      renderContent();
    },

    /**
     * enter(subPath) — 重新进入模块
     */
    enter(subPath) {
      // If iframe exists, it maintains its own state
      // Just ensure it's visible (handled by router container switching)
      if (!initialized) {
        renderContent();
        initialized = true;
      }
    },

    /**
     * leave() — 离开模块
     */
    leave() {
      // iframe preserves its state, no cleanup needed
    },

    /**
     * getSummary() — 返回仪表盘摘要
     */
    getSummary() {
      return { deviation: 0, cycleName: '—' };
    }
  };
})();
