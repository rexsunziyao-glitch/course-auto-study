# 网课挂机助手（course-auto-study）

一个 **WorkBuddy / 豆包 可复用的 Skill**，为「继续教育 / 网课平台」生成一套本机挂机工具
（Chrome 扩展 + macOS 双击即用的 App），把"必须守在这个页面才计时"的网课，变成可以
后台自动播完的课。

> 它和你的日常浏览器完全隔离，互不影响。

---

## 系统要求（务必先看）

**成品 App 只支持 macOS + Google Chrome。** 这是硬约束，不是"体验差异"：

| 环境 | 能否直接用 |
|---|---|
| macOS（Intel / Apple Silicon）+ Chrome | ✅ 双击即用 |
| macOS + Edge / Brave（Chromium） | ⚠️ 扩展兼容，但启动器写死 Chrome 路径，需改 |
| Windows / Linux | ❌ 无对应产物 |
| Safari / Firefox | ❌ 不支持 |

如果你不是 macOS + Chrome，请把整个仓库丢给 **WorkBuddy / 豆包**，让它帮你在
你自己的机器上重新生成（仍需 macOS + Chrome）。

---

## 快速开始

### 方式一：你也在用 WorkBuddy（推荐）

1. 把整个 `course-auto-study` 文件夹放进 `~/.workbuddy/skills/`
2. 在 WorkBuddy 里说：
   > 帮我装一下网课挂机助手，我的课程网址是 https://xxx.com
3. 双击桌面上的「网课挂机助手」，在弹出的干净 Chrome 里登录你的课程平台。

### 方式二：手动装（需要 macOS + Chrome）

打开「终端」，粘下面这行（网址换成你自己的）回车：

```bash
bash scripts/install.sh "https://你的课程平台首页"
```

装完后桌面上会出现「网课挂机助手」，双击即可。

> 第一次双击若提示"来自身份不明的开发者"：去「系统设置 → 隐私与安全性」→「仍要打开」。

---

## 目录结构

```
course-auto-study/
├── SKILL.md              ← WorkBuddy Skill 定义（AI 的说明书）
├── scripts/install.sh    ← 一键安装（铺文件 + 打包 .app + 写配置 + 放桌面）
└── assets/
    ├── extension/        ← Chrome 扩展（Manifest V3，world=MAIN）
    │   ├── manifest.json
    │   ├── content.js    ← 挂机主体（可见性伪装 / 续播 / 弹窗 / 网络探针）
    │   ├── gate.js       ← 激活门控（安全设计，见下）
    │   ├── popup.html / popup.js
    │   └── icon*.png
    └── launcher/
        ├── launch.sh     ← 启动逻辑（含架构自愈）
        ├── cdp-load.mjs / cdp-load.py  ← CDP 扩展装载器（Node/Python 双实现）
        ├── build-app.sh  ← 重新打包
        └── make-icon.py  ← 纯标准库生成图标
```

---

## 它能做什么

| 平台的检查手段 | 扩展的应对 |
|---|---|
| 切标签页 → `document.hidden = true` | 主世界重写，恒定返回 `false` |
| 切窗口 → `blur` / `visibilitychange` | `document-start` 拦掉监听注册 |
| 查 `document.hasFocus()` | 恒定返回 `true` |
| 鼠标不动就暂停 | 定时合成 `mousemove`（随机坐标） |
| "您还在学习吗"弹窗 | 匹配正面文案并自动点击 |
| 系统休眠 | Wake Lock 保持屏幕常亮 |
| 被暂停 / 播放报错 | 自动续播、自动重试；卡死超时自动重载 |
| 一节播完 | 自动点「下一节」 |

进度上报次数会实时显示在面板上，方便判断平台是"心跳累加"还是"整段计时"。

---

## 安全设计（`gate.js`）

扩展虽然注册在宽泛的站点匹配上，但**只有同时满足「这是一张有真实视频的页面」等
学习语境条件时才会真正干活**，否则一声不吭。

原因：`content.js` 里「自动点弹窗」是"看到确认按钮就点下去"。若装到普通网页，
它可能替你点掉 **「确认提交」「删除」「确认转账」**。所以：

- 默认绝不开全局匹配，按平台域名逐个加白名单
- 学习语境判据：页面存在指向视频资源的 `<video>`（`.mp4/.m3u8/blob:`）或明显的
  播放器容器 + 时长 > 60 秒
- 每接入一个新平台，都要在那站上先跑一次、检查面板日志里点过什么

---

## 必须知道的几点（风险）

这类绕过检测的做法处在平台规则的灰区，请自行判断是否使用：

1. **人脸抽查拦不住**——脚本能骗过 DOM，骗不过摄像头；平台若启用，成绩可能作废。
2. **防快进会留违规记录**——多数平台有 `detectFastForward`，跳变会触发回退 + 告警，
   所以倍速必须锁 1x，不要改。
3. **合盖会断网**——扩展能防屏幕休眠，防不住整机睡眠。
4. 提供保守开关 `notifyInsteadOfDismiss`：打开后弹窗只发桌面通知、不替你点，
   由本人过去点一下，稳得多。

---

## 已知的技术坑（已踩过，勿重复）

- **Chrome 137+ 已删除 `--load-extension`**：唯一可行路径是调试协议
  `Extensions.loadUnpacked`，且需 `--enable-unsafe-extension-debugging` 启动。
- **调试协议装的扩展不持久化**：重启后要重装，所以 `launch.sh` 每次启动都装一遍。
- **App 经 LaunchServices 启动后 Chrome 会掉进 Rosetta**：`launch.sh` 内置架构自愈
  （`sysctl.proc_translated` 检测 + `arch -arm64` 重跑）。
- **不要同时装篡改猴脚本和扩展**：双实例会争抢 `video.play()` 并重复点弹窗。

---

## 适配新平台

1. 在 `assets/extension/manifest.json` 的 `content_scripts[].matches` 里加域名
2. 若播放器在第三方 CDN 域名，也要加进去
3. 重新打包：`bash assets/launcher/build-app.sh`
4. 在那站上跑一次，看面板日志确认没有误点

参考：`hzfspx.91cme.com`（浙江省继续医学教育）、`*.100anquan.com`（视频 CDN）。

---

## License

[MIT](LICENSE)
