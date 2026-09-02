/* 控制面板逻辑：设置读写（主进程持久化）+ 插件 API 直连 */
(async () => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- 标签页切换 ----------
  document.querySelectorAll("nav button.tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll("nav button.tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("page-" + t.dataset.page).classList.add("active");
    })
  );
  const badge = $("conn-badge");
  const toastEl = $("toast");
  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = "none"), 2500);
  }

  // ---------- 设置读写 ----------
  let settings = Object.assign(
    { server: "127.0.0.1:9898", token: "", modelPath: "", scale: 1.0, alwaysOnTop: true, randomMotion: true, motionIntervalSec: 8,
      ttsEnabled: false, ttsVoice: "", ttsRate: 1.0, ttsVolume: 1.0 },
    await window.petAPI.getSettings()
  );
  if (!settings.modelPath) {
    settings.modelPath = await window.petAPI.getDefaultModel();
  }

  function fillForm() {
    $("server").value = settings.server;
    $("token").value = settings.token;
    $("model").value = settings.modelPath;
    $("scale").value = settings.scale;
    $("scale-val").textContent = Number(settings.scale).toFixed(2);
    $("alwaysOnTop").checked = settings.alwaysOnTop !== false;
    $("randomMotion").checked = settings.randomMotion !== false;
    $("motionIntervalSec").value = settings.motionIntervalSec || 8;
    $("ttsEnabled").checked = !!settings.ttsEnabled;
    $("ttsRate").value = settings.ttsRate || 1;
    $("ttsRate-val").textContent = Number(settings.ttsRate || 1).toFixed(1);
    $("ttsVolume").value = settings.ttsVolume ?? 1;
    $("ttsVolume-val").textContent = Math.round((settings.ttsVolume ?? 1) * 100);
    fillVoices();
  }
  fillForm();
  $("scale").addEventListener("input", () => {
    $("scale-val").textContent = Number($("scale").value).toFixed(2);
    // 拖动滑条即时生效（同时写回设置，主进程持久化）
    saveSettings({ scale: parseFloat($("scale").value) || 1 }, true);
  });
  $("save-display").addEventListener("click", async () => {
    await saveSettings({
      scale: parseFloat($("scale").value) || 1,
      alwaysOnTop: $("alwaysOnTop").checked,
      randomMotion: $("randomMotion").checked,
      motionIntervalSec: Math.max(3, parseInt($("motionIntervalSec").value) || 8),
    });
  });

  async function saveSettings(patch, silent) {
    settings = Object.assign({}, settings, patch);
    await window.petAPI.setSettings(settings);
    if (!silent) toast("已保存，桌宠端实时生效");
  }

  $("save-conn").addEventListener("click", async () => {
    await saveSettings({ server: $("server").value.trim() || settings.server, token: $("token").value });
    refreshState();
  });
  $("save-model").addEventListener("click", async () => {
    await saveSettings({ modelPath: $("model").value.trim() || settings.modelPath, scale: parseFloat($("scale").value) || 1 });
  });
  $("pick-model").addEventListener("click", async () => {
    const r = await window.petAPI.pickModel();
    if (r.canceled) return;
    if (r.error) { toast(r.error); return; }
    $("model").value = r.modelPath;
    await saveSettings({ modelPath: r.modelPath, scale: parseFloat($("scale").value) || 1 });
  });

  // ---------- TTS ----------
  function fillVoices() {
    const sel = $("ttsVoice");
    if (!window.speechSynthesis) {
      sel.innerHTML = `<option value="">（当前环境不支持语音合成）</option>`;
      return;
    }
    const voices = window.speechSynthesis.getVoices();
    sel.innerHTML = `<option value="">（系统默认）</option>` +
      voices.map((v) => `<option value="${v.name}"${v.name === settings.ttsVoice ? " selected" : ""}>${v.name}（${v.lang}）</option>`).join("");
    if (!voices.length) sel.innerHTML = `<option value="">（未检测到可用语音）</option>`;
  }
  if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = fillVoices;
  $("ttsRate").addEventListener("input", () => ($("ttsRate-val").textContent = Number($("ttsRate").value).toFixed(1)));
  $("ttsVolume").addEventListener("input", () => ($("ttsVolume-val").textContent = Math.round($("ttsVolume").value * 100)));
  $("tts-test").addEventListener("click", () => {
    if (!window.speechSynthesis) { toast("当前环境不支持语音合成"); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("你好呀，我是你的桌宠！");
    const v = window.speechSynthesis.getVoices().find((x) => x.name === $("ttsVoice").value);
    if (v) u.voice = v;
    u.rate = parseFloat($("ttsRate").value) || 1;
    u.volume = parseFloat($("ttsVolume").value) ?? 1;
    window.speechSynthesis.speak(u);
  });
  $("save-tts").addEventListener("click", async () => {
    await saveSettings({
      ttsEnabled: $("ttsEnabled").checked,
      ttsVoice: $("ttsVoice").value,
      ttsRate: parseFloat($("ttsRate").value) || 1,
      ttsVolume: parseFloat($("ttsVolume").value) ?? 1,
    });
  });

  // ---------- 人格对话 ----------
  function togglePersonaRows() {
    const src = $("persona_source").value;
    $("row-persona-id").style.display = src === "persona" ? "block" : "none";
    $("row-persona-custom").style.display = src === "custom" ? "block" : "none";
  }
  $("persona_source").addEventListener("change", togglePersonaRows);

  async function loadPersonaList(selectId) {
    try {
      const resp = await fetch(httpBase() + "/api/personas", { headers: headers() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const list = data.personas || [];
      const sel = $("astrbot_persona_id");
      sel.innerHTML = list.length
        ? list.map((p) => `<option value="${p.id}"${p.id === selectId ? " selected" : ""}>${p.name}</option>`).join("")
        : `<option value="">（AstrBot 里还没有已配置人格）</option>`;
      if (selectId && !list.some((p) => p.id === selectId)) {
        sel.innerHTML = `<option value="${selectId}" selected>${selectId}（当前）</option>` + sel.innerHTML;
      }
    } catch (e) {
      toast("获取人格列表失败：" + e.message);
    }
  }

  async function loadPersona() {
    try {
      const resp = await fetch(httpBase() + "/api/config", { headers: headers() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const cfg = await resp.json();
      $("persona_source").value = cfg.persona_source || "custom";
      $("persona").value = cfg.persona || "";
      $("pet_name").value = cfg.pet_name || "桌宠";
      $("llm_action_reply").checked = cfg.llm_action_reply !== false;
      togglePersonaRows();
      await loadPersonaList(cfg.astrbot_persona_id || "");
      toast("已从插件读取人格配置");
    } catch (e) {
      toast("读取失败：" + e.message);
    }
  }

  async function savePersona() {
    const cfg = {
      persona_source: $("persona_source").value,
      astrbot_persona_id: $("astrbot_persona_id").value,
      persona: $("persona").value,
      pet_name: $("pet_name").value.trim() || "桌宠",
      llm_action_reply: $("llm_action_reply").checked,
    };
    try {
      const resp = await fetch(httpBase() + "/api/config", {
        method: "POST", headers: headers(), body: JSON.stringify(cfg),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      toast("已保存到插件并广播给所有客户端");
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }

  $("load-persona").addEventListener("click", loadPersona);
  $("save-persona").addEventListener("click", savePersona);
  $("refresh-personas").addEventListener("click", () => loadPersonaList($("astrbot_persona_id").value));

  // ---------- 插件 API ----------
  function httpBase() {
    let s = (settings.server || "").trim().replace(/\/+$/, "");
    if (/^wss:\/\//i.test(s)) return "https://" + s.slice(6);
    if (/^ws:\/\//i.test(s)) return "http://" + s.slice(5);
    if (/^https?:\/\//i.test(s)) return s;
    return "http://" + s;
  }
  function headers() {
    const h = { "Content-Type": "application/json" };
    if (settings.token) h["X-Pet-Token"] = settings.token;
    return h;
  }
  function setBadge(ok, text) {
    badge.className = ok === null ? "" : ok ? "ok" : "bad";
    badge.textContent = text;
  }

  async function refreshState() {
    try {
      const resp = await fetch(httpBase() + "/api/state", { headers: headers() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      setBadge(true, `已连接 · ${data.pet_name}`);
      renderState(data.state);
    } catch (e) {
      setBadge(false, "连接失败");
      $("state-bars").innerHTML = `<div class="hint">无法连接插件：${e.message}</div>`;
    }
  }

  function barColor(v) {
    return v < 25 ? "#e05252" : v < 55 ? "#e0a44a" : "#58c472";
  }

  function renderState(s) {
    if (!s) return;
    const bar = (label, v) => {
      const w = Math.max(0, Math.min(100, v));
      return `<div class="bar"><label>${label}</label><div class="track"><div class="fill" style="width:${w}%;background:${barColor(w)}"></div></div><span class="val">${Math.round(v)}</span></div>`;
    };
    $("state-lvl").innerHTML = `<span class="lvl">Lv.${s.level}<small>经验 ${s.exp}/${s.level * 100}</small></span>`;
    $("state-bars").innerHTML =
      bar("心情", s.mood) + bar("饱食", s.satiety) + bar("清洁", s.cleanliness) + bar("精力", s.energy);
  }

  $("test-conn").addEventListener("click", refreshState);
  $("refresh-state").addEventListener("click", refreshState);
  document.querySelectorAll(".act").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const resp = await fetch(httpBase() + "/api/action", {
          method: "POST", headers: headers(), body: JSON.stringify({ action: b.dataset.a }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        renderState(data.state);
        toast(data.reply);
      } catch (e) {
        toast("操作失败：" + e.message);
      }
    })
  );

  // ---------- 行为配置 ----------
  const splitLines = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);

  async function loadBehavior() {
    try {
      const resp = await fetch(httpBase() + "/api/config", { headers: headers() });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const cfg = await resp.json();
      $("enable_roam").checked = !!cfg.enable_roam;
      $("enable_chatter").checked = !!cfg.enable_chatter;
      $("walk_speed").value = cfg.walk_speed;
      $("sleepy_threshold").value = cfg.sleepy_threshold;
      $("chatter_interval_sec").value = cfg.chatter_interval_sec;
      $("chatter_lines").value = (cfg.chatter_lines || []).join("\n");
      $("sleepy_lines").value = (cfg.sleepy_lines || []).join("\n");
      toast("已从插件读取行为配置");
    } catch (e) {
      toast("读取失败：" + e.message);
    }
  }

  async function saveBehavior() {
    const cfg = {
      enable_roam: $("enable_roam").checked,
      enable_chatter: $("enable_chatter").checked,
      walk_speed: parseFloat($("walk_speed").value),
      sleepy_threshold: parseInt($("sleepy_threshold").value),
      chatter_interval_sec: parseInt($("chatter_interval_sec").value),
      chatter_lines: splitLines($("chatter_lines").value),
      sleepy_lines: splitLines($("sleepy_lines").value),
    };
    try {
      const resp = await fetch(httpBase() + "/api/config", {
        method: "POST", headers: headers(), body: JSON.stringify(cfg),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      toast("已保存到插件并广播给所有客户端");
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }

  async function generateLines(kind, targetId, buttonId) {
    const button = $(buttonId);
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "生成中…";
    try {
      const resp = await fetch(httpBase() + "/api/generate-lines", {
        method: "POST", headers: headers(), body: JSON.stringify({ kind, count: kind === "chatter" ? 8 : 5 }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
      const lines = (data.lines || []).filter(Boolean);
      if (!lines.length) throw new Error("模型没有返回有效台词");
      $(targetId).value = lines.join("\n");
      toast(`已按当前人格生成 ${lines.length} 条台词，请确认后点击“保存到插件”`);
    } catch (e) {
      toast("生成失败：" + e.message);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  $("load-behavior").addEventListener("click", loadBehavior);
  $("save-behavior").addEventListener("click", saveBehavior);
  $("generate-chatter").addEventListener("click", () => generateLines("chatter", "chatter_lines", "generate-chatter"));
  $("generate-sleepy").addEventListener("click", () => generateLines("sleepy", "sleepy_lines", "generate-sleepy"));

  // ---------- 启动 ----------
  setBadge(null, "连接中…");
  refreshState();
  loadBehavior();
  loadPersona();
  togglePersonaRows();
  setInterval(refreshState, 10000); // 状态每 10 秒自动刷新
})();
