#!/usr/bin/env bash
# 把本机的 watcher 装成开机自启（macOS LaunchAgent）。
#
#   deploy/install-watch-agent.sh             安装并立刻启动
#   deploy/install-watch-agent.sh --status    看状态
#   deploy/install-watch-agent.sh --uninstall 卸载
#
# 装完之后，卡片上的「同步到 Mac」按钮会一直可用，不用每次手动开终端跑
# npm run watch。重启、注销再登录都会自己起来；进程意外挂掉也会自动重拉。
#
# ── 为什么是 LaunchAgent，不是 LaunchDaemon ─────────────────────────
# LaunchDaemon 在**登录前**就以 root 跑，听着更像「开机自启」，但那样：
#   · 拿不到你的 ~/.ssh，ssh 到服务器直接失败
#   · osascript 通知弹不进你的桌面会话
#   · 拉下来的文件属主是 root，之后你自己改不动
# LaunchAgent 以**你本人**的身份在你登录后启动，上面三样都正常。
# 所以 Mac 上「开机自启」的实际含义是「登录后自启」——对你这个场景等价，
# 因为要同步也得是你人在用这台机器的时候。
#
# ── 两个已经踩过的坑（都在这台机器上实测过）────────────────────────
# 1. launchd 的 PATH 极简（只有 /usr/bin:/bin:/usr/sbin:/sbin），
#    Homebrew 装的 node 不在里面。所以 ProgramArguments 里必须写 node 的
#    **绝对路径**，不能只写 "node"。脚本会自动探测。
# 2. launchd 启动的进程没有 SSH_AUTH_SOCK。如果 ssh 密钥带口令、靠
#    ssh-agent 解锁，这里会连不上服务器。本机的 id_ed25519 没口令，
#    用 `env -i` 模拟干净环境实测过能通。换机器的话要重新验这一条。

set -euo pipefail

LABEL=com.wedding.watch
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

# ── 状态 ────────────────────────────────────────────────────────────
show_status() {
  echo "==> $LABEL"
  if [[ ! -f "$PLIST" ]]; then
    echo "    没装（$PLIST 不存在）"
    return 1
  fi
  echo "    plist: $PLIST"

  # launchctl print 的输出很长，只挑关心的几行
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    local pid state
    pid="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')"
    state="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tstate = /{print $3}')"
    echo "    已加载，state=$state pid=${pid:-（当前没在跑）}"
    if [[ -n "${pid:-}" ]]; then
      ps -o pid=,etime=,command= -p "$pid" | sed 's/^/      /'
    fi
  else
    echo "    未加载（plist 在，但没 bootstrap）"
  fi

  # 只看这个 label 自己的日志，不用 grep 整个 system.log
  local out="$LOG_DIR/wedding-watch.log"
  [[ -f "$out" ]] && { echo "    --- 最近日志 ---"; tail -5 "$out" | sed 's/^/    /'; }
  local err="$LOG_DIR/wedding-watch.err.log"
  [[ -s "$err" ]] && { echo "    --- 最近错误 ---"; tail -5 "$err" | sed 's/^/    /'; }
  return 0
}

# ── 卸载 ────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  echo "==> 卸载 $LABEL"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "    已停止" || echo "    （本来就没在跑）"
  [[ -f "$PLIST" ]] && rm -f "$PLIST" && echo "    已删除 $PLIST"
  echo
  echo "    日志留在 $LOG_DIR/wedding-watch*.log，要清自己删。"
  exit 0
fi

if [[ "${1:-}" == "--status" || "${1:-}" == "-s" ]]; then
  show_status
  exit $?
fi

# ── 安装 ────────────────────────────────────────────────────────────

# node 必须解析成绝对路径。优先用当前 shell 里的 node（就是你现在跑得通的那个），
# 退回 Homebrew 的固定位置。
NODE="$(command -v node || true)"
if [[ -z "$NODE" && -x /opt/homebrew/opt/node@20/bin/node ]]; then
  NODE=/opt/homebrew/opt/node@20/bin/node
fi
if [[ -z "$NODE" ]]; then
  echo "!! 找不到 node。先确认 node 在 PATH 里，再跑这个脚本。" >&2
  exit 1
fi

# 已经有一个手动跑的 watcher 的话，装上去会打架：launchd 起的那个发现锁被占，
# 会以退出码 1 退出，然后 launchd 每 30 秒重拉一次，日志里刷一片。
if pgrep -f "scripts/watch\.mjs" >/dev/null 2>&1; then
  echo "!! 已经有一个 watcher 在跑（可能就是你在终端里 npm run watch 的那个）。" >&2
  echo "   先把它停掉（终端里 Ctrl-C），再跑这个脚本。否则两个会抢锁。" >&2
  echo >&2
  pgrep -fl "scripts/watch\.mjs" >&2
  exit 1
fi

echo "==> 安装 $LABEL"
echo "    项目根目录 : $ROOT"
echo "    node       : $NODE"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# 写 plist。这里用展开的 heredoc —— $ROOT / $NODE / $HOME 要写死成绝对路径，
# launchd 不会帮你做任何变量替换。
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/scripts/watch.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <!-- 登录即启动 -->
  <key>RunAtLoad</key>
  <true/>

  <!-- 挂了就重拉。配合 ThrottleInterval，真出问题时不会疯狂重启 -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <!-- launchd 默认 PATH 里没有 Homebrew。watcher 要调 ssh / osascript / tar，
       这几个都在 /usr/bin，但把 Homebrew 一起带上省得以后再踩。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/wedding-watch.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/wedding-watch.err.log</string>
</dict>
</plist>
PLIST_EOF

# 先卸掉旧的（重复 bootstrap 同名 label 会报错）
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

echo "    已加载"
echo
show_status || true
cat <<EOF

────────────────────────────────────────────────────────────────
装好了。它会跟着你登录自动启动，进程挂掉也会自己重拉。

  deploy/install-watch-agent.sh --status     看状态和日志
  deploy/install-watch-agent.sh --uninstall  卸载

几点说明：

· 日志在 $LOG_DIR/wedding-watch.log。
  不在终端里了，出问题先看这个文件。

· 想临时停一会儿（比如调试）：
    launchctl bootout gui/$UID_NUM/$LABEL
  再开：
    launchctl bootstrap gui/$UID_NUM "$PLIST"

· 装了之后**不要再手动跑 npm run watch** —— 两个会抢锁，
  后起的那个会直接退出。要手动跑就先 bootout。

· 改了 scripts/watch.mjs 或 bot/ 下的代码，要重启才生效：
    launchctl kickstart -k gui/$UID_NUM/$LABEL
────────────────────────────────────────────────────────────────
EOF
