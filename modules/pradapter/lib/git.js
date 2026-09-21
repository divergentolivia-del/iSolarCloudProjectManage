/* modules/pradapter/lib/git.js — Git 仓库采集（本地 git 命令，内网可用）
   master §4.3：采集信号 = 标题、分支名、作者、时间线。
   真实 PR 聚合（GitHub/GitLab API）留到 M2-C 接入时按 API 补充。 */

'use strict';

const { execFileSync } = require('child_process');

const MAX_COMMITS_PER_BRANCH = 100;

/**
 * 采集单个仓库。
 * @param {{id?:string, name:string, path:string, module?:string}} repo
 * @returns {{id:string, name:string, path:string, ok:boolean, error:string|null,
 *            branches:string[], commits:Array, lastCommitAt:string|null}}
 */
function collectRepo(repo) {
  const id = repo.id || repo.name;
  const out = {
    id, name: repo.name, path: repo.path, module: repo.module || '',
    ok: false, error: null,
    branches: [], commits: [], lastCommitAt: null
  };
  try {
    const branches = execFileSync(
      'git', ['-C', repo.path, 'branch', '--format=%(refname:short)'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).split('\n').map(s => s.trim()).filter(Boolean);

    out.branches = branches;
    for (const br of branches) {
      const raw = execFileSync(
        'git', ['-C', repo.path, 'log', br, '-n', String(MAX_COMMITS_PER_BRANCH),
          '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\x1f');
        const [hash, author, email, at] = parts;
        out.commits.push({
          repoId: id, branch: br, hash, author, email, at,
          subject: parts.slice(4).join('\x1f').trim() || '(no message)'
        });
      }
    }
    out.ok = true;
    if (out.commits.length) {
      out.lastCommitAt = out.commits.map(c => c.at).sort().pop();
    }
  } catch (e) {
    const stderr = (e && e.stderr ? String(e.stderr) : '').trim();
    out.error = stderr || String((e && e.message) || e).split('\n')[0];
  }
  return out;
}

/** 采集仓库列表。单个失败不阻塞其余。 */
function collectAll(repos) {
  const results = [];
  for (const r of repos || []) results.push(collectRepo(r));
  return results;
}

module.exports = { collectRepo, collectAll };