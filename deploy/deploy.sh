#!/usr/bin/env bash
# 把本地的备婚助手同步到 ECS 并（重）启动服务。
#
#   用法：  deploy/deploy.sh <user@host> [--first-time]
#
#   第一次部署必须带 --first-time（会建目录、装依赖、装 systemd/nginx）。
#   以后改完代码重跑一次即可，不带参数就是「同步 + 重启」。
#
#   前提：本机能免密 ssh 到目标机器，且目标机器上已有 Node 20+。
#   目标机器上需要 sudo 权限（装 systemd unit、nginx 配置、开目录）。

set -euo pipefail

HOST="${1:-}"
FIRST_TIME="${2:-}"

if [[ -z "$HOST" ]]; then
  echo "用法：deploy/deploy.sh <user@host> [--first-time]" >&2
  exit 1
fi

LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_ROOT=/srv/wedding

# ── 同步什么、不同步什么 ────────────────────────────────────────────
# 排除项和 .gitignore 保持一致，外加两条本地特有的：
#   node_modules —— 平台不同（darwin-arm64 vs linux-x64），必须在对端重装
#   .env         —— 里面有飞书密钥，单独 scp，不走 rsync 的批量通道
EXCLUDES=(
  --exclude 'node_modules/'
  --exclude '.git/'
  --exclude '.env'
  --exclude 'state/'
  --exclude 'workspace/raw/'
  --exclude 'workspace/output/'
  --exclude 'web/'
  --exclude '.DS_Store'
  --exclude '*.log'
)

echo "==> 同步代码到 $HOST:$REMOTE_ROOT"
if [[ "$FIRST_TIME" == "--first-time" ]]; then
  ssh "$HOST" "sudo mkdir -p $REMOTE_ROOT && sudo chown \$(id -u):\$(id -g) $REMOTE_ROOT"
fi
rsync -az --delete "${EXCLUDES[@]}" "$LOCAL_ROOT/" "$HOST:$REMOTE_ROOT/"

# ── 状态与数据 ──────────────────────────────────────────────────────
# 单独同步，且刻意不 --delete：对端可能已经有更新的数据。
#
# state/jobs.json 一定要带过去。它同时是「任务日志」和「飞书事件去重表」，
# 本地已经有 20 条记录。如果对端从空的开始，而飞书又把 7 小时窗口内的
# 老消息重推到新进程上，那些消息会被当成新消息重跑一遍 —— 重复花钱。
rsync -az "$LOCAL_ROOT/state/jobs.json"        "$HOST:$REMOTE_ROOT/state/" 2>/dev/null || true
rsync -az "$LOCAL_ROOT/state/media-index.json" "$HOST:$REMOTE_ROOT/state/" 2>/dev/null || true

echo "==> 同步 workspace 数据（Markdown 才是真相来源）"
ssh "$HOST" "mkdir -p $REMOTE_ROOT/workspace"
rsync -az "$LOCAL_ROOT/workspace/data/"   "$HOST:$REMOTE_ROOT/workspace/data/"
rsync -az "$LOCAL_ROOT/workspace/inbox/"  "$HOST:$REMOTE_ROOT/workspace/inbox/"

if [[ "$FIRST_TIME" == "--first-time" ]]; then
  echo "==> 上传 .env（含密钥，单独走，不进 rsync 的批量通道）"
  scp -q "$LOCAL_ROOT/.env" "$HOST:$REMOTE_ROOT/.env"
  ssh "$HOST" "chmod 600 $REMOTE_ROOT/.env"

  echo "==> 安装 Node 依赖"
  # ⚠️ 绝不能加 --omit=optional。SDK 的 Claude Code 原生二进制是
  #    optional dependency，跳过它会报 "Native CLI binary not found"，
  #    而且这个报错发生在第一次处理消息时，不在启动时，很容易漏。
  ssh "$HOST" "cd $REMOTE_ROOT && npm install --no-audit --no-fund"

  echo "==> 安装 systemd unit 与 nginx 配置"
  ssh "$HOST" "sudo cp $REMOTE_ROOT/deploy/wedding-bot.service /etc/systemd/system/wedding-bot.service"
  ssh "$HOST" "sudo cp $REMOTE_ROOT/deploy/nginx.conf /etc/nginx/conf.d/wedding-web.conf 2>/dev/null || sudo cp $REMOTE_ROOT/deploy/nginx.conf /etc/nginx/sites-available/wedding-web"
  ssh "$HOST" "sudo systemctl daemon-reload && sudo systemctl enable wedding-bot"
  ssh "$HOST" "sudo nginx -t && sudo systemctl reload nginx || sudo systemctl restart nginx"
fi

echo "==> 重启服务"
ssh "$HOST" "sudo systemctl restart wedding-bot"

sleep 3
echo "==> 对端状态"
ssh "$HOST" "systemctl is-active wedding-bot && sudo journalctl -u wedding-bot -n 15 --no-pager"

cat <<'EOF'

────────────────────────────────────────────────────────────────
别忘了这几件脚本管不了的事：

1. 阿里云控制台 → 安全组 → 放行 80 端口（入方向）。
   另外 SSH 的 22 也要放行，否则上面这些命令根本连不上。

2. 本机把机器人停掉！两处原因叠加会出问题：
   · 飞书集群投递**不广播**，同一条消息只会发给**其中一个**长连接。
     两个进程同时在线 = 消息被随机劈成两半，你完全看不出规律。
   · 两个进程各写各的 workspace，同一个 Markdown 会被交叉覆盖。
   → 本地 Ctrl-C 掉 npm start，并确认那个 python http.server 也停了。

3. 对端 .env 里的 PUBLIC_BASE_URL 要改成公网地址（脚本从本地带过去的
   还是局域网的那个 10.x，必须手改后 restart）。

4. 公网上线前先把飞书应用的「机器人可用范围」确认一遍，
   别把自己挡在外面。
────────────────────────────────────────────────────────────────
EOF
