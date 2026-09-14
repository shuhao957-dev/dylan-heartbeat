# Dylan Heartbeat Admin Panel

精美的 Web 管理面板，用于监控和控制 AI 伴侣的后台活动。

## 🎨 特性

### 视觉设计
- ✨ **毛玻璃拟态风格**：柔和的粉色调配色，半透明磨砂效果
- 🎯 **四屏切换**：纯 CSS 实现的标签页切换（无需 JavaScript）
- 📱 **响应式设计**：适配移动端和桌面端
- 🌸 **优雅动画**：流畅的过渡和悬停效果

### 功能模块

#### 1️⃣ 开关控制屏
- **v2 唤醒端控制**：启动/停止/查看状态
- **活动勾选**：动态勾选可用活动（contactUser/game/forum/x/nowhere/web）
- **注入开关**：控制哪些摘要注入到对话中（轮询/语音/微信）
- **配置管理**：
  - 预设方案（快速切换 API / 模型）
  - API URL / API Key
  - 模型名称
  - 决策引擎（LLM / 积温 Jiwen）
  - 唤醒参数（白天/夜间阈值）
  - 天气注入
- **一键重启**：重启网关 + 唤醒端

#### 2️⃣ 克咪记录屏
- **推送记录**：AI 发送的推送通知历史
- **游戏记录**：游戏活动详情和步骤
- **论坛记录**：论坛互动详情
- **上网冲浪**：浏览活动记录
- **日记**：AI 写的日记（按日期折叠）

#### 3️⃣ 审核屏
- **论坛闸门**：发言审核记录
- **上游故障**：LLM API 500 错误记录

#### 4️⃣ 浏览器屏（如果启用了浏览器代理）
- **待审批操作**：AI 请求执行的浏览器操作（需人工批准）
- **已处理记录**：已批准/拒绝的操作历史

## 📂 文件结构

```
admin/
├── index.html       # 主 HTML 文件（静态）
├── style.css        # 样式表（毛玻璃拟态风格）
├── app.js           # 前端逻辑（纯 JavaScript，无框架）
└── README.md        # 本文档
```

## 🚀 使用方法

### 作为静态文件服务

在你的网关服务器中添加静态文件路由：

```javascript
const express = require('express');
const path = require('path');

const app = express();

// 静态文件：admin 面板
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// API 端点（需要实现）
app.get('/admin/combined-v2/status', async (req, res) => {
  // 返回 v2 状态
  res.json({ status: 'online', uptime: Date.now() });
});

app.post('/admin/combined-v2/toggle', async (req, res) => {
  const { action } = req.body; // 'start' or 'stop'
  // 启动/停止 v2
  res.json({ ok: true });
});

// ... 更多 API 端点

app.listen(3000);
```

访问 `http://localhost:3000/admin/` 即可打开面板。

### 需要实现的 API 端点

面板依赖以下 API 端点（在 `app.js` 中调用）：

#### 状态查询
```
GET /admin/combined-v2/status
GET /admin/combined-v2/activities
GET /admin/heartbeat-wakeup/status
GET /admin/game-bot/status
GET /admin/combined/status
```

#### 控制操作
```
POST /admin/combined-v2/toggle
  body: { action: 'start' | 'stop' }

POST /admin/combined-v2/activities
  body: { activities: ['contactUser', 'game', ...] }

POST /admin/heartbeat-wakeup/toggle
POST /admin/game-bot/toggle
POST /admin/combined/toggle
```

#### 数据读取
```
GET /admin/timeline           # 时间线数据
GET /admin/push-records      # 推送记录
GET /admin/game-records      # 游戏记录
GET /admin/forum-records     # 论坛记录
GET /admin/diary-list        # 日记列表
```

#### 配置管理
```
GET  /admin/config            # 读取配置
POST /admin/config            # 保存配置
GET  /admin/presets           # 读取预设方案
POST /admin/presets           # 保存预设
DELETE /admin/presets/:name   # 删除预设
```

#### 注入开关
```
POST /admin/injection-switches
  body: { wake: true, voice: false, wechat: true }
```

#### 浏览器审批（可选）
```
GET  /admin/browser/approvals       # 待审批列表
POST /admin/browser/approve/:id     # 批准操作
POST /admin/browser/reject/:id      # 拒绝操作
GET  /admin/browser/history         # 已处理记录
```

## 🎨 自定义样式

### 修改配色

在 `style.css` 中修改 CSS 变量：

```css
body {
  /* 主色调：柔和粉色 */
  background: linear-gradient(135deg, #f8f0f3 0%, #f5e6eb 100%);
}

h2 {
  /* 标题颜色 */
  color: #8a4a58;
}

button.save {
  /* 按钮颜色 */
  background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
}
```

### 修改字体

默认使用 Google Fonts 的 Noto Serif SC（思源宋体），可在 `index.html` 中修改：

```html
<link href="https://fonts.googleapis.com/css2?family=YOUR_FONT&display=swap" rel="stylesheet">
```

## 🔒 安全建议

1. **添加身份验证**：面板应该加 Basic Auth 或其他认证机制
2. **HTTPS**：生产环境必须使用 HTTPS
3. **CORS**：限制跨域访问
4. **Rate Limiting**：防止 API 滥用

示例 Basic Auth（Express）：

```javascript
const basicAuth = require('express-basic-auth');

app.use('/admin', basicAuth({
  users: { 'admin': 'your-secure-password' },
  challenge: true,
  realm: 'Dylan Heartbeat Admin'
}));
```

## 📱 移动端适配

面板已针对移动端优化：
- 响应式布局（max-width: 480px）
- 触摸友好的按钮尺寸
- 流畅的滚动体验

## 🎯 技术亮点

1. **纯 CSS 标签页切换**：使用 `:checked` 伪类和相邻选择器
2. **毛玻璃效果**：`backdrop-filter: blur()` 实现半透明磨砂
3. **无框架**：纯原生 JavaScript，无依赖
4. **轻量级**：总大小 < 70KB
5. **优雅降级**：旧浏览器会回退到纯色背景

## 🐛 常见问题

### Q: 面板显示「查询失败」

**A**: 检查 API 端点是否正确实现，查看浏览器控制台的网络请求。

### Q: 样式显示异常

**A**: 确保 `style.css` 和 `app.js` 的路径正确，查看浏览器控制台的 404 错误。

### Q: 按钮点击无响应

**A**: 打开浏览器控制台查看 JavaScript 错误，确认 API 端点返回正确的 JSON 格式。

### Q: 毛玻璃效果不显示

**A**: `backdrop-filter` 需要较新的浏览器支持，在旧浏览器中会自动降级为纯色背景。

---

## 🙏 致谢

本管理面板是 Dylan Heartbeat 项目的精华之一，展示了如何用纯 Web 技术打造优雅的 AI 控制台。

感谢原作者 [@callie0313](https://github.com/callie0313) 的精美设计！
