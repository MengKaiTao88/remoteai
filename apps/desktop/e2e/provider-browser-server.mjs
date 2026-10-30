import { createServer } from 'node:http';

const records = [];
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
for (const port of [1500, 1501]) {
  createServer((req, res) => {
    if (req.url === '/records') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(records)); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    records.push({ port, url: req.url, header: req.headers['x-provider-test'] ?? null });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Gateway Console</title>
      <style>body{font:15px system-ui;margin:0;background:#f5f7fb;color:#25324b}header{padding:22px 32px;background:white;
      border-bottom:1px solid #e0e5ee;display:flex;justify-content:space-between}main{padding:32px}h1{font-size:26px}
      .grid{display:flex;gap:20px;margin:24px 0}.card{background:white;border:1px solid #e0e5ee;border-radius:14px;padding:24px;
      flex:1}.card strong{display:block;font-size:30px;margin-top:16px}code{display:block;background:#edf2fa;padding:16px;
      border-radius:8px;word-break:break-all}nav{display:flex;gap:20px}a{color:#5269ca}small{color:#7a869e}</style>
      <header><b>Gateway Console</b><small>Provider browser verification</small></header><main>
      <h1>${url.pathname === '/dashboard' ? '账户概览' : '页面导航验证'}</h1>
      <div class="grid"><div class="card">可用余额<strong>$128.00</strong></div>
      <div class="card">本月调用<strong>2,480</strong></div><div class="card">服务状态<strong>正常</strong></div></div>
      <section class="card"><h2>页面访问配置</h2><p>收到的查询参数</p><code id="query">${escape(url.search)}</code>
      <p>收到的自定义请求头</p><code id="header">${escape(req.headers['x-provider-test'] ?? 'none')}</code></section>
      <nav style="margin-top:24px"><a href="/next">下一页</a><a href="/popup" target="_blank">在新标签中打开</a>
      <a href="http://127.0.0.1:1501/cross-origin">跨站页面</a></nav></main></html>`);
  }).listen(port, '127.0.0.1', () => console.log(`provider browser fixture listening: ${port}`));
}
