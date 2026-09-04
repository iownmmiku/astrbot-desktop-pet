/* AstrBot 桌宠 - 渲染层：Live2D 展示 + 交互 + 随机行为 + 与插件通信（支持远程服务器） */
(async () => {
  "use strict";

  // ---------- 配置常量（可调整性能参数） ----------
  const CONFIG = {
    POSITION_SYNC_INTERVAL_MS: 500,        // 位置同步频率（毫秒）
    MIN_MOTION_INTERVAL_SEC: 3,            // 最小随机动作间隔（秒）
    DEFAULT_MOTION_INTERVAL_SEC: 8,        // 默认随机动作间隔（秒）
    FETCH_TIMEOUT_MS: 10000,               // HTTP 请求超时（毫秒）
    WS_RECONNECT_MAX_RETRY: 6,             // WebSocket 最大重连退避次数
    BUBBLE_DEFAULT_DURATION_MS: 6000,      // 气泡默认显示时长（毫秒）
    TTS_MAX_LENGTH: 200,                   // TTS 最大字符数
    CANVAS_RESOLUTION: 1,                  // Canvas 渲染分辨率（1 = CSS 像素）
    MODEL_FIT_WIDTH_RATIO: 0.9,            // 模型适配窗口宽度比例
    MODEL_FIT_HEIGHT_RATIO: 0.75,          // 模型适配窗口高度比例
    MODEL_BOTTOM_OFFSET: 6,                // 模型底部偏移（像素）
  };

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
  function speak(text, ms = CONFIG.BUBBLE_DEFAULT_DURATION_MS, noTts = false) {
    bubble.textContent = text;
    bubble.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("show"), ms);
    if (!noTts) tts(text);
  }

  // ---------- 文字转语音（Web Speech API + 队列防抖） ----------
  let ttsQueue = [];
  let ttsPlaying = false;
  function tts(text) {
    try {
      if (!settings.ttsEnabled || !window.speechSynthesis || !text) return;
      ttsQueue.push(String(text).slice(0, CONFIG.TTS_MAX_LENGTH));
      if (!ttsPlaying) playNextTTS();
    } catch (_) {}
  }
  function playNextTTS() {
    if (!ttsQueue.length) { ttsPlaying = false; return; }
    ttsPlaying = true;
    window.speechSynthesis.cancel();
    const text = ttsQueue.shift();
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => x.name === settings.ttsVoice);
    if (v) u.voice = v;
    const rate = parseFloat(settings.ttsRate);
    const vol = parseFloat(settings.ttsVolume);
    u.rate = isNaN(rate) ? 1 : Math.max(0.5, Math.min(2, rate));
    u.volume = isNaN(vol) ? 1 : Math.max(0, Math.min(1, vol));
    u.onend = () => playNextTTS();
    u.onerror = () => playNextTTS();
    window.speechSynthesis.speak(u);
  }

  // ---------- PIXI / Live2D ----------
  const canvasWrap = document.getElementById("canvas-wrap");
  // 禁用 Pixi resizeTo: window，改为显式 resize，避免透明窗口移动时
  // Canvas backing size、CSS 尺寸和 HTML 覆盖层在不同帧不同步。
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    autoStart: true,
    // 使用 CSS 像素而不是系统 DPI 物理像素，防止拖动窗口时整体放大。
    resolution: CONFIG.CANVAS_RESOLUTION,
    autoDensity: false,
  });
  app.view.style.display = "block";
  app.view.style.width = "100%";
  app.view.style.height = "100%";
  canvasWrap.appendChild(app.view);

  let canvasWidth = 0;
  let canvasHeight = 0;
  function resizeRenderer(force = false) {
    // 移动原生窗口不应触发内容布局重算；拖动期间锁定渲染尺寸。
    if (!force && dragging) return;
    const width = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    const height = Math.max(1, document.documentElement.clientHeight || window.innerHeight);
    if (!force && width === canvasWidth && height === canvasHeight) return;
    canvasWidth = width;
    canvasHeight = height;
    app.renderer.resize(width, height);
  }
  resizeRenderer(true);

  let model = null;
  let baseScaleX = 1;
  let dragging = false;

  // ---------- 统一交互/穿透状态机 ----------
  // 规则：有任何 UI（右键菜单/聊天框/说话框/状态面板）打开，或鼠标位于模型区域时 → 接收鼠标；
  // 其余情况 → 透明区域穿透到后面的窗口。所有穿透切换都经过这一个函数，避免多套条件互相打架。
  const uiState = { menu: false, chat: false, say: false, status: false };
  let pointerInModel = false;
  let passthroughOn = null;
  let lastPointerX = 0, lastPointerY = 0;

  function updateMouseMode() {
    if (dragging) return;
    const shouldReceive = uiState.menu || uiState.chat || uiState.say || uiState.status || pointerInModel;
    const wantPassthrough = !shouldReceive;
    if (wantPassthrough !== passthroughOn) {
      passthroughOn = wantPassthrough;
      window.petAPI.setMousePassthrough(wantPassthrough);
    }
  }

  function refreshPointerHit() {
    if (!model) { pointerInModel = false; return; }
    try {
      const b = model.getBounds();
      pointerInModel = lastPointerX >= b.x && lastPointerX <= b.x + b.width &&
        lastPointerY >= b.y && lastPointerY <= b.y + b.height;
    } catch (_) {}
  }

  window.addEventListener("mousemove", (e) => {
    lastPointerX = e.clientX; lastPointerY = e.clientY;
    if (dragging) return;
    refreshPointerHit();
    updateMouseMode();
  });
  let fitScale = 1; // 窗口适配缩放（不含用户缩放倍率）
  let modelBaseWidth = 0;
  let modelBaseHeight = 0;
  let modelLoadSerial = 0;

  function calculateFitScale() {
    if (!model) return 1;
    const width = modelBaseWidth || model.width;
    const height = modelBaseHeight || model.height;
    return Math.min((app.renderer.width * CONFIG.MODEL_FIT_WIDTH_RATIO) / width, (app.renderer.height * CONFIG.MODEL_FIT_HEIGHT_RATIO) / height);
  }

  /** 统一布局模型：模型和 HTML 气泡/菜单都以当前窗口内容区为坐标系。 */
  function layoutModel() {
    if (!model) return;
    const w = app.renderer.width;
    const h = app.renderer.height;
    model.anchor.set(0.5, 1);
    model.position.set(Math.round(w / 2), Math.round(h - CONFIG.MODEL_BOTTOM_OFFSET));
  }

  /** 按 settings.scale 应用缩放（无需重载模型，可实时调整大小） */
  function applyScale() {
    if (!model) return;
    const s = fitScale * (parseFloat(settings.scale) || 1);
    baseScaleX = s;
    model.scale.set(s * (typeof ai !== "undefined" && ai.dir < 0 ? -1 : 1), s);
    layoutModel();
  }

  function syncCanvasLayout() {
    // 窗口拖动只是改变原生窗口位置，不允许触发模型缩放。
    // 双重保护：检查 dragging 且检查尺寸是否真的变化
    if (dragging) return;
    try {
      const oldW = canvasWidth, oldH = canvasHeight;
      resizeRenderer();
      // 只有尺寸真的变化时才重新计算缩放，避免拖动时误触发
      if (model && (canvasWidth !== oldW || canvasHeight !== oldH)) {
        fitScale = calculateFitScale();
        applyScale();
      }
    } catch (_) {}
  }
  window.addEventListener("resize", syncCanvasLayout);

  async function loadModel() {
    const serial = ++modelLoadSerial;
    connDot.className = "bad";
    connDot.title = "正在加载模型…";
    speak("正在加载模型…", 10000, true);
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
    // 记录未缩放的模型尺寸；model.width/height 会随 scale 变化，不能用于后续重复计算。
    modelBaseWidth = model.width;
    modelBaseHeight = model.height;
    fitScale = calculateFitScale();
    applyScale();
    layoutModel();
    model.eventMode = "static";
    app.stage.addChild(model);

    model.on("hit", (areas) => {
      playRandomMotion(/tap/i);
      speak(areas.length ? `碰到${areas[0]}啦！` : pick(["呀！", "干嘛啦！", "嘿嘿，好痒～"]));
      fetchAction("poke");
      idleSec = 0;
    });
    speak(`${settings.petName || "桌宠"} 的形象加载好啦！`, 2500, true);
    connDot.className = ws && ws.readyState === 1 ? "ok" : "bad";
    connDot.title = ws && ws.readyState === 1 ? `已连接 ${settings.server}` : "模型已加载，等待插件连接";
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
  let dragStartX = 0, dragStartY = 0;
  let dragWindowX = 0, dragWindowY = 0;
  let lastWindowX = 0, lastWindowY = 0;
  let dragPending = null;
  let dragFrame = 0;

  function flushDrag() {
    dragFrame = 0;
    if (!dragging || !dragPending) return;
    const p = dragPending;
    dragPending = null;
    // 每一帧最多移动一次窗口，避免 IPC 高频排队导致窗口视觉滞后/错位。
    window.petAPI.moveTo(p.x, p.y);
    lastWindowX = p.x; lastWindowY = p.y;
  }

  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("#chat-panel,#status-panel,#conn-dot,#settings-panel,#ctx-menu,#say-panel")) return;
    // 使用最近一次真实窗口坐标，避免 pointerdown 等待 IPC 返回期间继续漫游。
    dragging = true;
    dragStartX = e.screenX; dragStartY = e.screenY;
    dragWindowX = lastWindowX; dragWindowY = lastWindowY;
    dragPending = null;
    idleSec = 0; ai.mode = "idle";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dragPending = {
      x: dragWindowX + e.screenX - dragStartX,
      y: dragWindowY + e.screenY - dragStartY,
    };
    if (!dragFrame) dragFrame = requestAnimationFrame(flushDrag);
  });
  function endDrag() {
    dragging = false;
    dragPending = null;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    // 拖动结束后立即校准位置并重新验证布局，防止 DPI/显示器变化导致缩放错误
    syncPosition();
    // 强制重新计算一次，确保 Canvas 尺寸、模型缩放与当前窗口状态一致
    requestAnimationFrame(() => {
      resizeRenderer(true);
      if (model) {
        fitScale = calculateFitScale();
        applyScale();
      }
    });
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  window.addEventListener("dblclick", (e) => {
    if (e.target.closest("#conn-dot,#settings-panel,#ctx-menu,#say-panel")) return;
    toggleChat(true);
  });
  // ---------- 右键菜单 ----------
  const ctxMenu = document.getElementById("ctx-menu");
  const sayPanel = document.getElementById("say-panel");
  const sayInput = document.getElementById("say-input");
  const saySend = document.getElementById("say-send");

  let ctxMenuWidth = 0, ctxMenuHeight = 0;
  function hideCtxMenu() {
    uiState.menu = false;
    ctxMenu.style.display = "none";
    refreshPointerHit();
    updateMouseMode();
  }
  function showCtxMenu(x, y) {
    uiState.menu = true;
    updateMouseMode(); // 菜单打开期间强制保持交互
    // 首次打开时缓存菜单尺寸，避免每次都触发布局计算
    if (!ctxMenuWidth || !ctxMenuHeight) {
      ctxMenu.style.visibility = "hidden";
      ctxMenu.style.display = "block";
      const rect = ctxMenu.getBoundingClientRect();
      ctxMenuWidth = rect.width;
      ctxMenuHeight = rect.height;
    } else {
      ctxMenu.style.display = "block";
    }
    // 使用缓存尺寸定位，避免边缘闪烁
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - ctxMenuWidth - 4)) + "px";
    ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - ctxMenuHeight - 4)) + "px";
    ctxMenu.style.visibility = "visible";
  }
  function toggleSay(open) {
    sayPanel.style.display = open ? "flex" : "none";
    uiState.say = !!open;
    updateMouseMode();
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
    showCtxMenu(e.clientX, e.clientY);
  });
  window.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#ctx-menu")) hideCtxMenu();
  }, true);
  ctxMenu.addEventListener("click", async (e) => {
    const item = e.target.closest(".item");
    if (!item) return;
    hideCtxMenu();
    const act = item.dataset.act;
    if (act === "chat") toggleChat(true);
    else if (act === "say") toggleSay(true);
    else if (act === "status") {
      const open = statusPanel.style.display !== "block";
      statusPanel.style.display = open ? "block" : "none";
      uiState.status = open;
      updateMouseMode();
    }
    else if (act === "panel") window.petAPI.openPanel();
    else if (act === "poke") { playRandomMotion(/tap/i); fetchAction("poke"); }
    else if (act === "motion") { playRandomMotion() || playIdleMotion(); playRandomExpression(); }
    else if (act === "reset-pos") {
      const [bounds, area] = await Promise.all([window.petAPI.getBounds(), window.petAPI.getWorkArea()]);
      if (bounds && area) window.petAPI.moveTo(area.x + (area.width - bounds.width) / 2, area.y + area.height - bounds.height);
      syncPosition();
    }
    else fetchAction(act);
  });

  function toggleChat(open) {
    chatPanel.style.display = open ? "flex" : "none";
    uiState.chat = !!open;
    updateMouseMode();
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
    const expPct = Math.max(0, Math.min(100, (s.exp / (s.level * 100)) * 100));
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    statusPanel.innerHTML =
      `<b>${settings.petName} Lv.${s.level}</b>` +
      bar("经验", expPct) +
      bar("心情", s.mood) + bar("饱食", s.satiety) + bar("清洁", s.cleanliness) + bar("精力", s.energy) +
      `<div style="margin-top:6px;color:#9aa;font-size:10px">连接 ${settings.server} · 更新于 ${time}</div>`;
  }

  // ---------- 插件通信 ----------
  let ws = null, wsRetry = 0, wsReconnectTimer = null;
  function connectWS() {
    // 清理旧连接和定时器，避免内存泄漏
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) {
      try { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; ws.close(); } catch (_) {}
      ws = null;
    }
    const url = `${wsBase()}/ws${settings.token ? "?token=" + encodeURIComponent(settings.token) : ""}`;
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      wsRetry = 0;
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      connDot.className = "ok";
      connDot.title = `已连接 ${settings.server}`;
    };
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
    if (wsReconnectTimer) return; // 防止重复调度
    wsRetry = Math.min(wsRetry + 1, CONFIG.WS_RECONNECT_MAX_RETRY);
    wsReconnectTimer = setTimeout(connectWS, 1000 * wsRetry);
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
    try {
      const r = await api("/api/action", { action });
      renderState(r.state);
      if (r.reply && (!ws || ws.readyState !== 1)) speak(r.reply); // WS 断开时直接显示回复
    } catch (e) {
      speak("操作失败：" + e.message, 4000, true);
    }
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
  window.petAPI.onReloadModel(() => {
    if (model) { app.stage.removeChild(model); model.destroy(); model = null; }
    loadModel();
  });
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
        lastWindowX = bounds.x;
        lastWindowY = bounds.y;
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
    window.petAPI.moveTo(cachedX, lastWindowY); // 使用绝对目标位置，避免 moveBy 取整累积漂移
  });

  // ---------- 启动 ----------
  initScreenInfo().then(() => {
    loadModel();
    connectWS();
  });
})();
