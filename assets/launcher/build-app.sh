#!/bin/bash
# ============================================================
#  打包脚本：把源码组装成 macOS 的「网课挂机助手.app」
#  双击本文件即可重新打包（改完扩展源码后跑一次）
# ============================================================
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP="$SRC/网课挂机助手.app"
BUNDLE="$APP/Contents"

echo "== 1. 清理旧包 =="
rm -rf "$APP"
mkdir -p "$BUNDLE/MacOS" "$BUNDLE/Resources"

echo "== 2. 拷贝扩展源码 =="
cp -R "$SRC/extension" "$BUNDLE/Resources/extension"
cp -R "$SRC/launcher" "$BUNDLE/Resources/launcher"
rm -f "$BUNDLE/Resources/launcher/make-icon.py" "$BUNDLE/Resources/launcher/build-app.sh"

echo "== 3. 生成图标 =="
PY=/usr/bin/python3
[ -x "$PY" ] || PY="$SRC/../.venv/bin/python3"
IST="$SRC/icon-build.iconset"
MASTER="$SRC/icon-master.png"
rm -rf "$IST"; mkdir -p "$IST"
if [ -x "$PY" ]; then
  "$PY" "$SRC/launcher/make-icon.py" "$MASTER" >/dev/null
  for s in 16 32 128 256 512; do
    d=$((s * 2))
    /usr/bin/sips -z "$s" "$s" "$MASTER" --out "$IST/icon_${s}x${s}.png" >/dev/null 2>&1
    /usr/bin/sips -z "$d" "$d" "$MASTER" --out "$IST/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  /usr/bin/iconutil -c icns "$IST" -o "$BUNDLE/Resources/app.icns" >/dev/null 2>&1 \
    && echo "   图标已生成" || echo "   （图标生成失败，用默认图标）"
  rm -rf "$IST" "$MASTER"
else
  echo "   （没有 python3，跳过图标）"
fi

echo "== 4. 写入 Info.plist =="
cat > "$BUNDLE/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>网课挂机助手</string>
    <key>CFBundleDisplayName</key><string>网课挂机助手</string>
    <key>CFBundleIdentifier</key><string>local.guaji.helper</string>
    <key>CFBundleExecutable</key><string>GuajiLauncher</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>2.0.0</string>
    <key>CFBundleVersion</key><string>200</string>
    <key>CFBundleIconFile</key><string>app</string>
    <key>LSMinimumSystemVersion</key><string>10.15</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

echo "== 5. 写入入口程序 =="
cat > "$BUNDLE/MacOS/GuajiLauncher" <<'ENTRY'
#!/bin/bash
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec /bin/bash "$HERE/launcher/launch.sh"
ENTRY
chmod +x "$BUNDLE/MacOS/GuajiLauncher"
chmod +x "$BUNDLE/Resources/launcher/launch.sh"

echo "== 6. 去掉隔离标记 =="
/usr/bin/xattr -cr "$APP" 2>/dev/null || true

echo
echo "✅ 打包完成: $APP"
echo "   体积: $(du -sh "$APP" | awk '{print $1}')"
