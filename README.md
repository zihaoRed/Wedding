# 备婚 Agent 助手

在飞书里把商家发来的消息和报价截图直接转发给机器人，它自动提取成结构化数据；
一句话让它输出某个品类的对比，或全局预算总表。

```
 手机飞书  ◄──长连接(WebSocket)──►  VPS 上的 Node 服务
                                        │
                                        │ Claude Agent SDK
                                        ▼
                                   workspace/
                                     data/    ← 唯一的真相来源
                                     raw/     ← 原始转发归档
```

## 三个关键设计（决定了代码长什么样）

**1. 状态存在文件里，不存在对话里。**
每个商家的信息落成 `workspace/data/<品类>/<商家>.md`。Agent 每条消息都是**全新的
查询**（不用 `resume`）。原因：`resume` 会把整个历史 transcript 重新作为输入发一遍，
而单次预算上限并不覆盖这部分——用到第三个月，一句「把那家删掉」就可能超预算。

**2. 飞书要求 3 秒内处理完，而分析要几十秒。**
所以事件回调只做「去重 + 入队 + 立刻返回」，连回执卡片都交给队列 worker 发。
飞书会重推（15秒/5分/1小时/6小时，最长约 7 小时窗口），去重按 `event_id` **落盘**保存 48 小时。

**3. 飞书卡片渲染不了表格。**
`lark_md` 是 text 元素的白名单标签，不含表格、标题、列表、代码块。表格只在
**JSON 2.0 卡片**的 `markdown` 组件里支持，且每页只显示 5 行。所以对比结果走
**静态托管的响应式网页**（卡片里放跳转按钮）+ **xlsx 附件**，不用卡片正文装表格。

## 快速开始

### 1. 飞书后台配置（约 10 分钟）

⚠️ **顺序很重要。** 后台要求「保存长连接订阅方式时必须有客户端在线」，但又要求
「应用已发布」长连接才建得起来——所以不能把后台一次配完，必须分两段。

**第一段：配置并发布**（这期间不需要跑代码）

