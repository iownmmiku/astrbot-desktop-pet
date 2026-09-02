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
    { server: "127.0.0.1:9898", token: "", modelPath: "", scale: 1.0 },
    await window.petAPI.getSettings()
  );
  if (!settings.modelPath) {
    const dataDir = (await window.petAPI.getDataDir()).replace(/\\/g, "/");
    settings.modelPath = "file:///" + dataDir + "/models/Haru/Haru.model3.json";
  }

  function fillForm() {
    $("server").value = settings.server;
    $("token").value = settings.token;
    $("model").value = settings.modelPath;
    $("scale").value = settings.scale;
    $("scale-val").textContent = Number(settings.scale).toFixed(2);
  }
  fillForm();
  $("scale").addEventListener("input", () => ($("scale-val").textContent = Number($("scale").value).toFixed(2)));

  async function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    await window.petAPI.setSettings(settings);
    toast("已保存，桌宠端实时生效");
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

  $("load-behavior").addEventListener("click", loadBehavior);
  $("save-behavior").addEventListener("click", saveBehavior);

  // ---------- 启动 ----------
  setBadge(null, "连接中…");
  refreshState();
  loadBehavior();
  setInterval(refreshState, 10000); // 状态每 10 秒自动刷新
})();
