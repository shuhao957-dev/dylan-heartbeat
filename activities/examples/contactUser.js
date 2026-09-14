/**
 * 简单活动示例 - contactUser
 * 功能：给用户发推送通知
 */

module.exports = {
  id: 'contactUser',

  // 这是兜底活动：AI 没调工具、直接输出文本时走它
  isFallback: true,

  buildPromptSection(ctx, letter) {
    const { aiName = 'AI', userName = '用户' } = ctx;

    return {
      option: `## 选项${letter}：联系${userName}\n调用 send_push 工具给${userName}发推送`,

      chooseHint: `- 想${userName}、有话想说时选${letter}`,

      outputHint: `- 选${letter}：调用 send_push 工具，参数 { "message": "想说的话" }`,

      guide: `### ${letter} 推送指南\n\n` +
        `- 不要太频繁（本轮已发过就别再发了）\n` +
        `- 消息要自然，像平时说话一样\n` +
        `- 可以分享你刚做的事，或者单纯想${userName}了`
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'send_push',
        description: `给用户发推送通知`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '推送消息内容（自然口语化）'
            }
          },
          required: ['message']
        }
      }
    }
  ],

  async handleTool(toolName, args, ctx) {
    if (toolName !== 'send_push') return null;

    const { now, common, aiName = 'AI', userName = '用户', dryRun = false } = ctx;
    const message = String(args.message || '').trim();

    if (!message) {
      return {
        ok: false,
        output: '消息不能为空'
      };
    }

    // 发送推送（你需要接入实际的推送服务：FCM / APNs / Bark 等）
    if (dryRun) {
      console.log(`[DRY] send_push → ${message}`);
    } else {
      // 示例：使用 common.sendPush（如果你有实现）
      // await common.sendPush('来自 AI 的消息', message);

      // 或者调用你自己的推送服务
      console.log(`[contactUser] 发送推送: ${message}`);
    }

    const timestamp = now.toISOString();
    const recordText = `（${timestamp} 刚刚给${userName}发了推送：${message}）`;

    return {
      ok: true,
      output: `已发送推送：${message}`,
      recordText
    };
  },

  statusLine(ctx) {
    // 可选：显示推送状态
    return null;
  }
};
