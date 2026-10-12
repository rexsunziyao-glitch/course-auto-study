/* 网课挂机助手 · 弹窗（popup.js） */
'use strict';

const $ = (s) => document.querySelector(s);

/* 与 gate.js 保持完全一致的口径，避免"弹窗说会启用、实际没启用" */
const STRONG = /(courseware|course[_\-]?ele|eleview|wareindex|wareid|lessonid|chapterid|jiangyi|kecheng|jxjy|elearning|continuing|studycourse|examid|course\/play|video\/play|play\/video|media\/play|videoplay|ware\/play)/i;
const WEAK = /(course|lesson|study|learn|train|class|exam|video|player|ware|chapter|kecheng|jiangyi|jxjy|edu)/i;

let currentTab = null;

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0];

  if (!currentTab) {
    $('#site').textContent = '（无法读取）';
    $('#verdict').textContent = '请切到一个网页再打开本弹窗';
    return;
  }

  const url = currentTab.url || '';
  let host = url;
  try { host = new URL(url).hostname || url; } catch (e) {}
  $('#site').textContent = host;
  $('#site').title = url;

  const v = $('#verdict');
  if (!/^https?:/i.test(url)) {
    v.textContent = '⏸ 此页面类型不支持（非普通网页）';
    return;
  }
  if (STRONG.test(url)) {
    v.textContent = '✅ 会自动启用 —— 打开就该看到右下角面板';
    v.classList.add('ok');
    return;
  }
  if (WEAK.test(url)) {
    v.textContent = '⏳ 待命中 —— 出现视频后会自动启用';
    return;
  }
  v.textContent = '⏸ 不像课件页。若确实是，点下面的按钮';
}

$('#force').addEventListener('click', async () => {
  if (!currentTab) return;
  try {
    // 直接在主世界里调用门控的放行函数 —— 不需要额外的中转脚本
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      world: 'MAIN',
      func: () => {
        try {
          if (window.__GUAJI_ENABLE__) window.__GUAJI_ENABLE__('弹窗按钮');
        } catch (e) {}
      }
    });
    $('#result').textContent = '已启用。回页面看右下角面板。';
  } catch (e) {
    $('#result').textContent = '启用失败：' + e.message;
    $('#result').style.color = '#f87171';
  }
});

$('#reload').addEventListener('click', () => {
  if (currentTab) chrome.tabs.reload(currentTab.id);
});

init();
