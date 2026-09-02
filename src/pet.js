/* AstrBot 桌宠 - 渲染层：Live2D 展示 + 交互 + 随机行为 + 与插件通信（支持远程服务器） */
(() => {
  "use strict";

  // ---------- 设置 ----------
  const DEFAULTS = {
    server: "127.0.0.1:9898", // host:port 或完整 URL（http(s):// / ws(s)://），可填远程服务器
    token: "",
    modelPath: "../models/Haru/Haru.model3.json", // 任意 .model3.json（本地路径或 http URL）
    petName: "桌宠",
  };
  // 兼容旧版 localStorage 里的 host/port 字段
  const saved = JSON.parse(localStorage.getItem("pet-settings") || "{}");
  if (saved.host && !saved.server) saved.server = `${saved.host}:${saved.port || 9898}`;
  const settings = Object.assign({}, DEFAULTS, saved);
  delete settings.host; delete settings.port;
  const saveSettings = () => localStorage.setItem("pet-settings", JSON.stringify(settings));

  // ---------- 行为配置（插件自动同步；本地缓存作离线回退） ----------
  const BEHAVIOR_DEFAULTS = {
    enable_chatter: true,
    chatter_lines: ["好无聊呀……", "你在忙什么呢？", "今天天气不错呢。", "想吃点心了……", "嘿嘿，我在这儿哦。", "别一直盯着我看啦。", "要不要陪我玩一会？"],
    chatter_interval_sec: 90,
    sleepy_lines: ["好困……", "呼啊……想睡觉了。", "眼睛睁不开了……"],
    walk_speed: 1.5,
    sleepy_threshold: 20,
    enable_roam: true,
  };
  const behavior = Object.assign({}, BEHAVIOR_DEFAULTS, JSON.parse(localStorage.getItem("pet-behavior") || "{}"));
  function applyBehavior(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    for (const k of Object.keys(BEHAVIOR_DEFAULTS)) {
      if (cfg[k] !== undefined && cfg[k] !== null) behavior[k] = cfg[k];
    }
    behavior.chatter_interval_sec = Math.max(5, parseInt(behavior.chatter_interval_sec) || 90);
    behavior.walk_speed = Math.max(0.2, Math.min(10, parseFloat(behavior.walk_speed) || 1.5));
    behavior.sleepy_threshold = Math.max(0, Math.min(100, parseInt(behavior.sleepy_threshold) || 0));
    if (!Array.isArray(behavior.chatter_lines) || !behavior.chatter_lines.length) behavior.chatter_lines = BEHAVIOR_DEFAULTS.chatter_lines;
    if (!Array.isArray(behavior.sleepy_lines) || !behavior.sleepy_lines.length) behavior.sleepy_lines = BEHAVIOR_DEFAULTS.sleepy_lines;
    localStorage.setItem("pet-behavior", JSON.stringify(behavior));
  }

  /** 把 server 配置解析为 http(s) 基地址 */
  function httpBase() {
    let s = settings.server.trim().replace(/\/+$/, "");
    if (/^wss:\/\//i.test(s)) return "https://" + s.slice(6);
    if (/^ws:\/\//i.test(s)) return "http://" + s.slice(5);
    if (/^https?:\/\//i.test(s)) return s;
    return "http://" + s;
  }
  /** 对应的 ws(s) 基地址 */
  function wsBase() {
    const h = httpBase();
    return h.replace(/^http/i, "ws");
  }

  const bubble = document.getElementById("bubble");
  const chatPanel = document.getElementById("chat-panel");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const statusPanel = document.getElementById("status-panel");
  const connDot = document.getElementById("conn-dot");
  const settingsPanel = document.getElementById("settings-panel");

  let bubbleTimer = null;
  function speak(text, ms = 6000) {
    bubble.textContent = text;
    bubble.style.display = "block";
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => (bubble.style.display = "none"), ms);
  }

  // ---------- PIXI / Live2D ----------
  const app = new PIXI.Application({ backgroundAlpha: 0, autoStart: true, resizeTo: window });
  document.getElementById("canvas-wrap").appendChild(app.view);

  let model = null;
  let baseScaleX = 1;

  async function loadModel() {
    try {
      model = await PIXI.live2d.Live2DModel.from(settings.modelPath, { autoInteract: false });
    } catch (e) {
      console.error("模型加载失败", e);
      speak("模型加载失败啦……在设置里检查 model3.json 路径吧");
      return;
    }
    const scale = Math.min((window.innerWidth * 0.9) / model.width, (window.innerHeight * 0.75) / model.height);
    model.scale.set(scale);
    baseScaleX = scale;
    model.anchor.set(0.5, 1);
    model.x = window.innerWidth / 2;
    model.y = window.innerHeight - 6;
    model.eventMode = "static";
    app.stage.addChild(model);

    model.on("hit", (areas) => {
      playRandomMotion(/tap/i);
      speak(areas.length ? `碰到${areas[0]}啦！` : pick(["呀！", "干嘛啦！", "嘿嘿，好痒～"]));
      fetchAction("poke");
      idleSec = 0;
    });
  }

  /** 播放随机动作；groupFilter 可传正则过滤动作组 */
  function playRandomMotion(groupFilter) {
    if (!model) return;
    try {
      const motions = model.internalModel.settings.motions || {};
      let groups = Object.keys(motions).filter((g) => motions[g] && motions[g].length);
      if (!groups.length) return;
      let pool = groupFilter ? groups.filter((g) => groupFilter.test(g)) : groups;
      if (!pool.length) pool = groups;
      const g = pool[Math.floor(Math.random() * pool.length)];
      model.motion(g, Math.floor(Math.random() * motions[g].length));
    } catch (_) {}
  }

  /** 播放随机表情 */
  function playRandomExpression() {
    if (!model) return;
    try {
      const exps = model.internalModel.settings.expressions || [];
      if (exps.length) model.expression(Math.floor(Math.random() * exps.length));
    } catch (_) {}
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- 拖拽移动 ----------
  let dragging = false, lastX = 0, lastY = 0;
  window.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#chat-panel,#status-panel,#conn-dot,#settings-panel")) return;
    dragging = true; lastX = e.screenX; lastY = e.screenY;
    idleSec = 0; ai.mode = "idle";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX, dy = e.screenY - lastY;
    if (dx || dy) {
      lastX = e.screenX; lastY = e.screenY;
      window.petAPI.moveBy(dx, dy);
      cachedX += dx;
    }
  });
  window.addEventListener("pointerup", () => (dragging = false));

  window.addEventListener("dblclick", (e) => {
    if (e.target.closest("#conn-dot,#settings-panel")) return;
    toggleChat(true);
  });
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    statusPanel.style.display = statusPanel.style.display === "block" ? "none" : "block";
  });

  function toggleChat(open) {
    chatPanel.style.display = open ? "flex" : "none";
    if (open) chatInput.focus();
  }

  // ---------- 状态面板 ----------
  let petState = null;
  function renderState(s) {
    if (!s) return;
    petState = s;
    const bar = (label, v) =>
      `<div class="bar"><label>${label}</label><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, v))}%"></div></div></div>`;
    statusPanel.innerHTML =
      `<b>${settings.petName} Lv.${s.level}</b>` +
      bar("心情", s.mood) + bar("饱食", s.satiety) + bar("清洁", s.cleanliness) + bar("精力", s.energy);
  }

  // ---------- 插件通信 ----------
  let ws = null, wsRetry = 0;
  function connectWS() {
    const url = `${wsBase()}/ws${settings.token ? "?token=" + encodeURIComponent(settings.token) : ""}`;
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => { wsRetry = 0; connDot.className = "ok"; connDot.title = `已连接 ${settings.server}`; };
    ws.onclose = () => { connDot.className = "bad"; connDot.title = "连接断开，重连中…"; scheduleReconnect(); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "hello") {
        if (msg.pet_name) settings.petName = msg.pet_name;
        renderState(msg.state);
        applyBehavior(msg.behavior);
      } else if (msg.type === "config") {
        applyBehavior(msg.data);
      } else if (msg.type === "state") {
        renderState(msg.data);
      } else if (msg.type === "speak") {
        speak(msg.text);
        playRandomExpression();
      }
    };
  }
  function scheduleReconnect() {
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connectWS, 1000 * wsRetry);
  }

  async function api(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (settings.token) headers["X-Pet-Token"] = settings.token;
    const resp = await fetch(httpBase() + path, { method: "POST", headers, body: JSON.stringify(body || {}) });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    speak("你：" + text);
    try {
      const r = await api("/api/chat", { text });
      renderState(r.state);
      if (!ws || ws.readyState !== 1) speak(r.reply); // 有 WS 时由 speak 推送显示
    } catch (e) {
      speak("连不上 AstrBot 插件……" + e.message);
    }
  }
  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
    if (e.key === "Escape") toggleChat(false);
  });

  async function fetchAction(action) {
    try { const r = await api("/api/action", { action }); renderState(r.state); } catch (_) {}
  }

  // ---------- 设置面板 ----------
  const splitLines = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);

  function openSettings() {
    document.getElementById("set-server").value = settings.server;
    document.getElementById("set-token").value = settings.token;
    document.getElementById("set-model").value = settings.modelPath;
    document.getElementById("set-roam").checked = !!behavior.enable_roam;
    document.getElementById("set-walk-speed").value = behavior.walk_speed;
    document.getElementById("set-sleepy-threshold").value = behavior.sleepy_threshold;
    document.getElementById("set-chatter").checked = !!behavior.enable_chatter;
    document.getElementById("set-chatter-interval").value = behavior.chatter_interval_sec;
    document.getElementById("set-chatter-lines").value = behavior.chatter_lines.join("\n");
    document.getElementById("set-sleepy-lines").value = behavior.sleepy_lines.join("\n");
    settingsPanel.style.display = "block";
  }
  document.getElementById("settings-cancel").addEventListener("click", () => (settingsPanel.style.display = "none"));
  document.getElementById("settings-save").addEventListener("click", async () => {
    const newServer = document.getElementById("set-server").value.trim();
    const newModel = document.getElementById("set-model").value.trim();
    const serverChanged = newServer && newServer !== settings.server;
    const tokenChanged = document.getElementById("set-token").value !== settings.token;
    settings.server = newServer || settings.server;
    settings.token = document.getElementById("set-token").value;

    // 行为配置：先本地生效并缓存，再回写插件（插件会广播给所有客户端）
    applyBehavior({
      enable_roam: document.getElementById("set-roam").checked,
      walk_speed: parseFloat(document.getElementById("set-walk-speed").value),
      sleepy_threshold: parseInt(document.getElementById("set-sleepy-threshold").value),
      enable_chatter: document.getElementById("set-chatter").checked,
      chatter_interval_sec: parseInt(document.getElementById("set-chatter-interval").value),
      chatter_lines: splitLines(document.getElementById("set-chatter-lines").value),
      sleepy_lines: splitLines(document.getElementById("set-sleepy-lines").value),
    });
    try {
      const cfg = await api("/api/config", {
        enable_roam: behavior.enable_roam,
        walk_speed: behavior.walk_speed,
        sleepy_threshold: behavior.sleepy_threshold,
        enable_chatter: behavior.enable_chatter,
        chatter_interval_sec: behavior.chatter_interval_sec,
        chatter_lines: behavior.chatter_lines,
        sleepy_lines: behavior.sleepy_lines,
      });
      applyBehavior(cfg); // 以插件校验后的结果为准
    } catch (_) {
      speak("插件未连接，行为配置仅保存在本地。");
    }

    if (newModel && newModel !== settings.modelPath) {
      settings.modelPath = newModel;
      if (model) { app.stage.removeChild(model); model.destroy(); model = null; }
      loadModel();
    }
    saveSettings();
    settingsPanel.style.display = "none";
    if (serverChanged || tokenChanged) { if (ws) ws.close(); else connectWS(); }
  });

  // ---------- 托盘命令 ----------
  window.petAPI.onOpenChat(() => toggleChat(true));
  window.petAPI.onAction((action) => fetchAction(action));
  window.petAPI.onOpenSettings(openSettings);
  connDot.addEventListener("dblclick", openSettings);

  // ---------- 随机行为 AI ----------
  // 状态机：idle（站着，随机小动作/表情/自言自语）→ walk（随机方向走动，遇边缘转身）
  //        → sleepy（精力低时犯困）→ 循环
  const ai = { mode: "idle", dir: 1, until: 0 };
  let idleSec = 0;
  let cachedX = 0, screenW = 1920;
  const WIN_W = 320;

  let lastChatterAt = 0;

  function setFacing(dir) {
    if (!model) return;
    ai.dir = dir;
    model.scale.x = baseScaleX * (dir < 0 ? -1 : 1);
  }

  async function initScreenInfo() {
    try {
      const [bounds, area] = await Promise.all([window.petAPI.getBounds(), window.petAPI.getWorkArea()]);
      cachedX = bounds.x; screenW = area.width;
    } catch (_) {}
  }

  // 每秒决策一次
  setInterval(() => {
    if (!model || dragging) return;
    idleSec++;

    const energy = petState ? petState.energy : 100;
    const now = Date.now();

    switch (ai.mode) {
      case "idle":
        // 随机小动作 / 表情
        if (Math.random() < 0.25) playRandomMotion();
        else if (Math.random() < 0.15) playRandomExpression();

        // 精力低 → 犯困
        if (energy < behavior.sleepy_threshold) {
          ai.mode = "sleepy";
          ai.until = now + 15000 + Math.random() * 15000;
          speak(pick(behavior.sleepy_lines));
          playRandomMotion(/sleep|sit|idle/i);
          break;
        }
        // 自言自语（间隔可配）
        if (behavior.enable_chatter && now - lastChatterAt > behavior.chatter_interval_sec * 1000 && Math.random() < 0.1) {
          speak(pick(behavior.chatter_lines));
          lastChatterAt = now;
          idleSec = 0;
          break;
        }
        // 空闲一段时间后开始随机走动
        if (behavior.enable_roam && idleSec > 15 && Math.random() < 0.2) {
          ai.mode = "walk";
          ai.until = now + 3000 + Math.random() * 6000;
          setFacing(Math.random() < 0.5 ? -1 : 1);
          playRandomMotion(/walk|move|run/i);
        }
        break;

      case "walk":
        if (now > ai.until) {
          ai.mode = "idle";
          idleSec = 0;
          playRandomMotion(/idle/i);
        }
        break;

      case "sleepy":
        if (now > ai.until && energy >= behavior.sleepy_threshold) {
          ai.mode = "idle";
          idleSec = 0;
        } else if (Math.random() < 0.1) {
          speak(pick(behavior.sleepy_lines), 3000);
        }
        break;
    }
  }, 1000);

  // 每帧执行走动（含屏幕边缘检测与转身）
  app.ticker.add(() => {
    if (ai.mode !== "walk" || !model || dragging) return;
    const dx = ai.dir * behavior.walk_speed;
    cachedX += dx;
    // 到达屏幕边缘：转身，偶尔直接停下
    if (cachedX <= 0) {
      cachedX = 0; setFacing(1);
    } else if (cachedX >= screenW - WIN_W) {
      cachedX = screenW - WIN_W; setFacing(-1);
    } else if (Math.random() < 0.003) {
      setFacing(-ai.dir); // 随机转身
    }
    window.petAPI.moveBy(dx, 0);
  });

  // ---------- 启动 ----------
  initScreenInfo().then(() => {
    loadModel();
    connectWS();
  });
})();
