#!/usr/bin/env node
/* ============================================================
 *  网课挂机助手 · 扩展装载器（Node 版）
 *  ------------------------------------------------------------
 *  Chrome 137 起官方移除了 --load-extension 参数，所以只能走
 *  DevTools 调试协议，把扩展"现场装进去"。
 *
 *  用法：
 *    node cdp-load.mjs <扩展目录> [端口]     装载扩展
 *    node cdp-load.mjs --version [端口]      自检（只读，不改状态）
 *
 *  退出码：0 = 成功/已装载   1 = 失败   2 = 参数错误
 * ============================================================ */

const PORT = process.env.CDP_PORT || process.argv[3] || process.argv[2];
const arg = process.argv[2];

let port = '9222';
let mode = 'load';
let extPath = '';

if (arg === '--version') {
  port = process.argv[3] || '9222';
  mode = 'version';
} else {
  extPath = arg || '';
  port = process.argv[3] || '9222';
}

if (mode === 'load' && !extPath) {
  console.error('用法: cdp-load.mjs <扩展目录> [端口]');
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;

/* ---------- 建立 WebSocket ---------- */
async function connect() {
  let v;
  try {
    const r = await fetch(`${base}/json/version`);
    v = await r.json();
  } catch (e) {
    throw new Error('调试端口 ' + port + ' 没有响应（Chrome 没起来？）');
  }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('无法连接调试 WebSocket')), { once: true });
  });
  return ws;
}

function call(ws, method, params) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('等待 ' + method + ' 回复超时')), 20000);
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(t);
      ws.removeEventListener('message', onMsg);
      res(m);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
  });
}

/* ---------- 主流程 ---------- */
try {
  const ws = await connect();

  if (mode === 'version') {
    const r = await call(ws, 'Browser.getVersion');
    console.log('OK ' + r.result.product);
    ws.close();
    process.exit(0);
  }

  let r = await call(ws, 'Extensions.loadUnpacked', { path: extPath });

  if (r.error) {
    const s = JSON.stringify(r.error);
    // 已经装过了（同一路径重复装载）—— 视为成功
    if (/already|duplicate|exists|同一个|loaded/i.test(s)) {
      console.log('ALREADY 扩展此前已装载');
      ws.close();
      process.exit(0);
    }
    console.error('FAIL ' + s);
    ws.close();
    process.exit(1);
  }

  console.log('OK 扩展已装载，ID = ' + (r.result && r.result.id));
  ws.close();
  process.exit(0);
} catch (e) {
  console.error('FAIL ' + e.message);
  process.exit(1);
}
