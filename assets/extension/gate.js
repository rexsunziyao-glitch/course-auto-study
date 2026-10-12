/* ============================================================
 *  网课挂机助手 · 激活门控（gate.js）
 *  ------------------------------------------------------------
 *  这个文件会注入到**所有**网页、所有框架，而且是最早执行的。
 *  它的唯一职责是回答一个问题：
 *
 *      「这个页面，到底是不是网课/继续教育的课件页？」
 *
 *  三种结局：
 *    auto   —— 命中学习类特征 → 立刻全套启用（防切页、续播、面板）
 *    probe  —— 像但不确定 → 安静待命，一旦出现"长视频"就自动启用
 *    inert  —— 完全不像 → 什么都不做，绝不干扰本页
 *
 *  安全性设计：非课件页只是"看着"，不劫持事件、不改 DOM、不点任何按钮。
 *  这样才不会出现"在银行页面上帮你点了『确认转账』"这种事。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__GUAJI_GATE__) return;   // 同一框架内只需装一次

  var G = {
    allow: false,     // 是否已放行（content.js 会读这个）
    mode: 'inert',    // auto | probe | inert
    reason: '',       // 为什么放行/不放行（显示在面板上）
    url: location.href
  };
  window.__GUAJI_GATE__ = G;

  /* 手动放行入口：popup 按钮、快捷键、长视频探测都走这里 */
  window.__GUAJI_ENABLE__ = function (why) {
    if (G.allow) return;
    G.allow = true;
    G.mode = 'manual';
    G.reason = why || '手动启用';
    try {
      window.dispatchEvent(new CustomEvent('guaji:activate'));
    } catch (e) {}
  };

  var PROBE_TIMER = null;

  /** 启动探测：等待"长视频"这个最硬的信号出现 */
  function installProbe() {
    var last = 0;
    var ticks = 0;

    function check() {
      var now = Date.now();
      if (now - last < 700) return;   // 限流，避免被频繁 DOM 变动拖死
      last = now;

      try {
        var vs = document.querySelectorAll('video');
        for (var i = 0; i < vs.length; i++) {
          var v = vs[i];

          // 信号①：时长 ≥ 2 分钟。短视频/广告/预览片不会这么长
          if (isFinite(v.duration) && v.duration >= 120) {
            window.__GUAJI_ENABLE__('探测到长视频 ' + Math.round(v.duration) + ' 秒');
            return;
          }

          // 信号②：视频源是流媒体/视频文件
          var s = String(v.currentSrc || v.src || '');
          if (/\.(m3u8|mp4|flv|f4v|ts)(\?|#|$)/i.test(s)) {
            window.__GUAJI_ENABLE__('探测到视频源');
            return;
          }

          // 信号③：已经在播且有画面
          if (!v.paused && v.readyState >= 2 && v.currentTime > 1) {
            window.__GUAJI_ENABLE__('探测到正在播放的视频');
            return;
          }
        }
      } catch (e) {}

      // 探测窗口约 45 秒，之后彻底静默
      if (++ticks < 30) {
        PROBE_TIMER = setTimeout(check, 1500);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check, { once: true });
    } else {
      check();
    }

    // 动态插入的 video（很多播放器是点击后才创建元素）
    try {
      var mo = new MutationObserver(function () { check(); });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 50000);
    } catch (e) {}
  }

  /* ---------- 判定 ---------- */
  try {
    var href = location.href;
    if (!/^https?:/i.test(href)) {
      G.reason = '非网页（' + href.slice(0, 24) + '）';
      return;
    }

    // 强命中：URL 里带这些词，几乎可以断定是课件/播放页
    var STRONG = /(courseware|course[_\-]?ele|eleview|wareindex|wareid|lessonid|chapterid|jiangyi|kecheng|jxjy|elearning|continuing|studycourse|examid|course\/play|video\/play|play\/video|media\/play|videoplay|ware\/play)/i;

    // 弱命中：学习类站点的一般特征
    var WEAK = /(course|lesson|study|learn|train|class|exam|video|player|ware|chapter|kecheng|jiangyi|jxjy|edu)/i;

    if (STRONG.test(href)) {
      G.allow = true;
      G.mode = 'auto';
      G.reason = 'URL 命中课件特征';
      return;
    }

    if (WEAK.test(href)) {
      G.mode = 'probe';
      G.reason = '疑似学习页面，等待视频出现';
      installProbe();
      return;
    }

    // 完全不像学习页 → 仍然挂一个"长视频探测器"。
    // 因为很多平台的课件地址完全看不出规律（比如 /weixin/90462/subjectList），
    // 但页面上会出现一个 50 分钟的视频 —— 那才是最终判据。
    G.mode = 'probe';
    G.reason = '未见学习特征，等待长视频';
    installProbe();
  } catch (e) {
    G.reason = '门控异常: ' + e.message;
  }

  /* ---------- 快捷键：Alt+Shift+G 手动强制启用 ---------- */
  try {
    window.addEventListener('keydown', function (e) {
      if (e.altKey && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
        window.__GUAJI_ENABLE__('快捷键 Alt+Shift+G');
      }
    }, true);
  } catch (e) {}
})();
