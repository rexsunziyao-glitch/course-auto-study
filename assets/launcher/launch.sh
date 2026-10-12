#!/bin/bash
# ============================================================
#  网课挂机助手 · 启动器
#  ------------------------------------------------------------
#  做五件事：
#    1. 架构自愈（若被 Rosetta 翻译，立刻切回原生重跑）
#    2. 找到 Chrome，用「独立配置文件」启动它（跟日常浏览器互不干扰）
#    3. 等调试端口就绪（耐心等，不再误杀）
#    4. 通过调试协议把扩展装进去（Chrome 137+ 已删除 --load-extension）
#    5. 扩展就位后才打开课程网站
#
#  可双击 .app 运行，也可直接 bash 运行本脚本。
# ============================================================
set -u

RES="$(cd "$(dirname "$0")/.." && pwd)"      # Resources 根目录
EXT="$RES/extension"
LAUNCHER="$RES/launcher"

LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/网课挂机助手.log"
CLOG="$LOG_DIR/网课挂机助手-chrome.log"
CONF_DIR="$HOME/Library/Application Support/网课挂机助手"
CONF="$CONF_DIR/config"
mkdir -p "$LOG_DIR" "$CONF_DIR" 2>/dev/null

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }
notify() {
  log "通知: $1"
  /usr/bin/osascript -e "display notification \"$1\" with title \"网课挂机助手\"" >/dev/null 2>&1 || true
}

# ---------------- 架构自愈 ----------------
# 实测：本 .app 经 LaunchServices 启动后，进程链会被标成 x86_64，
# Chrome（universal 二进制）于是跟随父进程挑 x64 分支、跑进 Rosetta，
# 冷启动从 2 秒劣化到 10 秒以上。这里抢在一切之前切回原生。
if [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && [ -x /usr/bin/arch ]; then
  log "检测到 Rosetta 翻译环境 → 切换到原生架构重跑"
  exec /usr/bin/arch -arm64 /bin/bash "$0" "$@"
fi

# ---------------- 默认配置（可在 config 文件里覆盖） ----------------
PROFILE="$HOME/.workbuddy-guaji-chrome"
PORT=9222
START_URL="https://hzfspx.91cme.com/weixin/index"

if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

# ---------------- 首次运行：写一份可编辑的配置 ----------------
if [ ! -f "$CONF" ]; then
  cat >"$CONF" <<EOF
# 网课挂机助手 · 配置
# 改完保存即可，下次启动生效。

# 启动后自动打开的网址（换成你自己的课程平台即可）
START_URL="$START_URL"

# 独立浏览器配置目录（登录状态存在这里，换掉就要重新登录）
PROFILE="$HOME/.workbuddy-guaji-chrome"

# 调试端口（一般不用改）
PORT=$PORT
EOF
  log "已生成配置文件: $CONF"
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

log "=== 启动 ===  arch=$(uname -m)  端口=$PORT"
log "  扩展目录: $EXT"
log "  配置目录: $PROFILE"

if [ ! -x "$CHROME" ]; then
  log "找不到 Google Chrome"
  notify "没找到 Google Chrome，请先安装。"
  exit 1
fi

port_alive() {
  /usr/bin/curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

# 等端口就绪：最多 secs 秒，每 0.5 秒探一次
wait_port() {
  local secs="${1:-45}" i=0
  while [ "$i" -lt $((secs * 2)) ]; do
    port_alive && return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

launch_chrome() {
  # $1 = 额外参数（可能为空）
  # shellcheck disable=SC2086
  "$CHROME" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$PORT" \
    --enable-unsafe-extension-debugging \
    --no-first-run \
    --no-default-browser-check \
    --disable-crash-reporter \
    --disable-breakpad \
    $1 \
    about:blank >>"$CLOG" 2>&1 &
}

open_url_only() {
  # 已有实例在跑：再调一次 Chrome，它会通过进程单例把 URL 转交给已有窗口
  "$CHROME" --user-data-dir="$PROFILE" "$START_URL" >>"$CLOG" 2>&1 &
}

# ---------------- 1. 启动 Chrome ----------------
if port_alive; then
  log "检测到调试端口已就绪，复用现有窗口"
else
  log "启动 Chrome（常规参数）"
  launch_chrome ""
  if ! wait_port 45; then
    # 有些环境（沙箱 / 受限权限）里 Chrome 自带沙箱起不来，降级重试一次
    log "常规启动 45 秒内未就绪，改用兼容参数重试"
    /usr/bin/pkill -f "user-data-dir=$PROFILE" 2>/dev/null
    sleep 2
    launch_chrome "--no-sandbox --disable-gpu --disable-dev-shm-usage"
    if ! wait_port 45; then
      log "Chrome 调试端口始终没起来。Chrome 自身输出尾部："
      tail -n 25 "$CLOG" 2>/dev/null | while IFS= read -r l; do log "  | $l"; done
      notify "浏览器启动失败，详情见 ~/Library/Logs/网课挂机助手.log"
      exit 1
    fi
  fi
fi

log "调试端口就绪"

# ---------------- 2. 挑一个运行时 ----------------
NODE_BIN=""
PY_BIN=""
for c in $HOME/.workbuddy/binaries/node/versions/*/bin/node \
         /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && { NODE_BIN="$c"; break; }
done
if [ -z "$NODE_BIN" ]; then
  for c in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    [ -x "$c" ] && { PY_BIN="$c"; break; }
  done
fi

# ---------------- 3. 装扩展 ----------------
LOADED=""
if [ -n "$NODE_BIN" ]; then
  log "用 Node 装载扩展: $NODE_BIN"
  OUT="$("$NODE_BIN" "$LAUNCHER/cdp-load.mjs" "$EXT" "$PORT" 2>&1)"
  log "  → $OUT"
  case "$OUT" in OK*|ALREADY*) LOADED=1 ;; esac
fi

if [ -z "$LOADED" ] && [ -n "$PY_BIN" ]; then
  log "用 Python 装载扩展: $PY_BIN"
  OUT="$("$PY_BIN" "$LAUNCHER/cdp-load.py" "$EXT" "$PORT" 2>&1)"
  log "  → $OUT"
  case "$OUT" in OK*|ALREADY*) LOADED=1 ;; esac
fi

# ---------------- 4. 打开课程页 ----------------
if [ -n "$LOADED" ]; then
  log "扩展已就位，打开 $START_URL"
  open_url_only
  notify "已就绪：打开课程页面即自动挂机。"
else
  log "扩展装载失败 —— 转为手动补救"
  notify "扩展没装上，请查看日志。"
  /usr/bin/open "$EXT" >/dev/null 2>&1 || true
  /usr/bin/open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true
fi

log "=== 结束 ==="
exit 0
