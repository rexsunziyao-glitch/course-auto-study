/* 网课挂机助手 · 核心（content.js）
 * 以 world=MAIN 注入，配合 gate.js 的放行结论工作。
 * 放行了才开工；没放行就一动不动。 */
(function () {
  'use strict';

  /* ============================================================
   *  配置区 —— 想改行为改这里就够了
   * ============================================================ */
  const CFG = {
    // —— 核心保活 ——
    spoofVisible: true,        // 伪装"页面可见 + 有焦点"，切标签页/切窗口都不影响
    simulateActivity: true,    // 定期在播放器上制造鼠标微动（应对"鼠标不动就暂停"的检测）
    simulateIntervalMs: 25000, // 微动间隔（毫秒）

    // —— 播放控制 ——
    autoPlay: true,            // 掉线/被暂停时自动续播
    autoResumeDelayMs: 800,    // 检测到暂停后，等多久再续播（太快会打架）
    muteDefault: true,         // 静音（浏览器允许自动播放的前提）
    playbackRate: 1,           // 倍速。1 = 正常速度。调大等于少看，自行承担风险
    retryOnError: true,        // 播放报错自动重试
    maxRetries: 5,

    // —— 弹窗处理 ——
    autoDismissDialog: true,   // 自动点掉"您还在学习吗"这类弹窗
    notifyInsteadOfDismiss: false, // true = 只弹桌面通知提醒你，不替你点（更保守，但你必须人在）
    dismissCooldownMs: 4000,   // 两次点击之间的最短间隔，防止误点
    // ★ 安全闸门：弹窗内容必须命中"学习语境"关键词，才允许自动点击。
    //   关掉它 = 任何带"确定"的弹窗都会被点，装在通用站点上很危险。
    //   打开它 = 聊天框的"确认删除"、银行页的"确认转账"这类绝不会被误点。
    dialogMustMatchLearn: true,

    // —— 章节推进 ——
    autoNext: true,            // 本节播完自动点"下一节"

    // —— 界面 ——
    showPanel: true,           // 右下角控制面板
    verbose: true              // 把动作写进控制台
  };

  /* ============================================================
   *  运行状态
   * ============================================================ */
  const S = {
    booted: false,          // 是否已经开工（门控放行后才会置 true）
    disabled: false,        // 用户主动点「关闭」后置 true，停止一切自动操作
    startedAt: Date.now(),
    videos: new Set(),
    currentVideo: null,
    userPausedUntil: 0,     // 用户手动暂停后的"免打扰"截止时间戳
    lastDismissAt: 0,
    lastActivityAt: 0,
    logs: [],
    netLog: [],             // 记录到的疑似进度上报请求
    dialogsSeen: [],
    clicks: [],
    retries: new WeakMap(),
    timers: [],             // 所有 setInterval/setTimeout 句柄，关闭时统一清除
    mo: null,               // MutationObserver 句柄
    wakeLock: null          // 屏幕常亮句柄
  };

  const FRAME_TAG = (() => {
    try {
      const depth = (() => { let d = 0, w = window; while (w !== w.parent) { d++; w = w.parent; } return d; })();
      return depth === 0 ? 'TOP' : ('iframe L' + depth);
    } catch (e) { return 'iframe?'; }
  })();

  function log(...a) {
    const msg = a.map(x => (typeof x === 'object' ? safeJson(x) : String(x))).join(' ');
    S.logs.push('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg);
    if (S.logs.length > 80) S.logs.shift();
    if (CFG.verbose) console.log('[挂机助手/' + FRAME_TAG + ']', msg);
  }
  function safeJson(o) { try { return JSON.stringify(o); } catch (e) { return String(o); } }

  // —— 定时器统一管理：关闭时能一次性停掉所有后台动作 ——
  function every(fn, ms) { const id = setInterval(fn, ms); S.timers.push(id); return id; }
  function later(fn, ms) { const id = setTimeout(fn, ms); S.timers.push(id); return id; }
  function clearTimers() {
    S.timers.forEach(id => { try { clearInterval(id); } catch (e) {} try { clearTimeout(id); } catch (e) {} });
    S.timers = [];
  }

  /* ============================================================
   *  1. 伪装可见性 / 焦点  ——  必须在 document-start 就装好
   * ============================================================ */
  function spoofVisibility() {
    const def = (obj, prop, getter) => {
      try { Object.defineProperty(obj, prop, { configurable: true, get: getter }); return true; }
      catch (e) { return false; }
    };

    def(Document.prototype, 'hidden', () => false);
    def(Document.prototype, 'visibilityState', () => 'visible');
    def(Document.prototype, 'webkitHidden', () => false);
    def(Document.prototype, 'webkitVisibilityState', () => 'visible');
    def(Document.prototype, 'hasFocus', () => true);
    def(Document.prototype, 'onvisibilitychange', () => null);
    try {
      Object.defineProperty(Document.prototype, 'onvisibilitychange', {
        configurable: true, get: () => null, set: () => {}
      });
    } catch (e) {}

    // 吞掉"页面藏起来了/失焦了"这类事件，页面永远收不到
    const BLOCKED = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide'];
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (BLOCKED.indexOf(type) !== -1 && (this === document || this === window)) {
        log('已拦截监听 → ' + type);
        return;
      }
      return origAdd.call(this, type, fn, opts);
    };

    log('可见性伪装已生效（hidden=false, visibilityState=visible, hasFocus=true）');
  }

  /* ============================================================
   *  2. 网络探针 —— 找出"进度到底怎么上报的"
   * ============================================================ */
  const NET_HINT = /(progress|play|study|learn|time|record|log|heartbeat|course|ware|ele|finish|complete|point|credit|exam|save)/i;

  function hookNetwork() {
    // XHR
    try {
      const oOpen = XMLHttpRequest.prototype.open;
      const oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__guajiUrl = u;
        this.__guajiMethod = m;
        return oOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        const u = this.__guajiUrl;
        if (u && NET_HINT.test(u)) {
          const entry = {
            t: Date.now(), how: 'XHR', method: this.__guajiMethod, url: String(u),
            body: body ? String(body).slice(0, 300) : ''
          };
          try {
            this.addEventListener('load', function () {
              entry.status = this.status;
              entry.resp = String(this.responseText || '').slice(0, 300);
            });
          } catch (e) {}
          S.netLog.push(entry);
          if (S.netLog.length > 60) S.netLog.shift();
          log('↑ 上报请求 ' + entry.method + ' ' + entry.url);
        }
        return oSend.apply(this, arguments);
      };
    } catch (e) { log('XHR hook 失败: ' + e.message); }

    // fetch
    try {
      const oFetch = window.fetch;
      if (oFetch) {
        window.fetch = function (input, init) {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          if (u && NET_HINT.test(u)) {
            const entry = {
              t: Date.now(), how: 'fetch', method: (init && init.method) || 'GET', url: String(u),
              body: init && init.body ? String(init.body).slice(0, 300) : ''
            };
            S.netLog.push(entry);
            if (S.netLog.length > 60) S.netLog.shift();
            log('↑ 上报请求 ' + entry.method + ' ' + entry.url);
          }
          return oFetch.apply(this, arguments);
        };
      }
    } catch (e) { log('fetch hook 失败: ' + e.message); }

    log('网络探针已就位，正在记录疑似进度上报接口');
  }

  /* ============================================================
   *  3. 播放器保活
   * ============================================================ */
  function canAutoPlay(v) {
    return !S.disabled && CFG.autoPlay && Date.now() > S.userPausedUntil;
  }

  function safePlay(v) {
    if (S.disabled || !v || !canAutoPlay(v)) return;
    try {
      if (CFG.muteDefault && !v.muted) v.muted = true;
      if (v.playbackRate !== CFG.playbackRate) {
        v.playbackRate = CFG.playbackRate;
        log('设置倍速 → ' + CFG.playbackRate + 'x');
      }
      const p = v.play();
      if (p && p.catch) {
        p.catch(err => {
          // 浏览器拒绝自动播放：降级为静音再试
          log('播放被拒绝(' + err.name + ')，尝试静音后重试');
          try { v.muted = true; } catch (e) {}
          const p2 = v.play();
          if (p2 && p2.catch) p2.catch(e2 => log('播放仍然失败: ' + e2.name));
        });
      }
    } catch (e) { log('safePlay 异常: ' + e.message); }
  }

  function attachVideo(v) {
    if (!v || S.videos.has(v)) return;
    S.videos.add(v);
    S.currentVideo = v;
    log('发现视频：' + (v.currentSrc || v.src || '(无 src)') + '  时长=' + (isFinite(v.duration) ? fmt(v.duration) : '未知'));

    // 被暂停 → 拉回来
    v.addEventListener('pause', () => {
      later(() => {
        if (S.disabled) return;
        if (!v.paused || v.ended) return;
        log('检测到被暂停 → 自动续播');
        safePlay(v);
      }, CFG.autoResumeDelayMs);
    });

    // 播完
    v.addEventListener('ended', () => {
      log('本节播放结束');
      later(goNext, 3000);
    });

    // 出错 → 重试
    v.addEventListener('error', () => {
      if (!CFG.retryOnError) return;
      const n = (S.retries.get(v) || 0) + 1;
      S.retries.set(v, n);
      if (n > CFG.maxRetries) { log('重试超过 ' + CFG.maxRetries + ' 次，放弃：' + (v.error && v.error.code)); return; }
      log('播放出错，第 ' + n + ' 次重试');
      later(() => { if (!S.disabled) { try { v.load(); safePlay(v); } catch (e) {} } }, 3000);
    });

    // 卡住不动
    let lastTime = -1, stuckTicks = 0;
    every(() => {
      if (S.disabled || v.paused || v.ended) { stuckTicks = 0; return; }
      if (v.currentTime === lastTime && v.readyState >= 2) {
        stuckTicks++;
        if (stuckTicks >= 6) { // ~30s 没动
          log('播放卡住 30s → 触发重载');
          stuckTicks = 0;
          try { v.load(); safePlay(v); } catch (e) {}
        }
      } else { stuckTicks = 0; }
      lastTime = v.currentTime;
    }, 5000);

    // 用户主动点视频 = 想暂停，给他 20 秒自由
    v.addEventListener('click', () => {
      S.userPausedUntil = Date.now() + 20000;
      log('检测到手动点击视频，20 秒内不自动续播');
    });

    safePlay(v);
  }

  function fmt(sec) {
    if (!isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // 递归扫本页 + 同源子框架里的 video
  function scanVideos() {
    try {
      document.querySelectorAll('video').forEach(attachVideo);
      // 同源 iframe 递归
      document.querySelectorAll('iframe').forEach(f => {
        try {
          const d = f.contentDocument;
          if (d) d.querySelectorAll('video').forEach(attachVideo);
        } catch (e) { /* 跨域，交给它自己那层的脚本实例处理 */ }
      });
    } catch (e) {}
  }

  // 监听动态插入的 video（切章节常会换元素）
  function watchDom() {
    try {
      if (S.mo) { try { S.mo.disconnect(); } catch (e) {} }
      S.mo = new MutationObserver(() => {
        if (S.disabled) return;
        scanVideos();
        watchDialogs();
      });
      S.mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { log('MutationObserver 不可用: ' + e.message); }
  }

  /* ============================================================
   *  4. 挂机检测弹窗处理
   * ============================================================ */
  const DIALOG_SELECTOR = '[class*="dialog"],[class*="modal"],[class*="layer"],[class*="popup"],' +
    '[class*="mask"],[class*="alert"],[class*="confirm"],[class*="tips"],[class*="notice"],[role="dialog"]';

  // 点了表示"我在"的按钮文案
  const POSITIVE = ['继续学习', '继续观看', '继续播放', '继续看', '继续', '我还在', '我在',
    '知道了', '我知道了', '确定', '确认', '好的', '好', '是的', '关闭'];

  // 打死不能点的文案（会把课程关掉/跳走）
  const NEGATIVE = ['退出', '放弃', '结束学习', '返回首页', '取消报名', '删除', '不要'];

  // 弹窗必须命中这些词里至少一个，才认为它是"挂机检测弹窗"而非别的东西。
  // 这是把助手装到所有网站上的安全底线。
  const DIALOG_LEARN_HINT = /(还在学习|继续学习|继续观看|继续播放|继续看|是否在学|是否学习|是否观看|确定在学习|离开本页|离开页面|挂机|计时|累计|学时|时长|课件|视频播放|播放中|学习计时|学习进度)/;

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 10;
  }

  function findVisibleDialog() {
    const list = document.querySelectorAll(DIALOG_SELECTOR);
    for (const n of list) {
      if (!isVisible(n)) continue;
      const text = (n.innerText || '').trim();
      if (text.length < 2 || text.length > 400) continue;
      return { node: n, text: text };
    }
    return null;
  }

  function pickPositiveButton(root) {
    const cands = root.querySelectorAll('button,a,input[type=button],input[type=submit],' +
      '[class*="btn"],[class*="button"],span,div,li');
    const scored = [];
    for (const el of cands) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || el.value || '').trim();
      if (!t || t.length > 10) continue;
      if (NEGATIVE.some(n => t.indexOf(n) !== -1)) continue;
      const idx = POSITIVE.findIndex(p => t === p);
      const partial = POSITIVE.findIndex(p => t.indexOf(p) !== -1);
      if (idx === -1 && partial === -1) continue;
      if (el.querySelector('button,a')) continue; // 只取叶子
      scored.push({ el, score: idx !== -1 ? 100 - idx : 50 - partial, len: t.length });
    }
    scored.sort((a, b) => b.score - a.score || a.len - b.len);
    return scored.length ? scored[0].el : null;
  }

  function notify(title, body) {
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body: body });
      } else if (window.Notification && Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    } catch (e) {}
    log('【需要你本人操作】' + title + ' — ' + body);
  }

  function watchDialogs() {
    if (S.disabled || !CFG.autoDismissDialog) return;
    const d = findVisibleDialog();
    if (!d) return;

    const key = d.text.slice(0, 60);
    if (S.dialogsSeen.indexOf(key) !== -1 && Date.now() - S.lastDismissAt < CFG.dismissCooldownMs) return;
    if (Date.now() - S.lastDismissAt < CFG.dismissCooldownMs) return;

    S.dialogsSeen.push(key);
    if (S.dialogsSeen.length > 30) S.dialogsSeen.shift();

    // ★ 安全闸门：内容不像学习相关弹窗 → 一律不点，也不打扰你
    if (CFG.dialogMustMatchLearn && !DIALOG_LEARN_HINT.test(d.text)) {
      log('出现弹窗，但内容与学习无关 → 不处理：「' + d.text.slice(0, 40) + '…」');
      S.lastDismissAt = Date.now();
      return;
    }

    if (CFG.notifyInsteadOfDismiss) {
      notify('课件页出现弹窗', d.text.slice(0, 80));
      S.lastDismissAt = Date.now();
      return;
    }

    const btn = pickPositiveButton(d.node);
    if (btn) {
      S.lastDismissAt = Date.now();
      const label = (btn.innerText || btn.value || '').trim();
      log('自动点击弹窗按钮：「' + label + '」（弹窗内容：' + d.text.slice(0, 40) + '…）');
      S.clicks.push({ t: Date.now(), text: label, ctx: d.text.slice(0, 60) });
      if (S.clicks.length > 20) S.clicks.shift();
      try { btn.click(); } catch (e) { log('点击失败: ' + e.message); }
    } else {
      // 找不到明确的正面按钮：只提醒，别乱点
      if (S.dialogsSeen.indexOf(key) === -1 || S.dialogsSeen.filter(x => x === key).length < 2) {
        notify('课件页出现未识别的弹窗', d.text.slice(0, 80));
      }
      S.lastDismissAt = Date.now();
      log('弹窗内没找到可点的正面按钮，已改为提醒：「' + d.text.slice(0, 60) + '…」');
    }
  }

  /* ============================================================
   *  5. 自动下一节
   * ============================================================ */
  const NEXT_TEXTS = ['下一节', '下一课件', '下一个课件', '下一讲', '下一章', '下一部分', '继续学习', '下一步', '下一课'];

  function goNext() {
    if (S.disabled || !CFG.autoNext) return;
    const cands = document.querySelectorAll('button,a,[class*="btn"],[class*="button"],span,li');
    for (const el of cands) {
      if (!isVisible(el)) continue;
      if (el.querySelector('button,a')) continue;
      const t = (el.innerText || '').trim();
      if (!t || t.length > 12) continue;
      if (NEXT_TEXTS.some(n => t === n || t.indexOf(n) !== -1)) {
        log('本节结束 → 点击「' + t + '」');
        try { el.click(); return true; } catch (e) {}
      }
    }

    // 兜底：课件只有 1 个时，通常意味着整门学完
    log('没找到"下一节"按钮。若本课程只有 1 个课件，说明已学到最后。挂机助手继续待命。');
    notify('课件播放完毕', '没有找到下一节入口，请手动确认是否已学完本课程。');
    return false;
  }

  /* ============================================================
   *  6. 模拟鼠标活动
   * ============================================================ */
  function startActivitySim() {
    if (!CFG.simulateActivity) return;
    every(() => {
      if (S.disabled) return;
      const v = S.currentVideo;
      if (!v) return;
      const r = v.getBoundingClientRect();
      if (r.width < 10) return;
      const x = r.left + r.width * (0.3 + Math.random() * 0.4);
      const y = r.top + r.height * (0.3 + Math.random() * 0.4);
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      // 注意：合成事件的 isTrusted=false，能骗过大部分平台，但骗不过特意校验的
      try {
        v.dispatchEvent(new MouseEvent('mousemove', opts));
        (v.parentElement || v).dispatchEvent(new MouseEvent('mousemove', opts));
      } catch (e) {}
      S.lastActivityAt = Date.now();
    }, CFG.simulateIntervalMs);
  }

  /* ============================================================
   *  7. 屏幕常亮（防止系统休眠导致视频停住）
   * ============================================================ */
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) {
        S.wakeLock = await navigator.wakeLock.request('screen');
        log('已申请屏幕常亮');
      }
    } catch (e) { log('屏幕常亮申请失败（不影响使用）'); }
  }

  /* ============================================================
   *  8. 右下角控制面板
   * ============================================================ */
  let panel = null, uiRefs = {};
  let UI_show = () => {};

  function buildPanel() {
    if (panel || !CFG.showPanel) return;
    if (!document.body) return;

    const host = document.createElement('div');
    host.id = 'guaji-assistant-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:14px;bottom:14px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .wrap{font:12px/1.5 -apple-system,"Hiragino Sans GB","Microsoft YaHei",sans-serif;
              background:rgba(20,22,28,.92);color:#e8eaed;border-radius:10px;
              box-shadow:0 6px 24px rgba(0,0,0,.35);width:262px;overflow:hidden;
              backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12)}
        .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.06);cursor:default}
        .dot{width:8px;height:8px;border-radius:50%;background:#34d399;flex:0 0 auto;box-shadow:0 0 6px #34d399}
        .dot.off{background:#f87171;box-shadow:0 0 6px #f87171}
        .ttl{font-weight:600;flex:1;font-size:12px}
        .mini{cursor:pointer;opacity:.7;padding:0 4px;font-size:14px;line-height:1}
        .mini:hover{opacity:1}
        .mini.off:hover{color:#f87171}
        .bd{padding:9px 10px}
        .row{display:flex;justify-content:space-between;gap:8px;margin-bottom:5px}
        .k{opacity:.6}
        .v{font-variant-numeric:tabular-nums;text-align:right}
        .bar{height:4px;background:rgba(255,255,255,.14);border-radius:2px;overflow:hidden;margin:6px 0 8px}
        .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#34d399,#60a5fa);transition:width .4s}
        .btns{display:flex;gap:5px;flex-wrap:wrap}
        button{font:11px/1 inherit;color:#e8eaed;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);
               border-radius:5px;padding:5px 8px;cursor:pointer;flex:1;white-space:nowrap}
        button:hover{background:rgba(255,255,255,.2)}
        button.on{background:rgba(52,211,153,.25);border-color:rgba(52,211,153,.5)}
        .logbox{margin-top:8px;max-height:96px;overflow:auto;font-size:10.5px;line-height:1.45;
                background:rgba(0,0,0,.3);border-radius:5px;padding:5px 6px;color:#b6bcc8}
        .logbox div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        textarea{width:100%;height:130px;margin-top:6px;font:10px/1.4 ui-monospace,Menlo,monospace;
                 background:rgba(0,0,0,.45);color:#9fe8c8;border:1px solid rgba(255,255,255,.16);
                 border-radius:5px;padding:5px;resize:vertical;box-sizing:border-box}
        .hidden{display:none!important}
        .pill{cursor:pointer;background:rgba(20,22,28,.9);color:#34d399;border-radius:20px;
              padding:4px 10px;font:11px/1 sans-serif;border:1px solid rgba(255,255,255,.15)}
      </style>
      <div class="wrap" id="wrap">
        <div class="hd">
          <span class="dot" id="dot"></span>
          <span class="ttl">挂机助手 · <span id="frame"></span></span>
          <span class="mini off" id="btnOff" title="关闭挂机助手">✕</span>
          <span class="mini" id="btnMin" title="收起">—</span>
        </div>
        <div class="bd" id="bd">
          <div class="row"><span class="k">状态</span><span class="v" id="st">初始化…</span></div>
          <div class="row"><span class="k">进度</span><span class="v" id="pg">--:-- / --:--</span></div>
          <div class="bar"><i id="pbar"></i></div>
          <div class="row"><span class="k">已运行</span><span class="v" id="up">00:00:00</span></div>
          <div class="row"><span class="k">上报接口</span><span class="v" id="net">0</span></div>
          <div class="btns">
            <button id="bPause">暂停</button>
            <button id="bMute">静音</button>
            <button id="bDiag">诊断</button>
          </div>
          <div class="logbox" id="logbox"></div>
          <div id="diagWrap" class="hidden">
            <textarea id="diagTa" readonly></textarea>
            <div class="btns" style="margin-top:5px">
              <button id="bCopy">复制报告</button>
              <button id="bRefresh">刷新</button>
            </div>
          </div>
        </div>
      </div>
      <div class="pill hidden" id="pill">▶ 挂机中</div>
    `;
    document.body.appendChild(host);
    panel = host;

    const $ = id => sh.getElementById(id);
    uiRefs = {
      dot: $('dot'), frame: $('frame'), st: $('st'), pg: $('pg'), pbar: $('pbar'), up: $('up'),
      net: $('net'), logbox: $('logbox'), bd: $('bd'), wrap: $('wrap'), pill: $('pill'),
      diagWrap: $('diagWrap'), diagTa: $('diagTa'), bPause: $('bPause'), bMute: $('bMute')
    };
    uiRefs.frame.textContent = FRAME_TAG;

    $('btnMin').onclick = () => {
      uiRefs.bd.classList.add('hidden');
      uiRefs.pill.classList.remove('hidden');
    };
    UI_show = () => {
      uiRefs.bd.classList.remove('hidden');
      uiRefs.wrap.classList.remove('hidden');
      uiRefs.pill.classList.add('hidden');
    };
    uiRefs.pill.onclick = () => {
      if (S.disabled) {
        // 关闭态：刷新页面，脚本重新注入后自动恢复挂机
        log('重新挂机 → 刷新页面');
        location.reload();
      } else {
        UI_show();
      }
    };
    $('btnOff').onclick = () => disableAll();

    uiRefs.bPause.onclick = () => {
      const v = S.currentVideo;
      if (!v) return;
      if (v.paused) { S.userPausedUntil = 0; safePlay(v); log('手动恢复播放'); }
      else { S.userPausedUntil = Date.now() + 3600e3; v.pause(); log('手动暂停（1小时内不自动续播）'); }
    };
    uiRefs.bMute.onclick = () => {
      const v = S.currentVideo;
      if (!v) return;
      v.muted = !v.muted;
      CFG.muteDefault = v.muted;
      log('静音 → ' + (v.muted ? '开' : '关'));
      syncButtons();
    };
    $('bDiag').onclick = () => {
      uiRefs.diagWrap.classList.toggle('hidden');
      if (!uiRefs.diagWrap.classList.contains('hidden')) uiRefs.diagTa.value = buildReport();
    };
    $('bRefresh').onclick = () => { uiRefs.diagTa.value = buildReport(); };
    $('bCopy').onclick = () => {
      uiRefs.diagTa.value = buildReport();
      uiRefs.diagTa.select();
      try { document.execCommand('copy'); log('诊断报告已复制到剪贴板'); } catch (e) {}
    };

    every(tick, 1000);
    log('控制面板已就绪');
  }

  function syncButtons() {
    const v = S.currentVideo;
    if (!uiRefs.bPause) return;
    uiRefs.bPause.textContent = v && !v.paused ? '暂停' : '播放';
    uiRefs.bMute.textContent = v && v.muted ? '已静音' : '有声';
    uiRefs.bMute.classList.toggle('on', !!(v && v.muted));
  }

  function tick() {
    const v = S.currentVideo;
    if (uiRefs.dot) {
      const ok = v && !v.paused && !v.ended;
      uiRefs.dot.classList.toggle('off', !ok);
      uiRefs.st.textContent = !v ? '未找到视频' : (v.ended ? '已播完' : (v.paused ? '已暂停' : '播放中'));
      uiRefs.pg.textContent = v ? (fmt(v.currentTime) + ' / ' + fmt(v.duration)) : '--:-- / --:--';
      uiRefs.pbar.style.width = (v && isFinite(v.duration) && v.duration > 0)
        ? ((v.currentTime / v.duration * 100).toFixed(1) + '%') : '0';
      const el = Math.floor((Date.now() - S.startedAt) / 1000);
      uiRefs.up.textContent = [Math.floor(el / 3600), Math.floor(el % 3600 / 60), el % 60]
        .map(n => String(n).padStart(2, '0')).join(':');
      uiRefs.net.textContent = S.netLog.length;
      uiRefs.logbox.innerHTML = S.logs.slice(-6).reverse()
        .map(t => '<div title="' + t.replace(/"/g, '') + '">' + t.replace(/[[\]]/g, '') + '</div>').join('');
      if (uiRefs.pill) {
        uiRefs.pill.textContent = S.disabled
          ? '⏹ 已关闭 · 点此刷新恢复'
          : ((v && !v.paused ? '▶ 挂机中 ' : '⏸ 已停 ') + fmt(v ? v.currentTime : 0));
      }
      syncButtons();
    }
  }

  /* ============================================================
   *  8b. 关闭 / 恢复
   * ============================================================ */
  function disableAll() {
    if (S.disabled) return;
    S.disabled = true;
    log('⛔ 挂机助手已关闭：停止自动续播 / 防暂停 / 自动点弹窗 / 模拟活动');

    clearTimers();
    if (S.mo) { try { S.mo.disconnect(); S.mo = null; } catch (e) {} }
    if (S.wakeLock) { try { S.wakeLock.release(); } catch (e) {} S.wakeLock = null; }

    // 暂停当前所有视频，停止播放
    try {
      document.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
    } catch (e) {}
    S.userPausedUntil = Date.now() + 3600e3; // 关闭期间绝不自动续播

    // UI：藏起面板，只留一个可恢复的浮标
    if (uiRefs.dot) uiRefs.dot.classList.add('off');
    if (uiRefs.st) uiRefs.st.textContent = '已关闭';
    if (uiRefs.wrap) uiRefs.wrap.classList.add('hidden');
    if (uiRefs.pill) {
      uiRefs.pill.classList.remove('hidden');
      uiRefs.pill.textContent = '⏹ 已关闭 · 点此刷新恢复';
    }
  }

  /* ============================================================
   *  9. 诊断报告 —— 跑一次贴给我，就能精准校准
   * ============================================================ */
  function describeEl(el) {
    if (!el) return null;
    let cls = '';
    try { cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 90) : ''; } catch (e) {}
    return {
      tag: el.tagName,
      id: el.id || undefined,
      cls: cls || undefined,
      text: (el.innerText || el.value || '').trim().slice(0, 30) || undefined,
      visible: isVisible(el)
    };
  }

  function buildReport() {
    const vids = [];
    try {
      document.querySelectorAll('video').forEach((v, i) => vids.push({
        i: i,
        src: (v.currentSrc || v.src || '').slice(0, 160),
        tagSrc: v.getAttribute('src') || undefined,
        sources: [...v.querySelectorAll('source')].map(s => s.src || s.getAttribute('src')),
        duration: isFinite(v.duration) ? v.duration : null,
        currentTime: v.currentTime,
        paused: v.paused, ended: v.ended, muted: v.muted, rate: v.playbackRate,
        readyState: v.readyState, networkState: v.networkState,
        poster: v.getAttribute('poster') || undefined
      }));
    } catch (e) {}

    const frames = [];
    try {
      document.querySelectorAll('iframe').forEach((f, i) => {
        let same = false, innerV = 0;
        try { const d = f.contentDocument; if (d) { same = true; innerV = d.querySelectorAll('video').length; } } catch (e) {}
        frames.push({ i: i, src: (f.src || '').slice(0, 160), id: f.id || undefined,
                      cls: (typeof f.className === 'string' ? f.className.slice(0, 60) : undefined) || undefined,
                      sameOrigin: same, innerVideos: innerV });
      });
    } catch (e) {}

    const interactive = [];
    try {
      document.querySelectorAll('button,a,[role=button],[class*="btn"],[class*="button"],[onclick]')
        .forEach(el => {
          const d = describeEl(el);
          if (d && d.visible && d.text) interactive.push(d);
        });
    } catch (e) {}

    const dlg = findVisibleDialog();

    return JSON.stringify({
      report_at: new Date().toISOString(),
      page: {
        url: location.href, title: document.title,
        inIframe: window.top !== window.self, frame: FRAME_TAG,
        readyState: document.readyState,
        visibility_spoofed: CFG.spoofVisible,
        docHidden: document.hidden, docVisibility: document.visibilityState,
        hasFocus: (() => { try { return document.hasFocus(); } catch (e) { return null; } })(),
        screen: window.screen.width + 'x' + window.screen.height
      },
      videos: vids,
      iframes: frames,
      dialog_now: dlg ? { text: dlg.text.slice(0, 200), cls: (typeof dlg.node.className === 'string' ? dlg.node.className.slice(0, 80) : '') } : null,
      interactive_elements: interactive.slice(0, 100),
      network_calls_hinted: S.netLog.slice(-40),
      auto_clicked: S.clicks,
      scripts: [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 40),
      localStorage_keys: (() => { try { return Object.keys(localStorage).slice(0, 40); } catch (e) { return []; } })(),
      logs: S.logs.slice(-40)
    }, null, 2);
  }

  /* ============================================================
   *  启动（门控版）
   * ------------------------------------------------------------
   *  gate.js 已比本文件先执行，并给出结论。
   *  只有 allow=true 才真正开工；否则完全静默，
   *  只留一个监听器等着"有人手动启用"（弹窗按钮 / 快捷键）。
   * ============================================================ */
  function boot() {
    if (CFG.spoofVisible) spoofVisibility(); // 有些页面会在中途重新定义，补一刀
    scanVideos();
    watchDom();
    startActivitySim();
    keepAwake();

    // 定期巡逻
    every(() => {
      if (S.disabled) return;
      scanVideos();
      watchDialogs();
      const v = S.currentVideo;
      if (v && v.paused && !v.ended && canAutoPlay(v)) safePlay(v);
    }, 2000);

    // 面板：有视频的框架，或者顶层框架
    const hasVideoAnywhere = () => {
      if (document.querySelector('video')) return true;
      let found = false;
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument && f.contentDocument.querySelector('video')) found = true; } catch (e) {}
      });
      return found;
    };
    later(() => {
      if (hasVideoAnywhere() || window.top === window.self) buildPanel();
    }, 1200);
    log('挂机助手启动 | ' + FRAME_TAG + ' | ' + location.pathname);
  }

  function startAll() {
    if (S.booted) return;          // 只开工一次
    S.booted = true;
    if (CFG.spoofVisible) spoofVisibility();
    hookNetwork();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
    window.addEventListener('load', () => later(scanVideos, 1500));
  }

  const GATE = window.__GUAJI_GATE__;

  if (!GATE || GATE.allow) {
    // 已放行（或门控缺席，保持旧行为）
    startAll();
  } else {
    // 未放行：本页完全不受影响。等一个手动启用信号再开工。
    log('已待命，本页未启用 —— ' + GATE.reason);
    window.addEventListener('guaji:activate', startAll, { once: true });
  }
})();
