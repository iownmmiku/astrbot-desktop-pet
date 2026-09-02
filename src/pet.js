/* AstrBot 桌宠 - 渲染层：Live2D 展示 + 交互 + 随机行为 + 与插件通信（支持远程服务器） */
(async () => {
  "use strict";

  // ---------- 设置（主进程 userData/settings.json 统一持久化） ----------
  const DEFAULTS = {
    server: "127.0.0.1:9898", // host:port 或完整 URL（http(s):// / ws(s)://），可填远程服务器
    token: "",
    modelPath: "", // 留空则使用 data/models/Haru 默认模型
    scale: 1.0,
    alwaysOnTop: true,
    randomMotion: true, // 随机播放模型自带动作
    motionIntervalSec: 8, // 随机动作最小间隔（秒）
    ttsEnabled: false,  // 文字转语音
    ttsVoice: "",
    ttsRate: 1.0,
    ttsVolume: 1.0,
    petName: "桌宠",
  };
  const settings = Object.assign({}, DEFAULTS, await window.petAPI.getSettings());
  if (!settings.modelPath) {
    settings.modelPath = await window.petAPI.getDefaultModel();
  }

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
  let savedBehavior = {};
  try { savedBehavior = JSON.parse(localStorage.getItem("pet-behavior") || "{}"); } catch (_) { savedBehavior = {}; }
  const behavior = Object.assign({}, BEHAVIOR_DEFAULTS, savedBehavior);
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
    let s = String(settings.server || "127.0.0.1:9898").trim().replace(/\/+$/, "");
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

  let bubbleTimer = null;
  function speak(text, ms = 6000, noTts = false) {
    bubble.textContent = text;
    bubble.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("show"), ms);
    if (!noTts) tts(text);
  }

  // ---------- 文字转语音（Web Speech API） ----------
  function tts(text) {
    try {
      if (!settings.ttsEnabled || !window.speechSynthesis || !text) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 200));
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.name === settings.ttsVoice);
      if (v) u.voice = v;
      const rate = parseFloat(settings.ttsRate);
      const vol = parseFloat(settings.ttsVolume);
      u.rate = isNaN(rate) ? 1 : Math.max(0.5, Math.min(2, rate));
      u.volume = isNaN(vol) ? 1 : Math.max(0, Math.min(1, vol));
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  // ---------- PIXI / Live2D ----------
  const app = new PIXI.Application({ backgroundAlpha: 0, autoStart: true, resizeTo: window });
  document.getElementById("canvas-wrap").appendChild(app.view);

  let model = null;
  let baseScaleX = 1;
  let pointerInsideModel = false;

  // 透明区域穿透：只有鼠标位于 Live2D 模型实际显示矩形内才接收点击。
  window.addEventListener("mousemove", (e) => {
    if (!model || dragging) return;
    try {
      const b = model.getBounds();
      const inside = e.clientX >= b.x && e.clientX <= b.x + b.width &&
        e.clientY >= b.y && e.clientY <= b.y + b.height;
      const uiOpen = menuOpen || chatPanel.style.display === "flex" ||
        sayPanel.style.display === "flex" || statusPanel.style.display === "block";
      if (inside !== pointerInsideModel || uiOpen) {
        pointerInsideModel = inside;
        window.petAPI.setMousePassthrough(!(inside || uiOpen));
      }
    } catch (_) {}
  });
  let fitScale = 1; // 窗口适配缩放（不含用户缩放倍率）
  let modelLoadSerial = 0;

  /** 按 settings.scale 应用缩放（无需重载模型，可实时调整大小） */
  function applyScale() {
    if (!model) return;
    const s = fitScale * (parseFloat(settings.scale) || 1);
    baseScaleX = s;
    model.scale.set(s * (ai.dir < 0 ? -1 : 1), s);
  }

  async function loadModel() {
    const serial = ++modelLoadSerial;
    try {
      const nextModel = await PIXI.live2d.Live2DModel.from(settings.modelPath, { autoInteract: false });
      // 如果用户在加载期间又选择了新模型，丢弃旧请求，避免旧模型覆盖新模型
      if (serial !== modelLoadSerial) {
        nextModel.destroy();
        return;
      }
      model = nextModel;
    } catch (e) {
      console.error("模型加载失败", e);
      // 兼容旧设置里的相对路径或失效路径：回退到默认模型
      try {
        const fallback = await window.petAPI.getDefaultModel();
        if (settings.modelPath !== fallback) {
          settings.modelPath = fallback;
          model = await PIXI.live2d.Live2DModel.from(fallback, { autoInteract: false });
        } else {
          throw e;
        }
      } catch (e2) {
        console.error("默认模型加载也失败", e2);
        speak("模型加载失败啦……在控制面板里重新选择模型吧");
        return;
      }
    }
    fitScale = Math.min((window.innerWidth * 0.9) / model.width, (window.innerHeight * 0.75) / model.height);
    applyScale();
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

  /** 播放模型自带动作；没有匹配组时才回退到其它动作，不凭空制造动作 */
  function playRandomMotion(groupFilter, excludeFilter) {
    if (!model) return false;
    try {
      const motions = model.internalModel.settings.motions || {};
      const groups = Object.keys(motions).filter((g) => motions[g] && motions[g].length);
      if (!groups.length) return false;
      let pool = groupFilter ? groups.filter((g) => groupFilter.test(g)) : groups.slice();
      if (excludeFilter) pool = pool.filter((g) => !excludeFilter.test(g));
      if (!pool.length && groupFilter) pool = groups.filter((g) => !excludeFilter || !excludeFilter.test(g));
      if (!pool.length) return false;
      const g = pool[Math.floor(Math.random() * pool.length)];
      model.motion(g, Math.floor(Math.random() * motions[g].length));
      return true;
    } catch (_) { return false; }
  }

  function playIdleMotion() {
    // 优先使用模型实际存在的 idle/待机动作；否则从非待机组随机选择
    return playRandomMotion(/idle|stand|wait|normal/i) || playRandomMotion(null, /walk|run|move|sleep|tap|touch/i);
  }

  function playWalkMotion() {
    // 不要求模型必须命名为 walk：没有走路组时使用模型已有动作作为移动表现
    return playRandomMotion(/walk|run|move/i) || playIdleMotion();
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
  let dragging = false, dragStartX = 0, dragStartY = 0;
  let dragWindowX = 0, dragWindowY = 0;
  window.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0 || e.target.closest("#chat-panel,#status-panel,#conn-dot,#settings-panel,#ctx-menu,#say-panel")) return;
    // 使用拖动开始时的窗口坐标计算绝对目标，不连续累加 dx，避免窗口逐渐漂移。
    const bounds = await window.petAPI.getBounds();
    if (!bounds) return;
    dragging = true;
    dragStartX = e.screenX; dragStartY = e.screenY;
    dragWindowX = bounds.x; dragWindowY = bounds.y;
    idleSec = 0; ai.mode = "idle";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const nx = dragWindowX + e.screenX - dragStartX;
    const ny = dragWindowY + e.screenY - dragStartY;
    window.petAPI.moveTo(nx, ny);
    cachedX = nx;
  });
  window.addEventListener("pointerup", () => (dragging = false));
  window.addEventListener("pointercancel", () => (dragging = false));

  window.addEventListener("dblclick", (e) => {
    if (e.target.closest("#conn-dot,#settings-panel,#ctx-menu,#say-panel")) return;
    toggleChat(true);
  });
  // ---------- 右键菜单 ----------
  const ctxMenu = document.getElementById("ctx-menu");
  const sayPanel = document.getElementById("say-panel");
  const sayInput = document.getElementById("say-input");
  const saySend = document.getElementById("say-send");

  let menuOpen = false;
  function hideCtxMenu() {
    menuOpen = false;
    ctxMenu.style.display = "none";
    // 菜单关闭后恢复透明区域穿透；鼠标移回模型时会再次开启模型交互。
    window.petAPI.setMousePassthrough(true);
  }
  function toggleSay(open) {
    sayPanel.style.display = open ? "flex" : "none";
    if (open) sayInput.focus();
  }
  function sendSay() {
    const text = sayInput.value.trim();
    if (!text) return;
    sayInput.value = "";
    toggleSay(false);
    speak(text);          // 气泡显示 + TTS 朗读
    playRandomExpression();
  }
  saySend.addEventListener("click", sendSay);
  sayInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendSay();
    if (e.key === "Escape") toggleSay(false);
  });

  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (e.target.closest("#chat-panel,#status-panel,#conn-dot,#say-panel")) return;
    // 右键菜单打开后必须暂时关闭穿透，否则菜单按钮会被传给后面的窗口。
    window.petAPI.setMousePassthrough(false);
    // 菜单显示在点击处，超出窗口边缘时向内收
    const mw = 150, mh = 300;
    const x = Math.min(e.clientX, window.innerWidth - mw - 6);
    const y = Math.min(e.clientY, window.innerHeight - mh - 6);
    ctxMenu.style.left = Math.max(4, x) + "px";
    ctxMenu.style.top = Math.max(4, y) + "px";
    ctxMenu.style.display = "block";
  });
  window.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#ctx-menu")) hideCtxMenu();
  }, true);
  ctxMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".item");
    if (!item) return;
    hideCtxMenu();
    const act = item.dataset.act;
    if (act === "chat") toggleChat(true);
    else if (act === "say") toggleSay(true);
    else if (act === "status") statusPanel.style.display = statusPanel.style.display === "block" ? "none" : "block";
    else if (act === "panel") window.petAPI.openPanel();
    else if (act === "poke") { playRandomMotion(/tap/i); fetchAction("poke"); }
    else fetchAction(act);
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
    const barColor = (v) => (v < 25 ? "#e05252" : v < 55 ? "#e0a44a" : "#58c472");
    const bar = (label, v) => {
      const w = Math.max(0, Math.min(100, v));
      return `<div class="bar"><label>${label}</label><div class="track"><div class="fill" style="width:${w}%;background:${barColor(w)}"></div></div></div>`;
    };
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
    speak("你：" + text, 6000, true);
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

  // ---------- 设置（控制面板统一管理；变更实时应用） ----------
  function applySettings(s) {
    const serverChanged = s.server && s.server !== settings.server;
    const tokenChanged = s.token !== undefined && s.token !== settings.token;
    const pathChanged = s.modelPath && s.modelPath !== settings.modelPath;
    const scaleChanged = s.scale !== undefined && s.scale !== settings.scale;
    const topChanged = s.alwaysOnTop !== undefined && s.alwaysOnTop !== settings.alwaysOnTop;
    Object.assign(settings, s);
    if (serverChanged || tokenChanged) {
      if (ws) ws.close(); else connectWS();
    }
    if (topChanged) {
      window.petAPI.setAlwaysOnTop(!!settings.alwaysOnTop);
    }
    if (pathChanged) {
      if (model) { app.stage.removeChild(model); model.destroy(); model = null; }
      loadModel();
    } else if (scaleChanged) {
      applyScale(); // 仅缩放变化时实时调整，不重载模型
    }
  }
  window.petAPI.onSettingsChanged(applySettings);

  // ---------- 托盘命令 ----------
  window.petAPI.onOpenChat(() => toggleChat(true));
  window.petAPI.onAction((action) => fetchAction(action));
  window.petAPI.onOpenSettings(() => window.petAPI.openPanel());
  connDot.addEventListener("dblclick", () => window.petAPI.openPanel());

  // ---------- 随机行为 AI ----------
  // 状态机：idle（站着，随机小动作/表情/自言自语）→ walk（随机方向走动，遇边缘转身）
  //        → sleepy（精力低时犯困）→ 循环
  const ai = { mode: "idle", dir: 1, until: 0 };
  let idleSec = 0;
  let cachedX = 0, screenLeft = 0, screenW = 1920;
  const WIN_W = 320;
  let positionSyncBusy = false;

  let lastChatterAt = 0;
  let lastMotionAt = 0;

  function setFacing(dir) {
    if (!model) return;
    ai.dir = dir;
    model.scale.x = baseScaleX * (dir < 0 ? -1 : 1);
  }

  async function syncPosition() {
    if (positionSyncBusy || dragging) return;
    positionSyncBusy = true;
    try {
      const [bounds, area] = await Promise.all([window.petAPI.getBounds(), window.petAPI.getWorkArea()]);
      if (bounds && area) {
        cachedX = bounds.x;
        screenLeft = area.x;
        screenW = area.width;
      }
    } catch (_) {} finally {
      positionSyncBusy = false;
    }
  }

  async function initScreenInfo() {
    await syncPosition();
    // 主进程负责最终钳制；这里定期用真实窗口坐标校准缓存，避免小数移动/拖动/多屏导致漂移。
    setInterval(syncPosition, 500);
  }

  // 每秒决策一次
  setInterval(() => {
    if (!model || dragging) return;
    idleSec++;

    const energy = petState ? petState.energy : 100;
    const now = Date.now();

    switch (ai.mode) {
      case "idle":
        // 随机播放模型自带动作（开关与最小间隔可在控制面板配置）
        if (settings.randomMotion && now - lastMotionAt > Math.max(3, settings.motionIntervalSec || 8) * 1000) {
          playRandomMotion() || playIdleMotion();
          playRandomExpression();
          lastMotionAt = now;
        } else if (Math.random() < 0.15) {
          playRandomExpression();
        }

        // 精力低 → 犯困
        if (energy < behavior.sleepy_threshold) {
          ai.mode = "sleepy";
          ai.until = now + 15000 + Math.random() * 15000;
          speak(pick(behavior.sleepy_lines));
          playRandomMotion(/sleep|sit/i) || playIdleMotion();
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
    const minX = screenLeft;
    const maxX = screenLeft + screenW - WIN_W;
    if (cachedX <= minX) {
      cachedX = minX; setFacing(1);
    } else if (cachedX >= maxX) {
      cachedX = maxX; setFacing(-1);
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
