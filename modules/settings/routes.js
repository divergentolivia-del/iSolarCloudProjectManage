// modules/settings/routes.js — 系统设置模块（纯客户端，服务端无需路由）
'use strict';
module.exports = {
  id: 'settings',
  prefix: '/api/settings',
  ensureData() {},
  handle(req, res) {
    const body = JSON.stringify({ error: 'Not Found' });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(body);
  }
};
