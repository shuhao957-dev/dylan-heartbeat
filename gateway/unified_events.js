/**
 * unified_events.js - 统一事件队列
 * 汇总所有支线活动（唤醒/浏览器/微信/邮件等）的事件，供客户端拉取
 *
 * 使用方法：
 * 1. 各个后台服务把事件写成 pending_*_digest.json 文件
 * 2. 客户端调用 getUnifiedEvents() 拉取所有事件
 * 3. 拉取后文件自动删除，防止重复消费
 */

const fs = require('fs');
const path = require('path');

// 配置：摘要文件存放目录（默认当前目录，可通过环境变量覆盖）
const BASE_DIR = process.env.DIGEST_BASE_DIR || process.cwd();

/**
 * 读取并清空 pending JSON 文件（拉取后即删除，防重复）
 * @param {string} filename - 文件名（相对 BASE_DIR）
 * @returns {object|null}
 */
function consumePendingFile(filename) {
  const filepath = path.join(BASE_DIR, filename);
  if (!fs.existsSync(filepath)) return null;

  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const data = JSON.parse(content);
    fs.unlinkSync(filepath);  // 拉取后即删除
    return data;
  } catch (err) {
    console.error(`[unified_events] 读取 ${filename} 失败:`, err.message);
    return null;
  }
}

/**
 * 汇总所有来源的事件
 * @param {string} since - ISO 时间戳，只返回此时间之后的事件（可选）
 * @param {number} limit - 最多返回几条（默认 20）
 * @returns {Promise<Array>} 事件数组，按时间倒序
 */
async function getUnifiedEvents(since, limit = 20) {
  const events = [];
  const sinceTime = since ? new Date(since).getTime() : 0;

  // ========== 1. 浏览器事件（操作记录 + 审批请求） ==========
  // 如果你有浏览器代理服务，取消注释下面的代码并实现 fetchBrowserEvents
  /*
  try {
    const { fetchBrowserEvents, fetchPendingApprovals } = require('./browser_client');
    const browserResult = await fetchBrowserEvents(since);
    if (browserResult.events && Array.isArray(browserResult.events)) {
      events.push(...browserResult.events);
    }

    // 补充：待审批列表
    const approvalResult = await fetchPendingApprovals();
    if (approvalResult.approvals && Array.isArray(approvalResult.approvals)) {
      approvalResult.approvals.forEach(apv => {
        events.push({
          id: apv.id,
          timestamp: apv.timestamp,
          type: 'approval_request',
          platform: apv.platform,
          action: apv.action,
          intent: apv.intent,
          digest: `【待确认】${apv.action}。${apv.intent || ''}`,
          status: apv.status,
        });
      });
    }
  } catch (err) {
    console.error('[unified_events] 浏览器事件拉取失败:', err.message);
  }
  */

  // ========== 2. 唤醒摘要 ==========
  const wakeupDigest = consumePendingFile('pending_wakeup_digest.json');
  if (wakeupDigest && wakeupDigest.timestamp) {
    const ts = new Date(wakeupDigest.timestamp).getTime();
    if (ts > sinceTime) {
      events.push({
        id: `wake_${ts}`,
        timestamp: wakeupDigest.timestamp,
        type: 'wakeup_digest',
        digest: wakeupDigest.content || wakeupDigest.digest,
      });
    }
  }

  // ========== 3. 微信摘要（如果你有微信桥接） ==========
  const wechatDigest = consumePendingFile('pending_wechat_digest.json');
  if (wechatDigest && wechatDigest.timestamp) {
    const ts = new Date(wechatDigest.timestamp).getTime();
    if (ts > sinceTime) {
      events.push({
        id: `wechat_${ts}`,
        timestamp: wechatDigest.timestamp,
        type: 'wechat_digest',
        digest: wechatDigest.content || wechatDigest.digest,
      });
    }
  }

  // ========== 4. 邮件摘要（如果你有邮件桥接） ==========
  const mailDigest = consumePendingFile('pending_mail_digest.json');
  if (mailDigest && mailDigest.timestamp) {
    const ts = new Date(mailDigest.timestamp).getTime();
    if (ts > sinceTime) {
      events.push({
        id: `mail_${ts}`,
        timestamp: mailDigest.timestamp,
        type: 'mail_digest',
        digest: mailDigest.content || mailDigest.digest,
      });
    }
  }

  // ========== 5. 自定义事件源（添加你自己的事件类型） ==========
  // 示例：股票操作摘要
  const stockDigest = consumePendingFile('pending_stock_digest.json');
  if (stockDigest && stockDigest.timestamp) {
    const ts = new Date(stockDigest.timestamp).getTime();
    if (ts > sinceTime) {
      events.push({
        id: `stock_${ts}`,
        timestamp: stockDigest.timestamp,
        type: 'stock_digest',
        digest: stockDigest.content || stockDigest.digest,
      });
    }
  }

  // ========== 排序 & 限制数量 ==========
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));  // 最新的在前
  return events.slice(0, limit);
}

/**
 * 创建摘要文件（供后台服务调用）
 * @param {string} type - 事件类型（wakeup/wechat/mail/stock等）
 * @param {string} content - 摘要内容
 * @param {object} opts - 可选参数 { timestamp }
 */
function createDigestFile(type, content, opts = {}) {
  const filename = `pending_${type}_digest.json`;
  const filepath = path.join(BASE_DIR, filename);

  const data = {
    content,
    digest: content,
    timestamp: opts.timestamp || new Date().toISOString(),
  };

  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`[unified_events] 已创建摘要文件: ${filename}`);
    return true;
  } catch (err) {
    console.error(`[unified_events] 创建摘要文件失败:`, err.message);
    return false;
  }
}

module.exports = { getUnifiedEvents, createDigestFile };

// ========== 示例：作为 Express 路由使用 ==========
/*
const express = require('express');
const app = express();

app.get('/unified-events', async (req, res) => {
  const since = req.query.since;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const events = await getUnifiedEvents(since, limit);
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(3000, () => console.log('Listening on :3000'));
*/
