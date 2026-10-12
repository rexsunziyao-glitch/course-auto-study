#!/bin/bash
# ============================================================
#  网课挂机助手 · 一键安装
#  ------------------------------------------------------------
#  用法：
#    bash install.sh "https://你的课程平台首页"      # 装到默认位置
#    bash install.sh "https://..." ~/Desktop/xxx    # 指定安装目录
#    bash install.sh --no-app                       # 只装扩展，不打包 App
#
#  做的事：
#    1. 把扩展 + 启动器铺到一个固定目录
#    2. 打包出 macOS 的 .app（双击即用）
#    3. 写好配置（课程网址、独立浏览器配置目录、调试端口）
#    4. 把 .app 复制到桌面
# ============================================================
set -eu

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_EXT="$SKILL_DIR/assets/extension"
SRC_LAUNCH="$SKILL_DIR/assets/launcher"

START_URL=""
INSTALL_DIR="$HOME/Applications/网课挂机助手"
NO_APP=0

# ---- 解析参数 ----
for a in "$@"; do
  case "$a" in
    --no-app) NO_APP=1 ;;
    -*)       echo "未知参数: $a" >&2; exit 2 ;;
    *)
      if [ -z "$START_URL" ]; then START_URL="$a"
      else INSTALL_DIR="$a"; fi
      ;;
  esac
done

if [ -z "$START_URL" ]; then
  START_URL="https://hzfspx.91cme.com/weixin/index"
  echo "（未指定课程网址，使用示例值：$START_URL）"
fi

echo "════════════════════════════════════════"
echo "  网课挂机助手 · 安装"
echo "════════════════════════════════════════"
echo "  课程网址 : $START_URL"
echo "  安装目录 : $INSTALL_DIR"
echo

# ---- 环境检查 ----
if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 本安装脚本目前只支持 macOS。" >&2
  echo "   扩展本体（assets/extension）是跨平台的，可手动在 Chrome 里加载。" >&2
  exit 1
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "❌ 没找到 Google Chrome，请先安装：https://www.google.com/chrome/" >&2
  exit 1
fi
echo "✅ 环境检查通过（macOS + Chrome）"
echo

# ---- 1. 铺文件 ----
echo "== 1/4 铺设扩展与启动器 =="
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$SRC_EXT"    "$INSTALL_DIR/extension"
cp -R "$SRC_LAUNCH" "$INSTALL_DIR/launcher"
chmod +x "$INSTALL_DIR/launcher/launch.sh" "$INSTALL_DIR/launcher/build-app.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/launcher/cdp-load.py" 2>/dev/null || true
echo "   → $INSTALL_DIR"

# ---- 2. 打包 App ----
APP_SRC="$INSTALL_DIR/网课挂机助手.app"
if [ "$NO_APP" = "0" ]; then
  echo "== 2/4 打包 .app =="
  /bin/bash "$INSTALL_DIR/launcher/build-app.sh" | sed 's/^/   /'
else
  echo "== 2/4 跳过打包（--no-app）=="
fi

# ---- 3. 写配置 ----
echo "== 3/4 写入配置 =="
CONF_DIR="$HOME/Library/Application Support/网课挂机助手"
mkdir -p "$CONF_DIR"
cat > "$CONF_DIR/config" <<EOF
# 网课挂机助手 · 配置
# 改完保存即可，下次启动生效。

# 启动后自动打开的网址（换成你自己的课程平台即可）
START_URL="$START_URL"

# 独立浏览器配置目录（登录状态存在这里，换掉就要重新登录）
PROFILE="$HOME/.guaji-chrome-profile"

# 调试端口（一般不用改）
PORT=9222
EOF
echo "   → $CONF_DIR/config"

# ---- 4. 放到桌面 ----
echo "== 4/4 复制快捷方式到桌面 =="
DESK="$HOME/Desktop"
if [ "$NO_APP" = "0" ] && [ -d "$DESK" ]; then
  rm -rf "$DESK/网课挂机助手.app"
  cp -R "$APP_SRC" "$DESK/网课挂机助手.app"
  /usr/bin/xattr -cr "$DESK/网课挂机助手.app" 2>/dev/null || true
  echo "   → $DESK/网课挂机助手.app"
else
  echo "   （跳过）"
fi

echo
echo "════════════════════════════════════════"
echo "  ✅ 安装完成"
echo "════════════════════════════════════════"
echo
echo "接下来："
echo "  1. 双击桌面上的「网课挂机助手」"
echo "  2. 第一次会打开一个干净的 Chrome，请在里面登录你的课程平台"
echo "  3. 登录状态会被记住，以后双击直接就进"
echo
echo "它跟你的日常浏览器完全隔离，互不影响。"
echo "日志在 ~/Library/Logs/网课挂机助手.log"
echo
