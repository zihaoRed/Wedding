import { paths, config } from './config.mjs';
import { readJson, writeJsonAtomic, logger } from './store.mjs';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned', 'merged']);
// 飞书重推窗口最长约 7 小时（15s/5min/1h/6h，最多 4 次），去重记录必须活得更久。
const DEDUPE_TTL_MS = 48 * 3600 * 1000;

/**
 * 全局串行队列。
 *
 * 注意是「全局」而不是「按 chat」：并发冲突的共享资源是整个 workspace，
 * 不是单个会话。伴侣私聊机器人就是第二个 chat_id，两个 Agent 会同时写同一份
 * Markdown。两人串行完全够用，所以直接一把锁。
 *
 * 队列同时承担三件事：
 *  - 持久化 job journal：入队先落盘，进程崩溃后能对账，不会留下永远「整理中」的卡片
 *  - 持久化去重表：飞书会重推，且必须扛住进程重启
 *  - 墙钟超时：maxTurns/maxBudgetUsd 约束的是成本不是时间，一个卡住的 job
 *    会把整个聊天永久堵死
 */
export class JobQueue {
  #jobs = new Map();
  #order = [];
  #running = null;
  #draining = false;
  #runner;
  #onOrphan;

  constructor({ runner, onOrphan }) {
    this.#runner = runner;
    this.#onOrphan = onOrphan;
  }

  #persist() {
    writeJsonAtomic(paths.journal, [...this.#jobs.values()]);
  }

  /** 启动对账：把上次没跑完的 job 标成 orphaned 并通知调用方去改卡片。 */
  async reconcile() {
    const saved = readJson(paths.journal, []);
    const orphans = saved.filter((j) => !TERMINAL.has(j.status));
    const keep = saved.filter((j) => TERMINAL.has(j.status));
    this.#jobs = new Map(keep.map((j) => [j.eventId, j]));
    if (orphans.length) {
      logger.warn(`[queue] 发现 ${orphans.length} 个上次没跑完的任务，标记为 orphaned`);
      this.#persist();
      for (const job of orphans) {
        try { await this.#onOrphan?.(job); } catch (err) { logger.error('[queue] 对账回调失败', err); }
      }
    }
    this.#gc();
  }

  /** 飞书事件去重。命中说明这条消息已经处理过（或正在处理）。 */
  hasSeen(eventId) {
    const job = this.#jobs.get(eventId);
    return Boolean(job);
  }

  /**
   * 入队。**同步返回**——事件回调必须立刻 return，任何网络 I/O 都会吃掉 3 秒预算。
   *
   * 带 `coalesce: true` 的任务（图片消息）会先在队列里等 coalesceMs 再开跑，
   * 期间同 chat 的后续消息并进来，于是一次转发 6 张图 = 一个 job = 一次 query，
   * 而不是 6 次完整 Agent 回合。
   */
  enqueue(job) {
    const now = Date.now();

    const host = this.#coalesceHost(job, now);
    if (host) return this.#absorb(host, job, now);

    const entry = {
      ...job,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      error: null,
      notBefore: now + (job.coalesce ? config.run.coalesceMs : 0),
    };
    this.#jobs.set(entry.eventId, entry);
    this.#order.push(entry.eventId);
    this.#persist();

    if (job.coalesce) setTimeout(() => this.#drain(), config.run.coalesceMs);
    else setImmediate(() => this.#drain());
    return entry;
  }

  /** 找一个还在排队、还没开跑、且窗口内的同 chat 合并宿主。 */
  #coalesceHost(job, now) {
    // 命令（/stop /status）必须立刻独立执行，绝不能被并进一个图片任务里
    if (job.kind === 'command' || !job.chatId) return null;
    return [...this.#jobs.values()].find((j) => (
      j.coalesce && j.status === 'queued' && j.chatId === job.chatId
      && now - j.createdAt <= config.run.coalesceMs
    ));
  }

  #absorb(host, job, now) {
    host.images = [...(host.images ?? []), ...(job.images ?? [])];
    if (job.text) host.text = host.text ? `${host.text}\n${job.text}` : job.text;
    host.updatedAt = now;

    // 被吸收的那条也要留档。飞书会重推它，没有记录就会被当成新消息再跑一遍。
    const absorbed = {
      ...job, status: 'merged', mergedInto: host.eventId,
      createdAt: now, updatedAt: now, error: null,
    };
    this.#jobs.set(absorbed.eventId, absorbed);
    this.#order.push(absorbed.eventId);
    this.#persist();

    logger.info(`[queue] 合并 event=${job.eventId} → ${host.eventId}（本批已 ${host.images.length} 张图）`);
    return host;
  }

  cancel(jobOrChatId) {
    const target = typeof jobOrChatId === 'string'
      ? [...this.#order].reverse().find((id) => this.#jobs.get(id)?.chatId === jobOrChatId && !TERMINAL.has(this.#jobs.get(id).status))
      : jobOrChatId;
    if (!target) return false;
    const job = typeof target === 'string' ? this.#jobs.get(target) : target;
    if (!job || TERMINAL.has(job.status)) return false;

    if (this.#running?.eventId === job.eventId) {
      this.#running.controller.abort();   // 正在跑 → 打断它
    } else {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      this.#persist();
    }
    return true;
  }

  get depth() {
    return this.#order.filter((id) => {
      const s = this.#jobs.get(id)?.status;
      return s === 'queued' || s === 'running';
    }).length;
  }

  get runningJob() { return this.#running; }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const nextId = this.#order.find((id) => this.#jobs.get(id)?.status === 'queued');
        if (!nextId) break;
        const job = this.#jobs.get(nextId);

        // 合并窗口没到就先不开跑。后面的 job 一起等——顺序不能乱，
        // 而且窗口内的消息本来就会并到这个 job 上，实际不会有人被拖住。
        const wait = (job.notBefore ?? 0) - Date.now();
        if (wait > 0) { setTimeout(() => this.#drain(), wait); break; }

        await this.#runOne(job);
      }
    } finally {
      this.#draining = false;
      this.#gc();
      this.#persist();
    }
  }

  async #runOne(job) {
    const controller = new AbortController();
    this.#running = { eventId: job.eventId, controller };
    job.status = 'running';
    job.updatedAt = Date.now();
    this.#persist();

    const timer = setTimeout(() => controller.abort(new Error('timeout')), config.run.jobTimeoutMs);

    try {
      await this.#runner(job, { signal: controller.signal });
      if (job.status === 'running') {
        job.status = controller.signal.aborted ? 'cancelled' : 'done';
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      job.status = aborted ? 'cancelled' : 'failed';
      job.error = String(err?.message || err);
      logger.error(`[queue] job ${job.eventId} ${job.status}:`, job.error);
    } finally {
      clearTimeout(timer);
      job.updatedAt = Date.now();
      this.#running = null;
      this.#persist();
    }
  }

  /** 清掉过期的终态记录；进行中的永远保留。 */
  #gc() {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    const alive = [];
    for (const id of this.#order) {
      const job = this.#jobs.get(id);
      if (!job) continue;
      if (!TERMINAL.has(job.status) || job.updatedAt > cutoff) alive.push(id);
      else this.#jobs.delete(id);
    }
    this.#order = alive;
  }
}

const STATUS_LABEL = {
  done: '完成', failed: '失败', cancelled: '已取消', orphaned: '已中断',
  running: '进行中', queued: '排队中', merged: '已并入同批',
};
export const statusLabel = (s) => STATUS_LABEL[s] || s;