1. 打开 [open.feishu.cn/app](https://open.feishu.cn/app)，创建**企业自建应用**
   - 建议先创建「测试企业」并关联应用，权限变更即时生效、无需管理员审核
2. **应用能力** → 添加**机器人**
3. **权限管理** → 开通这四个：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - ⚠️ **后两个不能省。** 实测：只有 `im:message`（更宽泛的那个）时，
     长连接能建、后台显示一切正常、API 查 scopes 也「看起来够了」，
     但 `im.message.receive_v1` **一条都不会投递**。这两个 `readonly`
     才是该事件真正的投递门槛——没有它们，症状和「订阅方式没配」一模一样。
4. **事件与回调** → 添加事件 **`im.message.receive_v1`**
   - 订阅方式**先保持默认**，别急着改成「长连接」——没发布前保存会失败
5. **版本管理与发布** → 创建版本并发布
   - ⚠️ **这步不能省**。权限和事件的改动都要发布后生效；没发布的话长连接
     永远建不起来，报错是「应用未建立长连接」
6. 把 App ID / App Secret 填进 `.env`

**第二段：建立长连接后切订阅方式**

7. 跑 `npm run probe`（或 `npm start`）建立长连接
8. 回后台 **事件与回调 → 订阅方式** 改成 **「使用长连接接收事件」** 并保存
   - 后台要先探测到有客户端连上来才让保存，所以只能在此时做
9. ⚠️ **再发布一次版本**（「版本管理与发布」→ 创建版本 → 发布）
   - **这步最容易漏**：订阅方式和事件、权限一样，发布后才生效。
     只保存不发布的话，后台显示已是长连接、API 查 `callback_info` 也是
     `websocket`，但服务器不会往这条连接推任何事件——症状是「连接正常、
     手机发消息毫无反应，本地日志干净得可疑」。发布时保持第 7 步的进程在跑。

### 2. 配置并跑起来

```bash
cp .env.example .env
# 编辑 .env：FEISHU_APP_ID / FEISHU_APP_SECRET，
# 以及模型凭据——官方 Anthropic 填 ANTHROPIC_API_KEY；
# 用中转（如 DeepSeek）填 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL，并把 MODEL 改成中转的型号名。

npm install          # ⚠️ 不要加 --omit=optional，SDK 的原生二进制是 optional dependency
npm test             # 49 项自检，不需要任何凭据
```

**先体检，再连飞书**（这一步能在碰飞书之前就把模型侧的问题挡掉）：

```bash
npm run check          # 配置 + 飞书凭据 + 模型接口连通性，不花钱
npm run check:agent    # 再跑一次真实的 Agent 回合（消耗少量 token）
```

`check:agent` 是唯一真正的门禁——它用 bot 实际使用的环境和参数跑一个回合，验证
「凭据 → 模型名 → 工具调用 → 写文件」四件事全通。**走中转时尤其必要**：中转对
Messages API 兼容，不代表对 Agent SDK 的工具循环也兼容。

然后在本地跑 Phase 0 探针，同时建立长连接（飞书后台的「长连接」订阅方式要等它跑起来才保存得上）：

```bash
npm run probe
```

它会实测：**飞书会不会真的重推**、**`patch` 是替换还是合并**、**手机图片以什么格式到达**。
这三个答案会影响实现细节，值得先花这十几分钟。把结论告诉 Claude 即可。

确认无误后启动：

```bash
npm start            # 日志出现 "ws client ready" 就成了
```

### 3. 部署到 VPS

```bash
# VPS 上（Node 20+）
sudo mkdir -p /srv/wedding && sudo chown $USER /srv/wedding
# 把项目同步过去（rsync / git 都行），然后：
cd /srv/wedding && npm install

sudo cp deploy/wedding-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wedding-bot
journalctl -u wedding-bot -f
```

静态托管对比页（卡片上的「打开对比页」按钮要用）：

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wedding
sudo ln -s /etc/nginx/sites-available/wedding /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 然后在 .env 里设 PUBLIC_BASE_URL=http://你的域名或IP
```

## 日常怎么用

直接在飞书里私聊机器人：

| 你发什么 | 它做什么 |
|---|---|
| 商家报价的文字或截图 + 「这是 XX 家」 | 提取字段，写入 `data/`，回执里列出缺什么 |
| 只发一张图，不说是谁 | **不猜**，先反问是哪家的 |
| 「XX 家的餐标改成 3888」 | 改字段、版本 +1，旧值进版本历史 |
| 「汇总婚纱照」 | 生成对比页（卡片按钮）+ xlsx |
| 「总共要花多少」 | 生成总预算表 |
| 「这是A家的报价」+ 上一张图 | 归属到 A 家 |
| 一次转发多张图 | 并成**一个任务、一次分析**；会先等 `COALESCE_MS`（默认 8 秒）把这一批收齐再动手，所以单发一张图也会晚这么多才回 |

命令：

| 命令 | 作用 |
|---|---|
| `/stop` | 中断当前任务 |
| `/status` | 看队列深度、最近任务、用量上限 |
| `/重置` | 清空短期对话记忆（`data/` 数据不受影响） |

## 数据与备份

```
workspace/
  data/<品类>/<商家>.md    ← 结构化数据，Agent 写，你也可以直接改
  raw/<日期>/              ← 原始转发归档（截图 + 文字）
  output/                  ← 生成的 xlsx
web/                       ← 生成的对比页（nginx 托管）
state/                     ← 去重表、任务日志、心跳、最近对话
spec/AGENT_SPEC.md         ← Agent 行为规范，改它就能调教 Agent
```

需要备份的只有三样：`workspace/data/`、`spec/`、`.env`。
（`raw/` 体积大且可重来，`web/` `output/` 可重新生成。）

改字段定义、加品类、调回复风格——改 `spec/AGENT_SPEC.md` 就够了，不用动代码。

### 建议加的监控

```bash
# 心跳失联告警（长连接可能静默断开而 readyState 仍是 OPEN）
*/10 * * * * find /srv/wedding/state/heartbeat -mmin +10 | grep -q . && echo "备婚助手中断" | mail -s alert you@example.com
# 磁盘（写满会让 Agent 静默失败）
*/30 * * * * df --output=pcent /srv | tail -1 | tr -dc '0-9' | awk '$1>85' | grep -q . && echo "磁盘告警" | mail -s alert you@example.com
```

## 故障排查

| 现象 | 原因 |
|---|---|
| 保存订阅方式时报「应用未建立长连接」 | 应用还没「创建版本并发布」，或本地长连接没跑起来 |
| 长连接连着，手机发消息却毫无反应 | **①缺 `im:message.p2p_msg:readonly` / `im:message.group_at_msg:readonly`（实测最常见，只有 `im:message` 不够）**；②订阅方式改成「长连接」后没有再发布一次版本；③没加 `im.message.receive_v1`。排查时先看权限，再看发布。API 查 `callback_info.callback_type` 显示 `websocket` 不能排除②——它读的是当前配置，不是已发布版本的 |
| 机器人活着但每次分析都失败 | VPS 在境内，`api.anthropic.com` 不通。配 `ANTHROPIC_BASE_URL` 走中转 |
| `SSL certificate verification failed (UNABLE_TO_GET_ISSUER_CERT)` | SDK 自带 CLI 的信任库认不出中转的中间 CA。代码已自动补系统根证书；仍失败时在 `.env` 里显式指定 `NODE_EXTRA_CA_CERTS` |
| `model not found` / 模型名相关报错 | 中转不认 `claude-*`。把 `.env` 的 `MODEL` 改成中转支持的型号名 |
| 凭据明明填了却 401 | `dotenv` 不覆盖已有环境变量。本机 shell 里的 `ANTHROPIC_*` 会盖过 `.env`，用 `npm run check` 看实际生效的值 |
| `Native CLI binary not found` | 装依赖时用了 `--omit=optional`，重装 |
| 收不到消息 | 事件订阅没配、没选长连接、或没加 `im.message.receive_v1` |
| 发不出消息（403） | 缺 `im:message:send_as_bot` 权限，或改了权限没重新发布版本 |
| 卡片一直停在「正在整理…」 | 服务崩过。重启后会自动对账并改成「请重发」 |
| 群里每条消息都触发 | 检查 `ALLOWED_CHATS`，群里必须 @机器人 才响应 |
| 数字读错了 | 长截图被压缩。看 `raw/` 里的切分图，必要时让用户重发 |

## 代码结构

```
bot/
  index.mjs     事件入口（只去重+入队）、任务执行、产物交付
  queue.mjs     全局串行队列 + 持久化任务日志 + 超时 + 启动对账
  agent.mjs     无状态 SDK 封装 + 写入防线（PreToolUse hook）
  feishu.mjs    API 封装 + schema 2.0 卡片构造
  events.mjs    事件解析、访问控制、富文本图片提取
  media.mjs     图片落地：magic byte 嗅探 / HEIC 转码 / 长图切分 / 去重
  tools.mjs     进程内 MCP 渲染工具（取代 Bash）
  render.mjs    xlsx 与响应式对比页的渲染
  store.mjs     原子写、单实例锁、心跳、日志
spec/
  AGENT_SPEC.md Agent 行为规范（每轮注入 systemPrompt）
```

`npm test` 覆盖了不依赖飞书凭据的全部核心逻辑：格式嗅探、长图切分、去重、
事件解析、访问控制、渲染、写入防线、队列超时与对账。
