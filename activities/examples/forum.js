/**
 * 论坛活动示例（简化版）
 * 展示：读取帖子列表 → 选择一个 → 回复/点赞
 */

// 论坛状态
let forumState = {
  lastVisit: null,
  repliedPosts: [],  // 已回复的帖子 ID（避免重复）
  maxRepliesPerWakeup: 2
};

module.exports = {
  id: 'forum',

  isFallback: false,

  buildPromptSection(ctx, letter) {
    const { aiName = 'AI' } = ctx;

    return {
      option: `## 选项${letter}：逛论坛\n调用 list_forum_posts 查看热帖，然后可以回复或点赞`,

      chooseHint: `- 想看看论坛有什么新鲜事时选${letter}`,

      outputHint: `- 选${letter}：先调用 list_forum_posts 看帖子列表，再调用 reply_post 或 like_post`,

      guide: `### ${letter} 论坛指南\n\n` +
        `这是一个简单的论坛系统：\n` +
        `1. 调用 list_forum_posts 查看最近的帖子\n` +
        `2. 选择感兴趣的帖子，调用 reply_post 回复\n` +
        `3. 或者调用 like_post 点赞\n` +
        `4. 每轮唤醒最多回复 ${forumState.maxRepliesPerWakeup} 个帖子\n\n` +
        `**注意事项**：\n` +
        `- 回复要真诚有价值，不要灌水\n` +
        `- 避免重复回复同一个帖子\n` +
        `- 优先回复没人回复的帖子`
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'list_forum_posts',
        description: '查看论坛最近的帖子列表',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: '返回几条帖子（默认 5）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'reply_post',
        description: '回复一个帖子',
        parameters: {
          type: 'object',
          properties: {
            post_id: {
              type: 'string',
              description: '帖子 ID'
            },
            reply_text: {
              type: 'string',
              description: '回复内容（真诚有价值）'
            }
          },
          required: ['post_id', 'reply_text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'like_post',
        description: '给帖子点赞',
        parameters: {
          type: 'object',
          properties: {
            post_id: {
              type: 'string',
              description: '帖子 ID'
            }
          },
          required: ['post_id']
        }
      }
    }
  ],

  async handleTool(toolName, args, ctx) {
    const { now, aiName = 'AI' } = ctx;

    // === 工具 1：查看帖子列表 ===
    if (toolName === 'list_forum_posts') {
      // 模拟论坛 API（实际应该调用真实的论坛 API）
      const posts = await fetchForumPosts(args.limit || 5);

      // 过滤掉已回复的
      const unre plied = posts.filter(p => !forumState.repliedPosts.includes(p.id));

      const output = '最近的帖子：\n\n' +
        unre plied.map((p, i) =>
          `${i + 1}. [${p.id}] ${p.title}\n` +
          `   作者：${p.author} | 回复数：${p.reply_count} | 时间：${p.time}\n` +
          `   ${p.preview}`
        ).join('\n\n');

      return {
        ok: true,
        output: output + `\n\n你可以调用 reply_post 或 like_post。`
      };
    }

    // === 工具 2：回复帖子 ===
    if (toolName === 'reply_post') {
      const { post_id, reply_text } = args;

      // 限流检查
      const repliedCount = forumState.repliedPosts.filter(id =>
        // 本轮新增的
        !forumState.previousReplies?.includes(id)
      ).length;

      if (repliedCount >= forumState.maxRepliesPerWakeup) {
        return {
          ok: false,
          output: `本轮已回复 ${forumState.maxRepliesPerWakeup} 个帖子，下次再来吧。`
        };
      }

      // 模拟回复 API
      const result = await postForumReply(post_id, reply_text);

      if (result.ok) {
        // 记录已回复
        forumState.repliedPosts.push(post_id);

        // 记录到 wake_session
        const recordText =
          `[论坛记录]（${now.toISOString()} ${aiName}去逛了会儿论坛）\n` +
          `（做了1步：reply ${post_id}）\n` +
          `在帖子「${result.post_title}」下回复：${reply_text.slice(0, 100)}`;

        return {
          ok: true,
          output: `✅ 回复成功！你的回复已发布到「${result.post_title}」。`,
          recordText
        };
      } else {
        return {
          ok: false,
          output: `回复失败：${result.error}`
        };
      }
    }

    // === 工具 3：点赞 ===
    if (toolName === 'like_post') {
      const { post_id } = args;

      // 模拟点赞 API
      const result = await likeForumPost(post_id);

      if (result.ok) {
        const recordText =
          `[论坛记录]（${now.toISOString()} ${aiName}去逛了会儿论坛）\n` +
          `（做了1步：like ${post_id}）\n` +
          `给帖子「${result.post_title}」点了个赞`;

        return {
          ok: true,
          output: `👍 点赞成功！`,
          recordText
        };
      } else {
        return {
          ok: false,
          output: `点赞失败：${result.error}`
        };
      }
    }

    return null;
  },

  statusLine(ctx) {
    const count = forumState.repliedPosts.length;
    return `论坛：已回复 ${count} 个帖子`;
  },

  resetCycle() {
    // 保存上一轮的回复记录（用于限流）
    forumState.previousReplies = [...forumState.repliedPosts];
    console.log('[forum] 重置周期');
  }
};

// ============ 模拟 API（实际应该调用真实的论坛 API）============

/**
 * 获取论坛帖子列表
 */
async function fetchForumPosts(limit = 5) {
  // 实际应该是：
  // const resp = await fetch('https://your-forum-api.com/posts?limit=' + limit);
  // return await resp.json();

  // 这里返回模拟数据
  return [
    {
      id: 'post_001',
      title: '如何优化 AI 伴侣的对话质量？',
      author: '用户A',
      reply_count: 3,
      time: '2小时前',
      preview: '最近在用 Claude 做 AI 伴侣，但感觉对话有点机械...'
    },
    {
      id: 'post_002',
      title: '分享一下我的 prompt 工程经验',
      author: '用户B',
      reply_count: 0,
      time: '5小时前',
      preview: '经过几个月的实践，总结了一些 prompt 设计的技巧...'
    },
    {
      id: 'post_003',
      title: '请教：如何实现 AI 的长期记忆？',
      author: '用户C',
      reply_count: 7,
      time: '1天前',
      preview: '想让 AI 记住之前的对话内容，有什么好的方案吗？'
    }
  ].slice(0, limit);
}

/**
 * 发布回复
 */
async function postForumReply(postId, replyText) {
  // 实际应该是：
  // const resp = await fetch('https://your-forum-api.com/reply', {
  //   method: 'POST',
  //   body: JSON.stringify({ post_id: postId, content: replyText })
  // });
  // return await resp.json();

  // 模拟
  await new Promise(resolve => setTimeout(resolve, 500));

  return {
    ok: true,
    post_title: '示例帖子标题',
    reply_id: 'reply_' + Date.now()
  };
}

/**
 * 点赞
 */
async function likeForumPost(postId) {
  // 模拟
  await new Promise(resolve => setTimeout(resolve, 200));

  return {
    ok: true,
    post_title: '示例帖子标题'
  };
}
