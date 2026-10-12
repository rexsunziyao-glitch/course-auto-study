---
name: course-auto-study
description: 为「继续教育 / 网课学习平台」生成并安装一套本机挂机工具（Chrome 扩展 + macOS 双击即用的 App），自动续播、防暂停、防切页计时、自动处理挂机确认弹窗。当用户提到挂机刷课、自动播课、继续教育学时、网课计时、必须盯着页面、切走就停、自动续播、自动下一节等场景时使用。也用于把整套工具一键装到本机，或打包成压缩包分享给别人。
---

# 网课挂机助手 · 生成器

把"必须守在这个页面才计时"的网课，变成可以后台自动播完的课。

## 产出什么

一个能双击运行、和日常浏览器完全隔离的 macOS App，加上一个 Chrome 扩展：

```
网课挂机助手.app          ← 双击启动（独立 Chrome + 预装扩展 + 自动打开课程页）
├ extension/              ← Chrome 扩展（Manifest V3，world=MAIN）
│  ├ manifest.json
│  ├ content.js           ← 挂机主体（可见性伪装 / 续播 / 弹窗 / 网络探针）
│  ├ gate.js              ← 激活门控（关键安全设计，见下）
│  ├ popup.html / popup.js
│  └ icon*.png
└ launcher/
   ├ launch.sh            ← 启动逻辑（含架构自愈）
   ├ cdp-load.mjs/.py     ← 通过调试协议装载扩展的装载器（Node/Python 双实现）
   ├ build-app.sh         ← 重新打包
   └ make-icon.py
```

## 系统兼容性（务必先跟用户讲清）

**成品 App 只支持 macOS + Google Chrome。** 这是硬约束，不是"体验差异"：

| 环境 | 能否直接用 |
|---|---|
| macOS（Intel / Apple Silicon）+ Chrome | ✅ 双击即用 |
| macOS + Edge/Brave（Chromium） | ⚠️ 扩展兼容，但启动器写死 Chrome 路径，需改 |
| Windows / Linux | ❌ 无对应产物 |
| Safari / Firefox | ❌ 不支持 |

底层原因：启动器调用了 macOS 专属命令（`arch`/`sysctl`/`iconutil`），
通过 Chrome 的调试协议（CDP）装载扩展，产物是 `.app`。

**所以**：用户要"分享给别人"时，正确动作是**给这个 Skill，而不是给 .app**——
让对方丢给 WorkBuddy / 豆包，AI 在他自己的机器上重新生成（适配他的平台域名、
芯片架构、登录态）。但要诚实说明：**Skill 生成的仍是 macOS + Chrome 方案**，
覆盖 Windows/其他浏览器需要另做跨平台重写，本 Skill 目前不含。

## 一键安装

```bash
bash scripts/install.sh "https://你的课程平台首页"
```

会装到 `~/Applications/网课挂机助手/`，并把 App 复制到桌面、写好
`~/Library/Application Support/网课挂机助手/config`。
（`install.sh` 内置 macOS 检查，非 macOS 会明确报错退出。）

## 扩展能做什么

| 平台的检查手段 | 扩展的应对 |
|---|---|
| 切标签页 → `document.hidden = true` | 主世界重写，恒定返回 `false` |
| 切窗口 → `blur` / `visibilitychange` | `document-start` 拦掉监听注册 |
| 查 `document.hasFocus()` | 恒定返回 `true` |
| 鼠标不动就暂停 | 定时在播放器上合成 `mousemove`（随机坐标） |
| "您还在学习吗"弹窗 | 匹配正面文案并自动点击 |
| 系统休眠 | Wake Lock 保持屏幕常亮 |
| 被暂停 / 播放报错 | 自动续播、自动重试；卡死超时自动重载 |
| 一节播完 | 自动点「下一节」 |

进度上报次数会实时显示在面板上，方便判断平台是"心跳累加"还是"整段计时"。

## 安全设计（不要删掉 gate.js）

`gate.js` 是一道**激活门控**。扩展虽然注册在宽泛的站点匹配上，但**只有同时满足
「这是一张有真实视频的页面」等学习语境条件时才会真正干活**，否则一声不吭。

原因：`content.js` 里「自动点弹窗」的逻辑是"看到 dialog/modal 就找确认按钮点下去"。
如果再装到通用网页上，它可能替你点掉**「确认提交」「删除」「确认转账」**。
所以：

