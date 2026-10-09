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

  echo "==> 安装 systemd unit"
  ssh "$HOST" "sudo cp $REMOTE_ROOT/deploy/wedding-bot.service /etc/systemd/system/wedding-bot.service"
  ssh "$HOST" "sudo systemctl daemon-reload && sudo systemctl enable wedding-bot"

  echo "==> 安装 nginx 配置"
  # 两套布局必须分开处理。Ubuntu/Debian 的主配置只 include sites-enabled/，
  # **不 include conf.d/** —— 往 conf.d 里拷文件会成功、nginx -t 也过，
  # 但那个 server 块根本没被加载，表现是「配置明明装好了、端口却 404」。
  #
  # ⚠️ 这段刻意**不删除** /etc/nginx/sites-enabled/default，也不碰任何
  #    已有配置。这台机器上跑着别的站点，删 default 等于把人家摘下线。
  #    我们只新增一个文件，监听 8080，与 80 上的现有服务互不干扰。
  ssh "$HOST" bash -s <<'REMOTE'
set -e
[ -f /etc/nginx/nginx.conf ] || { echo "!! 这台机器上没有 nginx，先装：apt install nginx 或 dnf install nginx"; exit 1; }

echo "-- 现有 nginx 站点（确认我们不覆盖它们）--"
grep -rhE '^\s*(listen|server_name)' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sort -u || true

if [ -d /etc/nginx/sites-available ]; then
  sudo cp /srv/wedding/deploy/nginx.conf /etc/nginx/sites-available/wedding
  sudo ln -sf /etc/nginx/sites-available/wedding /etc/nginx/sites-enabled/wedding
else
  sudo cp /srv/wedding/deploy/nginx.conf /etc/nginx/conf.d/wedding-web.conf
fi

# 必须是这条：我们只在 8080 上新增，80 上一个字都不改
sudo nginx -t
sudo systemctl reload nginx 2>/dev/null || sudo systemctl restart nginx
echo "-- 8080 自测 --"
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 5 http://127.0.0.1:8080/ || echo "(还没生成过对比页，404 是正常的)"
REMOTE

  # nginx 以 www-data / nginx 身份跑，要能穿过 /srv/wedding 进到 web/。
  # 目录若是 700，症状是 404/403 但文件明明在那儿。
  ssh "$HOST" "sudo chmod 755 /srv/wedding && sudo chmod -R a+rX /srv/wedding/web 2>/dev/null || true"
fi

echo "==> 重启服务"
ssh "$HOST" "sudo systemctl restart wedding-bot"

sleep 3
echo "==> 对端状态"
ssh "$HOST" "systemctl is-active wedding-bot && sudo journalctl -u wedding-bot -n 15 --no-pager"

cat <<'EOF'

────────────────────────────────────────────────────────────────
别忘了这几件脚本管不了的事：

1. 阿里云控制台 → 安全组 → 放行 **8080** 端口（入方向）。
   不要动 80 —— 那上面有别的站点。SSH 的 22 已经开着（否则上面这些
   命令根本连不上）。

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
