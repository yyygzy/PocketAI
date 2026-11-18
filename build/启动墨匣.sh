#!/usr/bin/env bash
# 墨匣一键启动器（Linux）
# 双击本文件即可：自动检测环境，选择最合适的客户端启动方式。
# 优先级：已安装版本（deb/rpm → /opt/Moxia）→ 同目录 AppImage。
# AppImage 缺 FUSE2 时自动切免挂载模式；沙箱不可用时自动加 --no-sandbox。
# 启动过程记录在同目录「启动日志.txt」，报问题时把这个文件发过来即可。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/启动日志.txt"
say() { echo "[$(date '+%H:%M:%S')] [墨匣启动器] $*" | tee -a "$LOG"; }
: > "$LOG"

# 1) 已通过 deb/rpm 安装：直接启动，沙箱由系统安装器配好
if [ -x /opt/Moxia/pocket-ai ]; then
  say "检测到已安装版本，直接启动 /opt/Moxia/pocket-ai"
  exec /opt/Moxia/pocket-ai "$@"
fi

# 2) 找同目录的 AppImage
APPIMAGE="$(ls "$DIR"/Moxia-*.AppImage 2>/dev/null | head -n1)"
if [ -z "$APPIMAGE" ]; then
  say "未找到已安装版本，也没在同目录找到 Moxia-*.AppImage，无法启动。"
  say "请确认「启动墨匣.sh」和「Moxia-x.y.z-Linux-x86_64.AppImage」在同一个文件夹。"
  command -v notify-send >/dev/null 2>&1 && notify-send "墨匣" "未找到 Moxia AppImage，详见启动日志.txt" || true
  exit 1
fi
chmod +x "$APPIMAGE" 2>/dev/null || true

FLAGS=()
ENVV=()

# 3) FUSE2 检测：有 libfuse2 且 /dev/fuse 存在才尝试挂载运行，否则免挂载解压运行
if ls /dev/fuse >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q "libfuse\.so\.2"; then
  say "FUSE2 可用：按常规方式挂载启动"
else
  say "缺少 FUSE2（Ubuntu 24.04+ 默认不带）：改用免挂载模式，首次启动会慢几秒"
  ENVV+=("APPIMAGE_EXTRACT_AND_RUN=1")
fi

# 4) 沙箱检测：Electron 沙箱依赖非特权用户命名空间，被禁用时降级 --no-sandbox
if unshare --user true 2>/dev/null; then
  say "沙箱可用：保持系统沙箱启动"
else
  say "系统禁用非特权用户命名空间（部分发行版默认策略）：本次以 --no-sandbox 启动"
  FLAGS+=(--no-sandbox)
fi

say "启动：$APPIMAGE ${FLAGS[*]:-}"
if [ ${#ENVV[@]} -gt 0 ]; then
  exec env "${ENVV[@]}" "$APPIMAGE" "${FLAGS[@]}" "$@"
else
  exec "$APPIMAGE" "${FLAGS[@]}" "$@"
fi
