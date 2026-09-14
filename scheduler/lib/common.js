/**
 * common.js - 调度器通用工具库
 * 包含：推送、回灌网关、时间处理、状态管理
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// ============ 配置 ============

const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Shanghai';
const BASE_DIR = process.env.BASE_DIR || process.cwd();

// ============ 推送功能 ============

/**
 * 发送推送通知（支持多个平台）
 * @param {string} title - 推送标题
 * @param {string} body - 推送内容
 * @returns {Promise<{ok: boolean, platform?: string}>}
 */
async function sendPush(title, body) {
  const platform = process.env.PUSH_PLATFORM || 'ntfy';

  try {
    if (platform === 'ntfy') {
      // Ntfy 推送
      const ntfyUrl = process.env.NTFY_URL || 'https://ntfy.sh';
      const topic = process.env.NTFY_TOPIC;

      if (!topic) throw new Error('缺少 NTFY_TOPIC 配置');

      const resp = await fetch(`${ntfyUrl}/${topic}`, {
        method: 'POST',
        headers: {
          'Title': title,
          'Priority': 'default',
          'Tags': 'robot'
        },
        body: body
      });

      if (!resp.ok) throw new Error(`Ntfy 返回 ${resp.status}`);
      return { ok: true, platform: 'ntfy' };

    } else if (platform === 'bark') {
      // Bark 推送（iOS）
      const barkKey = process.env.BARK_KEY;
      const barkUrl = process.env.BARK_URL || 'https://api.day.app';
      const icon = process.env.CUSTOM_ICON || '';

      if (!barkKey) throw new Error('缺少 BARK_KEY 配置');

      const url = `${barkUrl}/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}` +
        (icon ? `?icon=${encodeURIComponent(icon)}` : '');

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Bark 返回 ${resp.status}`);
      return { ok: true, platform: 'bark' };

    } else if (platform === 'custom') {
      // 自定义推送（调用你自己的 webhook）
      const webhookUrl = process.env.PUSH_WEBHOOK_URL;
      if (!webhookUrl) throw new Error('缺少 PUSH_WEBHOOK_URL 配置');

      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, timestamp: new Date().toISOString() })
      });

      if (!resp.ok) throw new Error(`Webhook 返回 ${resp.status}`);
      return { ok: true, platform: 'custom' };

    } else {
      throw new Error(`不支持的推送平台: ${platform}`);
    }
  } catch (err) {
    console.error('[sendPush] 推送失败:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============ 回灌网关 ============

/**
 * 写入网关的内部端点（把唤醒产物写进时间线）
 * @param {string} endpoint - 端点名（如 'wake-event', 'push-message'）
 * @param {string} content - 内容
 * @returns {Promise<{ok: boolean}>}
 */
async function writeToGateway(endpoint, content) {
  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://127.0.0.1:18006';
  const gatewayKey = process.env.GATEWAY_INTERNAL_KEY || '';

  try {
    const resp = await fetch(`${gatewayUrl}/internal/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayKey ? { 'Authorization': `Bearer ${gatewayKey}` } : {})
      },
      body: JSON.stringify({
        content,
        timestamp: new Date().toISOString()
      })
    });

    if (!resp.ok) throw new Error(`网关返回 ${resp.status}`);
    return { ok: true };
  } catch (err) {
    console.error('[writeToGateway] 回灌失败:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============ 时间处理 ============

/**
 * 获取格式化的当前时间（本地时区）
 * @param {Date} date - 日期对象
 * @returns {string} 格式如 "2026-09-14 10:08"
 */
function getTimeString(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

/**
 * 判断是否是白天（根据配置的时间范围）
 * @returns {boolean}
 */
function isDayTime() {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    hour12: false
  }));

  const startHour = parseInt(process.env.WAKE_DAY_START_HOUR) || 8;
  const endHour = parseInt(process.env.WAKE_DAY_END_HOUR) || 23;

  return hour >= startHour && hour < endHour;
}

/**
 * 从消息数组中获取最后一条用户消息的时间
 * @param {Array} messages - 消息数组
 * @returns {Date|null}
 */
function getLastUserTime(messages) {
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.timestamp) {
      return new Date(m.timestamp);
    }
  }

  return null;
}

// ============ 状态管理 ============

/**
 * 读取持久化状态
 * @param {string} stateFile - 状态文件路径
 * @returns {object}
 */
function loadState(stateFile) {
  try {
    if (fs.existsSync(stateFile)) {
      return fs.readJsonSync(stateFile);
    }
  } catch (err) {
    console.error('[loadState] 读取失败:', err.message);
  }
  return {};
}

/**
 * 保存持久化状态
 * @param {string} stateFile - 状态文件路径
 * @param {object} state - 状态对象
 */
function saveState(stateFile, state) {
  try {
    fs.writeJsonSync(stateFile, state, { spaces: 2 });
  } catch (err) {
    console.error('[saveState] 保存失败:', err.message);
  }
}

/**
 * 加载时间线（从网关读取最近的对话）
 * @returns {Array}
 */
function loadTimeline() {
  const timelineFile = path.join(BASE_DIR, 'enhanced_messages.json');
  try {
    if (fs.existsSync(timelineFile)) {
      return fs.readJsonSync(timelineFile);
    }
  } catch (err) {
    console.error('[loadTimeline] 读取失败:', err.message);
  }
  return [];
}

// ============ 辅助函数 ============

/**
 * 标准化消息内容（处理字符串/数组/对象）
 * @param {*} content
 * @returns {string}
 */
function normalizeContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(normalizeContentToText).join('');
  }
  if (content && typeof content === 'object') {
    if (content.text) return content.text;
    if (content.content) return normalizeContentToText(content.content);
  }
  return '';
}

/**
 * 读取数字类型的环境变量
 * @param {string} key - 环境变量名
 * @param {number} defaultValue - 默认值
 * @returns {number}
 */
function readNumberEnv(key, defaultValue) {
  const val = parseInt(process.env[key]);
  return Number.isFinite(val) && val > 0 ? val : defaultValue;
}

/**
 * 修复 JSON.parse 的参数问题（兼容旧代码）
 */
function fixArguments(argsString) {
  try {
    return JSON.parse(argsString);
  } catch (err) {
    console.error('[fixArguments] JSON 解析失败:', err.message);
    return {};
  }
}

// ============ 导出 ============

module.exports = {
  TIME_ZONE,
  BASE_DIR,

  // 推送和回灌
  sendPush,
  writeToGateway,

  // 时间处理
  getTimeString,
  isDayTime,
  getLastUserTime,

  // 状态管理
  loadState,
  saveState,
  loadTimeline,

  // 辅助函数
  normalizeContentToText,
  readNumberEnv,
  fixArguments
};