- **默认绝不开全局匹配**，按平台域名逐个加白名单
- 学习语境判据：页面存在指向视频资源的 `<video>`（`.mp4/.m3u8/blob:`）或明显的
  播放器容器 + 时长 > 60 秒
- 每接入一个新平台，都要在那站上先跑一次、检查面板日志里点过什么

## 执行流程

1. **问清平台网址**。用户给课程页 URL 或截图即可。若只是示例页 URL 且无有效登录态，
   记下域名用于白名单。
2. **确认平台类型**。特别注意：
   - 播放器是否挂在**第三方 CDN 域名**（如 `*.100anquan.com`）→ 该域名也要进 matches
   - 是否有**人脸识别 / 定时拍照**（代码里常有 `face()`、`isFace`、`getUserMedia`）
     → 有的话必须警告用户：**脚本拦不住摄像头，成绩可能作废**
   - 是否有**防快进检测**（`detectFastForward`、位置跳变告警）→ 必须锁死 1x 倍速
3. **跑安装脚本**，把用户的平台网址填进去。
4. **让用户自己登录**。第一次启动会开一个干净 Chrome，登录状态存在独立 profile 里，
   这个环节不要代劳、不要索取账号密码。
5. **验证**：
   ```bash
   # 面板是否注入
   CDP_PORT=9222 node <driver> eval "!!document.getElementById('guaji-assistant-host')"
   ```
   面板出现、状态显示"播放中"、进度在走，即成功。
6. **拉诊断报告**校准选择器。面板「诊断」→「复制报告」，重点看：
   - `iframes`：嵌套层级和域名 → 决定 matches 要不要补
   - `network_calls_hinted`：判断计时机制
   - 真实按钮文案 → 修正「下一节」和弹窗按钮的匹配词

## 已知的坑（都踩过了）

### Chrome 137+ 已删除 `--load-extension`
官方移除了这个参数。**唯一可行路径是调试协议** `Extensions.loadUnpacked`，
且需要浏览器以 `--enable-unsafe-extension-debugging` 启动。装载器已实现。

### 调试协议装的扩展不会自动持久化
重启浏览器后需要重新装载 —— 所以 `launch.sh` **每次启动都装一遍**。这是正常的，
不要试图"修"它。

### App 经 LaunchServices 启动后 Chrome 会掉进 Rosetta
症状：`The use of Rosetta to run the x64 version of Chromium on Arm...`，
冷启动从 2 秒劣化到 10 秒以上，如果启动脚本等待时间不够就会**误判失败并自杀**
（`SIGTERM shutdown watchdog expired`）。

`launch.sh` 里已有两道防线：

```bash
# 防线一：架构自愈，抢在一切之前切回原生
if [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  exec /usr/bin/arch -arm64 /bin/bash "$0" "$@"
fi
# 防线二：耐心等 45 秒，不要过早 pkill
```

### `iconutil` 要求目录名以 `.iconset` 结尾
用 `.iconset`（点开头）会被当成"无扩展名的隐藏文件"而失败。用 `icon-build.iconset`。

### 不要同时开两套
如果用户既装了篡改猴脚本又装了扩展，**必须二选一**。双实例会争抢 `video.play()`
并重复点击弹窗，第二次点击会落到弹窗背后的按钮上。

## 必须对用户讲明的风险

这类绕过检测的做法处在平台规则的灰区。必须明确告知：

1. **人脸抽查拦不住**。脚本能骗过 DOM，骗不过摄像头。平台若启用，成绩可能作废。
2. **防快进会留违规记录**。多数平台有 `detectFastForward`，跳变会触发回退 + 告警。
   所以倍速必须锁 1x。
3. **合盖会断网**。扩展能防屏幕休眠，防不住整机睡眠。
4. 提供保守开关 `notifyInsteadOfDismiss`：打开后弹窗只发桌面通知、不替你点，
   由本人过去点一下，稳得多。

## 适配新平台

1. 在 `extension/manifest.json` 的 `content_scripts[].matches` 里加域名
2. 若播放器在第三方域名，也要加进去
3. 重新打包：`bash launcher/build-app.sh`
4. 在那站上跑一次，看面板日志确认没有误点

参考：`hzfspx.91cme.com`（浙江省继续医学教育）、`*.100anquan.com`（视频 CDN）。
