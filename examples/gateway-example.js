/**
 * 网关示例 - 完整的摘要注入实现
 *
 * 核心流程：
 * 1. 用户发新消息 → 快照 wake_session 成摘要
 * 2. 注入摘要到消息数组（最后一条用户消息之前）
 * 3. 转发给上游 LLM
 */

const express = require('express');
const wakeDigest = require('./core/wake_digest');
const crypto = require('crypto');
const fs = require('fs-extra');

const app = express();
app.use(express.json());

// ============ 辅助函数 ============

/**
 * 计算用户消息指纹（用于去重）
 * 同一条用户消息重试（如 Kelivo 生成标题）不会白烧注入轮数
 */
function getUserFingerprint(messages) {
  const lastUserMsg = messages.slice().reverse().find(m => {
    if (m.role !== 'user') return false;
    const content = normalizeContent(m.content);
    // 跳过 <system> 标记的消息
    if (content.startsWith('<system>')) return false;
    return true;
  });

  if (!lastUserMsg) return null;

  return crypto.createHash('md5')
    .update(JSON.stringify(lastUserMsg))
    .digest('hex')
    .slice(0, 12);
}

/**
 * 标准化消息内容（处理字符串 / 数组 / 对象格式）
 */
function normalizeContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(normalizeContent).join('');
  if (c && typeof c === 'object' && c.text) return c.text;
  return '';
}

/**
 * 获取最后一条用户消息的时间戳
 */
function getLastUserTime(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      // 尝试从消息中提取时间戳
      if (m.timestamp) return m.timestamp;
      // 或者从时间线文件中查找
      // 这里简化处理，返回当前时间
      return new Date().toISOString();
    }
  }
  return null;
}

// ============ 主路由 ============

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const llmMessages = [...req.body.messages];

    // === 步骤 1：用户发新消息时，快照摘要 ===
    const hasUserMessage = llmMessages.some(m => m.role === 'user');

    if (hasUserMessage) {
      try {
        // 读取 wake_session（如果存在）
        let wakeSession = [];
        if (fs.existsSync('current_wake_session.json')) {
          wakeSession = fs.readJsonSync('current_wake_session.json');
        }

        if (wakeSession.length > 0) {
          console.log(`[gateway] 发现 ${wakeSession.length} 条 wake_session 记录，准备快照`);

          // 快照成待注入摘要
          wakeDigest.captureDigest(wakeSession, {
            now: new Date(),
            prevUserAt: getLastUserTime(llmMessages),
            aiName: process.env.AI_NAME || 'AI',
            userName: process.env.USER_NAME || '用户'
          });

          // 清空 wake_session
          fs.writeJsonSync('current_wake_session.json', []);
          console.log('[gateway] 已清空 wake_session');
        }
      } catch (e) {
        console.error('[gateway] 快照摘要失败:', e.message);
        // 失败不阻断主流程
      }
    }

    // === 步骤 2：注入摘要 ===
    const currentUserFp = getUserFingerprint(llmMessages);
    const digestText = wakeDigest.consumeDigest(currentUserFp);

    if (digestText) {
      // 找到插入位置：最后一条真实用户消息之前
      let insertAt = llmMessages.length - 1;

      while (insertAt > 0) {
        const m = llmMessages[insertAt];

        // 不是用户消息，往前找
        if (m.role !== 'user') {
          insertAt--;
          continue;
        }

        // 跳过 <system> 标记的用户消息
        const content = normalizeContent(m.content);
        if (content.startsWith('<system>')) {
          insertAt--;
          continue;
        }

        // 找到了真实用户消息
        break;
      }

      // 缓存优化：摘要只插在末尾附近（最后 3 条消息内）
      // 这样不会破坏 prompt cache 的前缀命中
      const safeInsertAt = Math.max(insertAt, llmMessages.length - 3);

      llmMessages.splice(safeInsertAt, 0, {
        role: 'assistant',
        content: digestText
      });

      console.log(`[gateway] 已注入摘要（${digestText.length} 字），位置 ${safeInsertAt}/${llmMessages.length}`);
    }

    // === 步骤 3：转发给上游 LLM ===
    const upstreamUrl = process.env.UPSTREAM_API_URL;
    const upstreamKey = process.env.UPSTREAM_API_KEY;

    if (!upstreamUrl || !upstreamKey) {
      return res.status(500).json({
        error: '网关配置错误：缺少 UPSTREAM_API_URL 或 UPSTREAM_API_KEY'
      });
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${upstreamKey}`
      },
      body: JSON.stringify({
        ...req.body,
        messages: llmMessages
      })
    });

    // === 步骤 4：原样返回 ===
    res.status(upstreamResp.status);
    res.set('Content-Type', upstreamResp.headers.get('content-type'));
    res.send(await upstreamResp.text());

  } catch (error) {
    console.error('[gateway] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ 健康检查 ============

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gateway: 'dylan-heartbeat',
    uptime: process.uptime()
  });
});

// ============ 启动 ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dylan Heartbeat Gateway listening on :${PORT}`);
  console.log(`Upstream: ${process.env.UPSTREAM_API_URL || '(未配置)'}`);
});
