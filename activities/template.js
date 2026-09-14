/**
 * 活动模板 - 按此接口实现新活动
 *
 * 每个活动需要提供：
 * 1. buildPromptSection - Prompt 的 4 个部分
 * 2. tools - 工具定义（OpenAI function calling 格式）
 * 3. handleTool - 工具处理器
 * 4. 可选钩子：statusLine / prepare / resetCycle
 */

module.exports = {
  // 活动唯一标识（与 .env 的 WAKE_ACTIVITIES 对应）
  id: 'myActivity',

  // 是否是兜底活动（AI 没调工具时走它）
  isFallback: false,

  /**
   * 构建 Prompt 的四个部分
   * @param {object} ctx - 上下文 { now, currentTime, diffMinutes, state, common, aiName, userName }
   * @param {string} letter - 分配的选项字母（A/B/C/...）
   * @returns {object} { option, chooseHint, outputHint, guide }
   */
  buildPromptSection(ctx, letter) {
    const { aiName = 'AI', userName = '用户' } = ctx;

    return {
      // 在「你可以做的事」章节显示
      option: `## 选项${letter}：做某事\n调用 my_tool 工具做某事`,

      // 在「如何选择」章节显示
      chooseHint: `- 想做某事时选${letter}`,

      // 在「输出格式」章节显示
      outputHint: `- 选${letter}：调用 my_tool 工具`,

      // 在末尾显示（可选，详细指引）
      guide: `### ${letter} 活动攻略\n\n详细的活动规则、注意事项...`
    };
  },

  /**
   * 工具定义（OpenAI function calling 格式）
   */
  tools: [
    {
      type: 'function',
      function: {
        name: 'my_tool',
        description: '做某事的工具',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: '要做的动作'
            },
            message: {
              type: 'string',
              description: '相关消息（可选）'
            }
          },
          required: ['action']
        }
      }
    }
  ],

  /**
   * 工具处理器
   * @param {string} toolName - 工具名
   * @param {object} args - 工具参数（已解析 JSON）
   * @param {object} ctx - 上下文（同 buildPromptSection）
   * @returns {Promise<{ok: boolean, output: string, recordText?: string}>}
   */
  async handleTool(toolName, args, ctx) {
    if (toolName !== 'my_tool') return null;

    const { now, aiName = 'AI', userName = '用户' } = ctx;

    // 执行业务逻辑
    console.log(`[myActivity] 执行动作: ${args.action}`);

    // 模拟异步操作
    await new Promise(resolve => setTimeout(resolve, 100));

    // 返回结果
    return {
      ok: true,
      output: `成功执行了 ${args.action}`,  // 给 AI 的反馈（会继续拼进对话）
      recordText: `[我的活动]（${now.toISOString()} ${aiName}做了某事）\n${args.message || args.action}`  // 写进 wake_session 的记录
    };
  },

  // === 可选钩子 ===

  /**
   * 状态行（显示在 Prompt 的「当前状态」章节）
   */
  statusLine(ctx) {
    return '当前状态：一切正常';
  },

  /**
   * 预加载（每轮唤醒开始时调用，用于刷新缓存）
   */
  async prepare(ctx) {
    console.log('[myActivity] 预加载缓存...');
    // 例如：预加载游戏攻略、论坛热帖等
  },

  /**
   * 重置周期限制（每轮唤醒开始时调用）
   */
  resetCycle() {
    console.log('[myActivity] 重置周期限制');
    // 例如：重置「本轮已执行 N 次」计数器
  }
};

// === 使用示例 ===
/*
// 在主调度器中注册活动：
const myActivity = require('./activities/myActivity');

const ACTIVITIES = [
  myActivity,
  // ... 其他活动
];

// 启用活动（通过 .env 配置）：
// WAKE_ACTIVITIES=myActivity,anotherActivity

// 活动执行流程：
// 1. 主调度器调用 buildPromptSection() 构建 Prompt
// 2. LLM 返回工具调用
// 3. 主调度器调用 handleTool() 执行
// 4. handleTool() 返回的 recordText 写入 wake_session
// 5. 用户下次说话时，wake_digest 把整段拼成摘要注入
*/
