"use strict";

/* ============================================================
   Dylan Heartbeat · admin 前端
   这是真正的 .js 文件，不再是 server.js 里的模板字符串。
   双引号、反斜杠、模板字符串在这里都可以随便用。

   凭证说明：这里没有 AUTH_HEADER。浏览器在你输过一次 Basic
   密码后，会对同源请求自动带上 Authorization 头，所以每个
   fetch 只需要 credentials: "same-origin"。密码不再抄进 JS。
   ============================================================ */

var F = { credentials: "same-origin" };

function jsonPost(body) {
  return {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  };
}

async function api(path, opts) {
  var r = await fetch(path, opts || F);
  if (!r.ok) throw new Error(path + " → HTTP " + r.status);
  return r.json();
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function ago(ts) {
  var ms = Date.now() - new Date(ts).getTime();
  if (!isFinite(ms) || ms < 0) return "";
  var m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  var h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

function when(ts) {
  var d = new Date(ts);
  if (isNaN(d)) return "";
  var p = function (n) { return String(n).padStart(2, "0"); };
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fail(id, err) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = '<div class="ph">读取失败：' + esc(err.message) + "</div>";
}

/* ============================================================
   屏 1：状态与开关
   ============================================================ */

function paintStatus(el, dot, data) {
  if (!data.exists || data.status === "not_found") {
    el.textContent = "未注册";
    el.style.color = "#9a7a82";
    if (dot) dot.className = "dot";
    return;
  }
  if (data.status === "online") {
    var min = Math.floor((Date.now() - data.uptime) / 60000);
    el.textContent = "运行中" + (isFinite(min) && min >= 0 ? "（" + min + " 分钟）" : "");
    el.style.color = "#3f7a55";
    if (dot) dot.className = "dot on";
  } else {
    el.textContent = "已停止";
    el.style.color = "#a8515e";
    if (dot) dot.className = "dot off";
  }
}

/* v2 在跑时锁住 v1 的「开启」按钮。
   理由：v1/v2 互斥，同时跑会双份推送。互斥检查只在 v2 启动时做，
   所以「v2 已经在跑、再去开 v1」这条路原来是没人拦的。
   「关闭」永远可点 —— 停从来不危险。
   查询失败时也锁（宁可拦住，不要在状态未知时放行）。 */
function lockV1(v2Online) {
  var body = document.querySelector(".card-v1") ? document.querySelectorAll(".card-v1") : [];
  Array.prototype.forEach.call(body, function (card) {
    var on = card.querySelector(".btn-on");
    if (!on) return;
    on.disabled = !!v2Online;
    on.title = v2Online ? "v2 正在运行，先关闭 v2 才能开 v1" : "";
  });
  var w = document.getElementById("v1-warn");
  if (w) {
    w.textContent = v2Online
      ? "v2 正在运行，v1 的「开启」已锁住。要切回 v1 请先关闭上面的 v2。"
      : "v1 和 v2 互斥。v2 正在跑时开 v1 会变成两个进程同时推送。";
  }
}

async function loadV2() {
  try {
    var d = await api("/admin/combined-v2/status");
    paintStatus(document.getElementById("v2-status"), document.getElementById("v2-dot"), d);
    setText("wake-which", d.status === "online" ? "v2（运行中）" : "v2（已停止）");
    lockV1(d.status === "online");
  } catch (e) {
    setText("v2-status", "查询失败");
    setText("wake-which", "查询失败");
    lockV1(true);
  }
}

async function toggleV2(action) {
  if (action === "stop" && !confirm("关闭 v2 唤醒端？关闭后克咪不会再主动做事，你仍可正常聊天。")) return;
  try {
    await api("/admin/combined-v2/toggle", jsonPost({ action: action }));
  } catch (e) { alert("操作失败：" + e.message); }
  setTimeout(loadV2, 1500);
}

var V1 = [
  { key: "heartbeat-wakeup", el: "hb-status" },
  { key: "game-bot", el: "game-status" },
  { key: "combined", el: "cb1-status" }
];

async function loadV1() {
  for (var i = 0; i < V1.length; i++) {
    var it = V1[i];
    try {
      var d = await api("/admin/" + it.key + "/status");
      paintStatus(document.getElementById(it.el), null, d);
    } catch (e) { setText(it.el, "查询失败"); }
  }
}

async function toggleV1(key, action) {
  if (action === "start" && !confirm("v1 与 v2 互斥。如果 v2 正在跑，开启 v1 会变成两个进程同时推送。确定开启？")) return;
  if (action === "stop" && !confirm("确定关闭？")) return;
  try {
    await api("/admin/" + key + "/toggle", jsonPost({ action: action }));
  } catch (e) { alert("操作失败：" + e.message); }
  setTimeout(loadV1, 1500);
}

/* ---------- 活动勾选 ---------- */

var actsSaved = "";

function actsBoxes() {
  return Array.prototype.slice.call(document.querySelectorAll("#v2-acts input"));
}

function actsCurrent() {
  return actsBoxes().filter(function (b) { return b.checked; })
    .map(function (b) { return b.value; }).join(",");
}

function actsDirty() {
  var btn = document.getElementById("acts-apply");
  var changed = actsCurrent() !== actsSaved;
  btn.disabled = !changed;
  setText("acts-hint", changed ? "有未保存的改动" : "勾选后按保存，会重启 v2 生效");
}

async function loadActivities() {
  try {
    var d = await api("/admin/combined-v2/activities");
    var on = d.activities || [];
    var avail = d.available || [];

    var box = document.getElementById("v2-acts");
    if (!box) return;

    /* 动态渲染勾选框 */
    box.innerHTML = avail.map(function (a) {
      var checked = on.indexOf(a.id) >= 0;
      return '<label class="act"><input type="checkbox" value="' + a.id + '"' +
        (checked ? ' checked' : '') + '><span>' + esc(a.label) + '</span></label>';
    }).join("");

    /* 绑定 change 事件 */
    actsBoxes().forEach(function (b) { b.onchange = actsDirty; });

    actsSaved = actsCurrent();
    actsDirty();
  } catch (e) {
    setText("acts-hint", "读取失败：" + e.message);
  }
}

async function saveActivities() {
  var list = actsCurrent();
  if (!list) { alert("至少要勾一个活动，否则克咪什么都不会做。"); return; }
  if (!confirm("保存活动设置并重启 v2？\n\n新设置：" + list)) return;
  var btn = document.getElementById("acts-apply");
  btn.disabled = true;
  setText("acts-hint", "保存中…");
  try {
    var r = await api("/admin/combined-v2/activities", jsonPost({ activities: list }));
    if (!r.success) throw new Error(r.error || "未知错误");
    actsSaved = list;
    setText("acts-hint", "已保存，v2 正在重启");
    setTimeout(loadV2, 2500);
    setTimeout(actsDirty, 2600);
  } catch (e) {
    setText("acts-hint", "保存失败：" + e.message);
    btn.disabled = false;
  }
}

/* ---------- 配置表单 ---------- */

var CFG_FIELDS = [
  "target_url", "model_name", "custom_icon",
  "decision_engine",
  "jiwen_connection_rate", "jiwen_consider_contact", "jiwen_force_contact",
  "jiwen_pride_block", "jiwen_connection_accel", "jiwen_accel_delay",
  "day_wake_after", "night_wake_after", "day_check_interval", "night_check_interval",
  "wake_day_start_hour", "wake_day_end_hour",
  "weather_enabled", "weather_location_name", "weather_lat", "weather_lon", "weather_units"
];

var SECRET_FIELDS = ["target_key", "gateway_api_key", "bark_key"];

async function loadConfig() {
  try {
    var c = await api("/admin/config");
    CFG_FIELDS.forEach(function (k) {
      var el = document.getElementById("f_" + k);
      if (el && c[k] != null) el.value = c[k];
    });
    setText("gw-key-status", c.gateway_key_status || "未知");
    setText("gw-uptime", c.uptime_seconds != null ? "运行中（" + c.uptime_seconds + " 秒）" : "运行中");
    var s = c.wake_day_start_hour, e2 = c.wake_day_end_hour;
    var hint = document.getElementById("night-hint");
    if (hint && s != null && e2 != null) {
      hint.textContent = "当前：白天 " + s + "–" + e2 + " 点会唤醒，其余时段（" + e2 + " 点–次日 " + s + " 点）安静。";
    }
  } catch (e) {
    setText("gw-uptime", "查询失败");
  }
}

async function saveConfig(event) {
  event.preventDefault();
  var payload = {};
  CFG_FIELDS.forEach(function (k) {
    var el = document.getElementById("f_" + k);
    if (el) payload[k] = String(el.value).trim();
  });
  SECRET_FIELDS.forEach(function (k) {
    var el = document.getElementById("f_" + k);
    if (el) payload[k] = String(el.value).trim();
  });

  if (!payload.target_url || !payload.model_name) {
    alert("请填写 API 地址和模型名称");
    return;
  }

  try {
    var r = await api("/admin/save", jsonPost(payload));
    if (r.success) {
      SECRET_FIELDS.forEach(function (k) {
        var el = document.getElementById("f_" + k);
        if (el) el.value = "";
      });
      alert("配置已保存，现在可以点击重启按钮让新配置生效。");
    } else {
      alert("保存失败：" + (r.error || "未知错误"));
    }
  } catch (e) { alert("请求失败：" + e.message); }
}

async function restartServices() {
  if (!confirm("确定要重启 Gateway 和唤醒端吗？")) return;
  try {
    var r = await api("/admin/restart", jsonPost({}));
    if (r.success) {
      alert("重启成功！页面稍后自动刷新。");
      setTimeout(function () { location.reload(); }, 3000);
    } else {
      alert("重启失败：" + (r.error || "未知错误"));
    }
  } catch (e) { alert("请求失败：" + e.message); }
}

/* ---------- 预设 ---------- */

var presets = [];

function renderPresets() {
  var list = document.getElementById("presetList");
  if (!list) return;
  if (!presets.length) {
    list.innerHTML = '<div class="ph">还没有预设，保存当前配置即可创建。</div>';
    return;
  }
  list.innerHTML = presets.map(function (p, i) {
    return '<div class="preset-item">' +
      '<button class="preset-btn" data-apply="' + i + '">' + esc(p.name) +
      "<span>" + esc(p.model_name) + "</span></button>" +
      '<button class="preset-del" data-del="' + i + '">删除</button>' +
      "</div>";
  }).join("");

  list.querySelectorAll("[data-apply]").forEach(function (b) {
    b.onclick = function () { applyPreset(+b.dataset.apply); };
  });
  list.querySelectorAll("[data-del]").forEach(function (b) {
    b.onclick = function () { deletePreset(+b.dataset.del); };
  });
}

async function loadPresets() {
  try {
    var d = await api("/admin/presets");
    presets = d.presets || [];
  } catch (e) { presets = []; }
  renderPresets();
}

function applyPreset(i) {
  var p = presets[i];
  if (!p) return;
  document.getElementById("f_url").value = p.target_url || "";
  document.getElementById("f_model").value = p.model_name || "";
  if (p.target_key) document.getElementById("f_key").value = p.target_key;
}

async function savePreset() {
  var name = document.getElementById("presetName").value.trim();
  var target_url = document.getElementById("f_url").value.trim();
  var target_key = document.getElementById("f_key").value.trim();
  var model_name = document.getElementById("f_model").value.trim();
  if (!name) { alert("请填写预设名称"); return; }
  if (!target_url || !model_name) { alert("请先填写 API 地址和模型名称"); return; }

  try {
    var r = await api("/admin/presets/save", jsonPost({
      name: name, target_url: target_url, target_key: target_key, model_name: model_name
    }));
    if (!r.success) throw new Error(r.error || "未知错误");
    var at = presets.findIndex(function (p) { return p.name === name; });
    var entry = { name: name, target_url: target_url, target_key: target_key, model_name: model_name };
    if (at >= 0) presets[at] = entry; else presets.push(entry);
    renderPresets();
    document.getElementById("presetName").value = "";
    alert("预设已保存：" + name);
  } catch (e) { alert("保存失败：" + e.message); }
}

async function deletePreset(i) {
  var p = presets[i];
  if (!p || !confirm("删除预设「" + p.name + "」？")) return;
  try {
    await api("/admin/presets/delete", jsonPost({ name: p.name }));
    presets.splice(i, 1);
    renderPresets();
  } catch (e) { alert("删除失败：" + e.message); }
}

/* ============================================================
   屏 2：克咪的记录
   ============================================================ */

async function loadPush() {
  try {
    var d = await api("/admin/push-history");
    var feed = document.getElementById("push-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">暂无推送记录</div>';
      return;
    }
    feed.innerHTML = d.entries.slice(0, 30).map(function (e) {
      return '<div class="item"><div class="when">' + ago(e.timestamp) + '</div>' +
        '<div class="body">' + esc(e.content) + '</div></div>';
    }).join("");
  } catch (e) { fail("push-feed", e); }
}

async function loadGame() {
  try {
    var d = await api("/admin/game-history");
    var feed = document.getElementById("game-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">暂无游戏记录</div>';
      return;
    }

    /* 按天分组 */
    var byDay = {};
    d.entries.forEach(function (e) {
      var day = String(e.timestamp || "").slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(e);
    });

    var days = Object.keys(byDay).sort().reverse();
    var today = new Date().toISOString().slice(0, 10);

    var html = days.map(function (day, i) {
      var list = byDay[day];
      var label = (day === today ? "今天" : day.slice(5)) + "（" + list.length + " 条）";
      var inner = list.map(function (e) {
        var body = String(e.content || "").replace(/^\[游戏记录\][：:]\s*/, "")
          .replace(/^[（(].*?[）)]\s*/, "").trim();
        var steps = "";
        if (e.actions && e.actions.length) {
          var cmds = e.actions.map(function (a) { return a.command || ""; }).filter(Boolean);
          if (cmds.length) steps = '<div class="steps">' + cmds.join(" → ") + '</div>';
        }
        return '<div class="item"><div class="when">' + ago(e.timestamp) + '</div>' +
          '<div class="body">' + esc(body) + '</div>' + steps + '</div>';
      }).join("");

      return '<details class="diary-more"' + (i === 0 ? ' open' : '') + '><summary>' + label + '</summary>' + inner + '</details>';
    }).join("");

    feed.innerHTML = html;
  } catch (e) { fail("game-feed", e); }
}

async function loadForum() {
  try {
    var d = await api("/admin/forum-history");
    var feed = document.getElementById("forum-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">暂无论坛记录</div>';
      return;
    }

    /* 按天分组 */
    var byDay = {};
    d.entries.forEach(function (e) {
      var day = String(e.timestamp || "").slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(e);
    });

    var days = Object.keys(byDay).sort().reverse();
    var today = new Date().toISOString().slice(0, 10);

    var html = days.map(function (day, i) {
      var list = byDay[day];
      var label = (day === today ? "今天" : day.slice(5)) + "（" + list.length + " 条）";
      var inner = list.map(function (e) {
        var body = String(e.content || "").replace(/^\[论坛记录\][：:]\s*/, "")
          .replace(/^[（(].*?[）)]\s*/, "").trim();
        var steps = "";
        if (e.actions && e.actions.length) {
          var cmds = e.actions.map(function (a) { return a.command || ""; }).filter(Boolean);
          if (cmds.length) steps = '<div class="steps">' + cmds.slice(0, 8).join(" → ") + '</div>';
        }
        return '<div class="item"><div class="when">' + ago(e.timestamp) + '</div>' +
          '<div class="body">' + esc(body) + '</div>' + steps + '</div>';
      }).join("");

      return '<details class="diary-more"' + (i === 0 ? ' open' : '') + '><summary>' + label + '</summary>' + inner + '</details>';
    }).join("");

    feed.innerHTML = html;
  } catch (e) { fail("forum-feed", e); }
}

async function loadDiary() {
  try {
    var d = await api("/admin/diary");
    var feed = document.getElementById("diary-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">还没有日记</div>';
      return;
    }

    /* 按月分组（2026-08 → [entry, entry, ...]） */
    var byMonth = {};
    d.entries.forEach(function (e) {
      var m = String(e.name).slice(0, 7);
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(e);
    });

    var months = Object.keys(byMonth).sort().reverse();
    var latest = months[0];
    var html = "";

    months.forEach(function (m, i) {
      var list = byMonth[m];
      var isLatest = (m === latest);
      var inner = list.map(function (e) {
        var name = String(e.name).replace(/\.md$/i, "");
        var up = e.updated_at ? " · " + ago(e.updated_at) : "";
        return '<details class="diary-entry"' + (isLatest && i === 0 ? ' open' : '') + '><summary><span>' + esc(name) + '</span><em>' + up +
          '</em></summary><pre>' + esc(e.content || "") + '</pre></details>';
      }).join("");

      if (i === 0) {
        html += inner;
      } else {
        html += '<details class="diary-more"><summary>' + m + '（' + list.length + ' 篇）</summary>' + inner + '</details>';
      }
    });

    feed.innerHTML = html;
  } catch (e) { fail("diary-feed", e); }
}

async function loadWeb() {
  try {
    var d = await api("/admin/web-history");
    var feed = document.getElementById("web-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">暂无上网冲浪记录</div>';
      return;
    }

    /* 按天分组 */
    var byDay = {};
    d.entries.forEach(function (e) {
      var day = String(e.timestamp || "").slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(e);
    });

    var days = Object.keys(byDay).sort().reverse();
    var today = new Date().toISOString().slice(0, 10);

    var html = days.map(function (day, i) {
      var list = byDay[day];
      var label = (day === today ? "今天" : day.slice(5)) + "（" + list.length + " 条）";
      var inner = list.map(function (e) {
        var body = String(e.content || "").replace(/^[（(].*?克咪.*?[）)]s*/, "").trim();
        var sources = "";
        if (e.actions && e.actions.length) {
          var browsed = e.actions.map(function (a) { return a.args && a.args.source ? a.args.source : ""; }).filter(Boolean);
          if (browsed.length) sources = '<div class="steps">浏览: ' + browsed.join(", ") + '</div>';
        }
        return '<div class="item"><div class="when">' + ago(e.timestamp) + '</div>' +
          '<div class="body">' + esc(body) + '</div>' + sources + '</div>';
      }).join("");

      return '<details class="diary-more"' + (i === 0 ? ' open' : '') + '><summary>' + label + '</summary>' + inner + '</details>';
    }).join("");

    feed.innerHTML = html;
  } catch (e) { fail("web-feed", e); }
}

async function loadKemi() {
  await Promise.all([loadPush(), loadGame(), loadForum(), loadWeb(), loadDiary()]);
  setText("kemi-summary", "推送、游戏、论坛记录按天折叠；日记按月折叠，无上限");
}

/* ============================================================
   屏 3：审核
   ============================================================ */

async function loadGate() {
  try {
    var d = await api("/admin/gate-log");
    setText("gate-summary", "共 " + (d.total || 0) + " 条，拦截 " + (d.blocked || 0) + " 条");
    var feed = document.getElementById("gate-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">无记录</div>';
      return;
    }
    feed.innerHTML = d.entries.map(function (e) {
      var v = String(e.verdict || "");
      var pass = /pass|allow|ok/i.test(v);
      var badge = pass
        ? '<span class="verdict pass">通过</span>'
        : '<span class="verdict block">拦截</span>';
      var target = e.target ? " · " + esc(String(e.target).slice(0, 20)) : "";
      return '<div class="item"><div class="when">' + when(e.at) + badge + target +
        '</div><div class="body">' + esc((e.draft || "").slice(0, 200)) + '</div></div>';
    }).join("");
  } catch (e) { fail("gate-feed", e); }
}

async function loadFailures() {
  try {
    var d = await api("/admin/upstream-failures");
    var feed = document.getElementById("fail-feed");
    if (!feed) return;
    if (!d.entries || !d.entries.length) {
      feed.innerHTML = '<div class="ph">无故障记录（说明网关转发的上游请求都成功了）</div>';
      return;
    }
    feed.innerHTML = d.entries.map(function (e) {
      var sum = e.summary ? esc(String(e.summary).slice(0, 80)) : "";
      return '<div class="item"><div class="when">' + when(e.at) + " · HTTP " + e.status +
        '</div>' + (sum ? '<div class="body" style="font-size:11px;color:#8b6b72;">' + sum + '</div>' : '') +
        '<div class="steps">' + esc((e.body || "").slice(0, 300)) + '</div></div>';
    }).join("");
  } catch (e) { fail("fail-feed", e); }
}

/* ============================================================
   初始化
   ============================================================ */

(function () {
  loadV2();
  loadV1();
  loadActivities();
  loadConfig();
  loadPresets();
  loadKemi();
  loadGate();
  loadFailures();
  loadInjectSwitches();
  loadBrowserApprovals();
})();



// ===== 注入开关 =====
async function loadInjectSwitches() {
  try {
    const data = await api("/admin/injection-switches");
    document.getElementById("sw-wake").checked = data.wake;
    document.getElementById("sw-voice").checked = data.voice;
    document.getElementById("sw-wechat").checked = data.wechat;
  } catch (e) {
    console.error("加载注入开关失败:", e);
  }
}

async function toggleInject(key, enabled) {
  try {
    const payload = {};
    payload[key] = enabled;
    await api("/admin/injection-switches", jsonPost(payload));
    console.log(`注入开关[${key}] -> ${enabled}`);
  } catch (e) {
    console.error("切换注入开关失败:", e);
    alert("切换失败: " + e.message);
  }
}

// ===== 浏览器审批 =====
const BROWSER_AGENT_URL = 'http://100.74.44.85:9223';

async function loadBrowserApprovals() {
  try {
    const res = await fetch(`${BROWSER_AGENT_URL}/approval/pending`);
    const data = await res.json();

    const summary = document.getElementById('approval-summary');
    const feed = document.getElementById('approval-feed');

    if (data.count === 0) {
      summary.textContent = '暂无待审批操作';
      feed.innerHTML = '<div class="ph">暂无待审批</div>';
      return;
    }

    summary.textContent = `${data.count} 个操作等待审批`;

    feed.innerHTML = data.requests.map(req => {
      const riskColor = req.risk_level === 'high' ? '#ff4444' : '#ff9800';
      const riskLabel = req.risk_level === 'high' ? '高风险' : '中风险';
      const time = new Date(req.timestamp).toLocaleString('zh-CN');

      return `
        <div class="approval-item" data-id="${req.id}">
          <div class="approval-header">
            <span class="approval-risk" style="color: ${riskColor}">【${riskLabel}】</span>
            <span class="approval-action">${req.action}</span>
            <span class="approval-time">${time}</span>
          </div>
          <div class="approval-details">
            <div><strong>URL:</strong> ${req.details.url || 'N/A'}</div>
            ${req.details.params ? `<div><strong>参数:</strong> ${JSON.stringify(req.details.params)}</div>` : ''}
          </div>
          <div class="approval-actions">
            <button class="btn-approve" onclick="approveAction('${req.id}')">✓ 批准</button>
            <button class="btn-reject" onclick="rejectAction('${req.id}')">✗ 拒绝</button>
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    console.error('加载审批失败:', e);
    document.getElementById('approval-feed').innerHTML = '<div class="ph">加载失败</div>';
  }
}

async function approveAction(id) {
  if (!confirm('确认批准此操作？')) return;

  try {
    const res = await fetch(`${BROWSER_AGENT_URL}/approval/approve/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) throw new Error('批准失败');

    alert('已批准');
    loadBrowserApprovals();
  } catch (e) {
    alert('操作失败: ' + e.message);
  }
}

async function rejectAction(id) {
  const reason = prompt('拒绝原因（可选）:');
  if (reason === null) return;

  try {
    const res = await fetch(`${BROWSER_AGENT_URL}/approval/reject/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });

    if (!res.ok) throw new Error('拒绝失败');

    alert('已拒绝');
    loadBrowserApprovals();
  } catch (e) {
    alert('操作失败: ' + e.message);
  }
}

// 每 10 秒刷新一次待审批列表
setInterval(() => {
  const browserTab = document.getElementById('tab-browser');
  if (browserTab && browserTab.checked) {
    loadBrowserApprovals();
  }
}, 10000);
