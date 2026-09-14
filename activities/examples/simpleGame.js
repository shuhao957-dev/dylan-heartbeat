/**
 * 简化的游戏活动示例
 * 展示：多步骤工具调用 + 状态管理 + 限流保护
 */

// 游戏状态（持久化到文件或内存）
let gameState = {
  currentRound: 0,
  maxRoundsPerWakeup: 3,  // 每轮唤醒最多玩 3 局
  lastPlayTime: null
};

module.exports = {
  id: 'simpleGame',

  isFallback: false,

  buildPromptSection(ctx, letter) {
    const { aiName = 'AI' } = ctx;
    const remaining = gameState.maxRoundsPerWakeup - gameState.currentRound;

    return {
      option: `## 选项${letter}：玩游戏\n调用 play_game 工具玩一局简单游戏（猜数字）`,

      chooseHint: `- 无聊想消磨时间时选${letter}（本轮还能玩 ${remaining} 局）`,

      outputHint: `- 选${letter}：调用 play_game 工具开始游戏`,

      guide: `### ${letter} 游戏攻略\n\n` +
        `这是一个简单的猜数字游戏：\n` +
        `1. 系统会随机生成 1-100 的数字\n` +
        `2. ${aiName} 可以多次调用 guess_number 工具猜测\n` +
        `3. 系统返回"太大"/"太小"/"猜对了"\n` +
        `4. 每次唤醒最多玩 ${gameState.maxRoundsPerWakeup} 局，防止刷屏\n\n` +
        `**策略提示**：用二分法最快，平均 7 次猜中。`
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'play_game',
        description: '开始一局新游戏（猜数字）',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: '为什么想玩（可选，用于记录）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'guess_number',
        description: '猜一个数字（1-100）',
        parameters: {
          type: 'object',
          properties: {
            number: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: '猜测的数字'
            }
          },
          required: ['number']
        }
      }
    }
  ],

  async handleTool(toolName, args, ctx) {
    const { now, aiName = 'AI' } = ctx;

    // === 工具 1：开始游戏 ===
    if (toolName === 'play_game') {
      // 限流：本轮已玩够了
      if (gameState.currentRound >= gameState.maxRoundsPerWakeup) {
        return {
          ok: false,
          output: `本轮已经玩了 ${gameState.maxRoundsPerWakeup} 局，休息一下吧。下次唤醒可以继续玩。`
        };
      }

      // 初始化游戏
      const targetNumber = Math.floor(Math.random() * 100) + 1;
      gameState.currentGame = {
        target: targetNumber,
        guesses: [],
        startTime: now.toISOString()
      };
      gameState.currentRound++;

      return {
        ok: true,
        output: `游戏开始！我已经想好了一个 1-100 的数字，来猜猜看吧。` +
          `（这是第 ${gameState.currentRound}/${gameState.maxRoundsPerWakeup} 局）` +
          `\n\n请使用 guess_number 工具猜测。`,
        // 暂不写 recordText，等游戏结束后一起记录
      };
    }

    // === 工具 2：猜数字 ===
    if (toolName === 'guess_number') {
      // 检查是否有进行中的游戏
      if (!gameState.currentGame) {
        return {
          ok: false,
          output: '还没有开始游戏，请先调用 play_game 工具。'
        };
      }

      const game = gameState.currentGame;
      const guess = parseInt(args.number);
      const target = game.target;

      // 记录猜测
      game.guesses.push(guess);

      // 判断结果
      if (guess === target) {
        // 猜对了！
        const steps = game.guesses.length;
        const duration = Math.floor((new Date(now) - new Date(game.startTime)) / 1000);

        // 记录到 wake_session
        const recordText =
          `[游戏记录]（${now.toISOString()} ${aiName}自己去玩了会儿游戏）\n` +
          `（玩了${steps}步：${game.guesses.join(' → ')}）\n` +
          `猜数字游戏，目标是 ${target}，用了 ${steps} 次猜中，耗时 ${duration} 秒。` +
          (steps <= 7 ? ' 策略不错！' : ' 下次可以试试二分法。');

        // 清空当前游戏
        delete gameState.currentGame;

        return {
          ok: true,
          output: `🎉 恭喜猜对了！答案就是 ${target}。\n` +
            `你用了 ${steps} 次猜中，耗时 ${duration} 秒。` +
            (steps <= 7 ? '\n策略很棒！' : '\n下次可以试试二分法更快哦。') +
            `\n\n本轮还可以玩 ${gameState.maxRoundsPerWakeup - gameState.currentRound} 局。`,
          recordText
        };
      } else if (guess < target) {
        return {
          ok: true,
          output: `📉 ${guess} 太小了，往大了猜。（已猜 ${game.guesses.length} 次）`
        };
      } else {
        return {
          ok: true,
          output: `📈 ${guess} 太大了，往小了猜。（已猜 ${game.guesses.length} 次）`
        };
      }
    }

    return null;
  },

  // === 可选钩子 ===

  statusLine(ctx) {
    if (gameState.currentRound >= gameState.maxRoundsPerWakeup) {
      return `游戏：本轮已玩够（${gameState.currentRound}/${gameState.maxRoundsPerWakeup}）`;
    }
    return `游戏：本轮已玩 ${gameState.currentRound} 局，还能玩 ${gameState.maxRoundsPerWakeup - gameState.currentRound} 局`;
  },

  resetCycle() {
    // 每轮唤醒开始时重置计数器
    gameState.currentRound = 0;
    console.log('[simpleGame] 重置游戏计数器');
  }
};

// === 典型的工具调用序列 ===
/*
Round 1:
  AI → play_game()
  System → "游戏开始！我已经想好了一个 1-100 的数字..."

Round 2:
  AI → guess_number(50)
  System → "太大了"

Round 3:
  AI → guess_number(25)
  System → "太小了"

Round 4:
  AI → guess_number(37)
  System → "太大了"

Round 5:
  AI → guess_number(31)
  System → "🎉 恭喜猜对了！"
  → 写入 wake_session：[游戏记录]（...）（玩了4步：50 → 25 → 37 → 31）...
*/
