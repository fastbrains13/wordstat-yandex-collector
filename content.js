(() => {
  const STORAGE_KEYS = {
    WORDS: "wc_words",
    POS: "wc_pos",
    COLLAPSED: "wc_collapsed",
    SETTINGS: "wc_settings"
  };

  // Change this to your public repo before publishing
  const GITHUB_URL = "https://github.com/fastbrains13/wordstat-yandex-collector";

  // ---------- Settings ----------
  const defaultSettings = {
    stripPlusInPhrases: false, // "удалять + из фраз"
    addBangPrefix: false,      // добавлять "!" при добавлении
    addPlusPrefix: false       // добавлять "+" при добавлении
  };

  let settings = { ...defaultSettings };

  // ---------- State ----------
  let words = [];                 // stored words (with prefixes as chosen)
  let widgetPos = { x: 24, y: 120 };
  let isCollapsed = false;

  // Derived fast lookup by "base word" (without leading operators)
  let baseSet = new Set();        // Set<string>
  let baseToStored = new Map();   // Map<string, string> base -> storedWord

  // ---------- Utils ----------
  function normalizeBase(word) {
    // Used to detect duplicates and highlight tokens.
    // Strips leading operator chars that we add in this tool.
    return String(word || "").replace(/^[!+]+/g, "");
  }

  function applyPrefixes(baseWord) {
    let w = baseWord;
    // Order: first "!" then "+"
    if (settings.addBangPrefix && !w.startsWith("!")) w = "!" + w;
    if (settings.addPlusPrefix && !w.startsWith("+")) w = "+" + w;
    return w;
  }

  function tokenKeyFromRaw(raw) {
    // "удалять + из фраз": affects tokens extracted from Wordstat phrases (e.g. "+в" -> "в")
    if (settings.stripPlusInPhrases) {
      return String(raw || "").replace(/^\++/g, "");
    }
    return String(raw || "");
  }

  function tokenDisplayFromRaw(raw) {
    // Display is the same as key in our UX (clean if stripPlusInPhrases is enabled)
    return tokenKeyFromRaw(raw);
  }

  function splitWords(phrase) {
    return (phrase || "").split(/\s+/).filter(t => t.length > 0);
  }

  function rebuildIndex() {
    baseSet = new Set();
    baseToStored = new Map();
    for (const w of words) {
      const b = normalizeBase(w);
      if (!b) continue;
      if (!baseSet.has(b)) {
        baseSet.add(b);
        baseToStored.set(b, w);
      }
    }
  }

  function saveWords() { chrome.storage.local.set({ [STORAGE_KEYS.WORDS]: words }); }
  function savePos() { chrome.storage.local.set({ [STORAGE_KEYS.POS]: widgetPos }); }
  function saveCollapsed() { chrome.storage.local.set({ [STORAGE_KEYS.COLLAPSED]: isCollapsed }); }
  function saveSettings() { chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings }); }

  function addBaseWord(baseWord) {
    const b = normalizeBase(baseWord);
    if (!b) return;

    if (baseSet.has(b)) {
      flashToast("Уже добавлено");
      return;
    }

    const stored = applyPrefixes(b);
    words.push(stored);
    rebuildIndex();
    renderWidgetList();
    updateAllTokensUI();
    saveWords();
  }

  function removeByBase(baseWord) {
    const b = normalizeBase(baseWord);
    if (!b || !baseSet.has(b)) return;

    const stored = baseToStored.get(b);
    words = words.filter(x => x !== stored);
    rebuildIndex();
    renderWidgetList();
    updateAllTokensUI();
    saveWords();
  }

  function removeStoredWord(storedWord) {
    const idx = words.indexOf(storedWord);
    if (idx === -1) return;
    words.splice(idx, 1);
    rebuildIndex();
    renderWidgetList();
    updateAllTokensUI();
    saveWords();
  }

  function clearWords() {
    words = [];
    rebuildIndex();
    renderWidgetList();
    updateAllTokensUI();
    saveWords();
  }

  async function copyWords() {
    const text = words.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      flashToast("Скопировано");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashToast("Скопировано");
    }
  }

  let toastTimer = null;
  function flashToast(msg) {
    const t = document.getElementById("wc-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("wc-toast--show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("wc-toast--show"), 900);
  }

  // ---------- Widget UI ----------
  function buildWidget() {
    if (document.getElementById("wc-widget")) return;

    const widget = document.createElement("div");
    widget.id = "wc-widget";
    widget.className = "wc-widget";
    widget.style.left = `${widgetPos.x}px`;
    widget.style.top = `${widgetPos.y}px`;

    const header = document.createElement("div");
    header.className = "wc-header";
    header.innerHTML = `
      <div class="wc-title">
        <span class="wc-dot"></span>
        <span>Word Collector</span>
        <span class="wc-count" id="wc-count">0</span>
      </div>
      <div class="wc-actions">
        <button class="wc-icon-btn" id="wc-toggle" title="Свернуть/развернуть">—</button>
      </div>
    `;

    const body = document.createElement("div");
    body.className = "wc-body";
    body.innerHTML = `
      <div class="wc-toolbar">
        <button class="wc-tool wc-tool--primary" id="wc-add" title="Добавить слова вручную">＋</button>
        <button class="wc-tool" id="wc-copy" title="Копировать">⧉</button>
        <button class="wc-tool" id="wc-clear" title="Очистить">🧹</button>
        <button class="wc-tool" id="wc-settings" title="Настройки">⚙</button>
      </div>

      <div class="wc-panels">
        <div class="wc-panel" id="wc-panel-add" aria-hidden="true">
          <div class="wc-panel-title">Добавить слова</div>
          <div class="wc-panel-hint">Вставь слова столбиком или через запятую/точку с запятой.</div>
          <textarea class="wc-textarea" id="wc-add-input" rows="4" placeholder="купить&#10;бытовку&#10;недорого"></textarea>
          <div class="wc-panel-actions">
            <button class="wc-btn" id="wc-add-apply">Добавить</button>
            <button class="wc-btn wc-btn--ghost" id="wc-add-cancel">Закрыть</button>
          </div>
        </div>

        <div class="wc-panel" id="wc-panel-settings" aria-hidden="true">
          <div class="wc-panel-title">Настройки</div>

          <label class="wc-check">
            <input type="checkbox" id="wc-set-stripplus" />
            <span>Удалять <b>+</b> из фраз</span>
          </label>

          <label class="wc-check">
            <input type="checkbox" id="wc-set-bang" />
            <span>Добавлять <b>!</b> при добавлении</span>
          </label>
          <div class="wc-panel-hint">Отключение не удаляет <b>!</b> у уже добавленных слов.</div>

          <label class="wc-check">
            <input type="checkbox" id="wc-set-plus" />
            <span>Добавлять <b>+</b> при добавлении</span>
          </label>
          <div class="wc-panel-hint">Отключение не удаляет <b>+</b> у уже добавленных слов.</div>

          <div class="wc-panel-actions">
            <button class="wc-btn wc-btn--ghost" id="wc-settings-close">Закрыть</button>
          </div>
        </div>
      </div>

      <div class="wc-list-wrap">
        <ul class="wc-list" id="wc-list"></ul>
      </div>

      <div class="wc-footer">
        <div class="wc-footer-text">Open-source. Хранит данные только локально.</div>
        <a class="wc-footer-link" href="${GITHUB_URL}" target="_blank" rel="noreferrer">GitHub репозиторий</a>
      </div>
    `;

    const toast = document.createElement("div");
    toast.id = "wc-toast";
    toast.className = "wc-toast";

    widget.appendChild(header);
    widget.appendChild(body);
    widget.appendChild(toast);
    document.body.appendChild(widget);

    // Toolbar actions
    widget.querySelector("#wc-copy").addEventListener("click", copyWords);
    widget.querySelector("#wc-clear").addEventListener("click", () => { clearWords(); flashToast("Очищено"); });
    widget.querySelector("#wc-settings").addEventListener("click", () => togglePanel("wc-panel-settings"));
    widget.querySelector("#wc-add").addEventListener("click", () => togglePanel("wc-panel-add"));

    // Add panel actions
    widget.querySelector("#wc-add-apply").addEventListener("click", () => {
      const ta = widget.querySelector("#wc-add-input");
      const raw = (ta.value || "").trim();
      if (!raw) { flashToast("Пусто"); return; }
      const items = raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
      for (const it of items) addBaseWord(it);
      ta.value = "";
      closePanels();
      flashToast("Добавлено");
    });
    widget.querySelector("#wc-add-cancel").addEventListener("click", closePanels);

    // Settings bindings
    const stripPlusEl = widget.querySelector("#wc-set-stripplus");
    const bangEl = widget.querySelector("#wc-set-bang");
    const plusEl = widget.querySelector("#wc-set-plus");
    stripPlusEl.checked = !!settings.stripPlusInPhrases;
    bangEl.checked = !!settings.addBangPrefix;
    plusEl.checked = !!settings.addPlusPrefix;

    stripPlusEl.addEventListener("change", () => {
      settings.stripPlusInPhrases = !!stripPlusEl.checked;
      saveSettings();
      // Update existing tokens: their display/key depends on this setting.
      refreshTokensAfterSettingChange();
      flashToast("Сохранено");
    });

    bangEl.addEventListener("change", () => {
      settings.addBangPrefix = !!bangEl.checked;
      saveSettings();
      flashToast("Сохранено");
    });

    plusEl.addEventListener("change", () => {
      settings.addPlusPrefix = !!plusEl.checked;
      saveSettings();
      flashToast("Сохранено");
    });

    widget.querySelector("#wc-settings-close").addEventListener("click", closePanels);

    // Prevent header drag from hijacking toggle interactions
    const toggleBtn = widget.querySelector("#wc-toggle");
    toggleBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    toggleBtn.addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      widget.classList.toggle("wc-widget--collapsed", isCollapsed);
      saveCollapsed();
    });

    // Dragging
    setupDragging(widget, header);

    // Apply collapsed state
    widget.classList.toggle("wc-widget--collapsed", isCollapsed);

    renderWidgetList();
  }

  function togglePanel(id) {
    const p = document.getElementById(id);
    if (!p) return;
    const open = p.classList.contains("wc-panel--open");
    closePanels();
    if (!open) {
      p.classList.add("wc-panel--open");
      p.setAttribute("aria-hidden", "false");
    }
  }

  function closePanels() {
    document.querySelectorAll(".wc-panel").forEach(p => {
      p.classList.remove("wc-panel--open");
      p.setAttribute("aria-hidden", "true");
    });
  }

  function renderWidgetList() {
    const list = document.getElementById("wc-list");
    const count = document.getElementById("wc-count");
    if (!list || !count) return;

    count.textContent = String(words.length);

    list.innerHTML = "";
    for (const stored of words) {
      const li = document.createElement("li");
      li.className = "wc-item";
      li.innerHTML = `
        <span class="wc-item-text"></span>
        <button class="wc-item-del" title="Удалить">×</button>
      `;
      li.querySelector(".wc-item-text").textContent = stored;
      li.querySelector(".wc-item-del").addEventListener("click", () => removeStoredWord(stored));
      list.appendChild(li);
    }
  }

  function setupDragging(widget, handle) {
    let dragging = false;
    let pointerId = null;
    let startX = 0, startY = 0;
    let originX = 0, originY = 0;

    const onMove = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const rect = widget.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      let x = originX + dx;
      let y = originY + dy;

      x = Math.max(0, Math.min(window.innerWidth - w, x));
      y = Math.max(0, Math.min(window.innerHeight - h, y));

      widget.style.left = `${x}px`;
      widget.style.top = `${y}px`;
      widgetPos = { x: Math.round(x), y: Math.round(y) };
    };

    const endDrag = (e) => {
      if (!dragging) return;
      if (e && pointerId !== null && e.pointerId !== pointerId) return;

      dragging = false;
      pointerId = null;
      widget.classList.remove("wc-widget--dragging");

      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", endDrag, true);

      savePos();
    };

    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target && (e.target.closest("button") || e.target.closest("a") || e.target.closest("input") || e.target.closest("textarea"))) return;

      dragging = true;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;

      const rect = widget.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;

      widget.classList.add("wc-widget--dragging");

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", endDrag, true);
      window.addEventListener("pointercancel", endDrag, true);
      window.addEventListener("blur", endDrag, true);

      try { widget.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    widget.addEventListener("pointerup", endDrag, true);
    widget.addEventListener("pointercancel", endDrag, true);
  }

  // ---------- Wordstat tokens (+/-) ----------
  function makeTokenNode(rawWord) {
    const wrap = document.createElement("span");
    wrap.className = "wc-token";
    wrap.dataset.wcWordRaw = rawWord;

    const btn = document.createElement("button");
    btn.className = "wc-token-btn";
    btn.type = "button";

    const text = document.createElement("span");
    text.className = "wc-token-text";

    wrap.appendChild(btn);
    wrap.appendChild(text);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const raw = wrap.dataset.wcWordRaw || "";
      const key = tokenKeyFromRaw(raw);
      const base = normalizeBase(key);

      if (baseSet.has(base)) removeByBase(base);
      else addBaseWord(base);
    });

    return wrap;
  }

  function updateTokenUI(tokenEl) {
    const raw = tokenEl.dataset.wcWordRaw || "";
    const key = tokenKeyFromRaw(raw);
    const display = tokenDisplayFromRaw(raw);
    const base = normalizeBase(key);

    tokenEl.dataset.wcWordKey = key;

    const btn = tokenEl.querySelector(".wc-token-btn");
    const text = tokenEl.querySelector(".wc-token-text");

    if (text) text.textContent = display;

    if (!btn) return;

    if (baseSet.has(base)) {
      tokenEl.classList.add("wc-token--selected");
      btn.textContent = "−";
      btn.title = "Удалить из списка";
    } else {
      tokenEl.classList.remove("wc-token--selected");
      btn.textContent = "+";
      btn.title = "Добавить в список";
    }
  }

  function updateAllTokensUI() {
    document.querySelectorAll(".wc-token").forEach(updateTokenUI);
  }

  function refreshTokensAfterSettingChange() {
    // Update token display & matching based on settings.stripPlusInPhrases
    updateAllTokensUI();
  }

  function processPhraseAnchor(a) {
    if (!a || a.dataset.wcProcessed === "1") return;
    const phrase = (a.textContent || "").trim();
    if (!phrase) return;

    const parts = splitWords(phrase);
    if (parts.length <= 1) return;

    a.dataset.wcProcessed = "1";

    a.textContent = "";
    for (let i = 0; i < parts.length; i++) {
      const token = makeTokenNode(parts[i]);
      a.appendChild(token);
      if (i < parts.length - 1) a.appendChild(document.createTextNode(" "));
      updateTokenUI(token);
    }
  }

  function scanAndInject() {
    const anchors = document.body.querySelectorAll("a");
    anchors.forEach(a => {
      if (a.closest("#wc-widget")) return;
      const txt = (a.textContent || "").trim();
      if (!txt) return;
      if (txt.length > 80) return;
      if (!/\s/.test(txt)) return;
      if (txt.split(/\s+/).length < 2) return;
      if (a.closest("header, nav")) return;

      processPhraseAnchor(a);
    });
  }

  function installObserver() {
    const obs = new MutationObserver((mutations) => {
      let should = false;
      for (const m of mutations) {
        if (m.type === "childList" && (m.addedNodes?.length || m.removedNodes?.length)) { should = true; break; }
        if (m.type === "characterData") { should = true; break; }
      }
      if (should) {
        clearTimeout(installObserver._t);
        installObserver._t = setTimeout(() => {
          scanAndInject();
          updateAllTokensUI();
        }, 120);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ---------- Boot ----------
  function boot() {
    chrome.storage.local.get([STORAGE_KEYS.WORDS, STORAGE_KEYS.POS, STORAGE_KEYS.COLLAPSED, STORAGE_KEYS.SETTINGS], (res) => {
      words = Array.isArray(res[STORAGE_KEYS.WORDS]) ? res[STORAGE_KEYS.WORDS] : [];
      rebuildIndex();

      const savedPos = res[STORAGE_KEYS.POS];
      if (savedPos && typeof savedPos.x === "number" && typeof savedPos.y === "number") {
        widgetPos = savedPos;
      }

      isCollapsed = !!res[STORAGE_KEYS.COLLAPSED];

      const savedSettings = res[STORAGE_KEYS.SETTINGS];
      if (savedSettings && typeof savedSettings === "object") {
        settings = { ...defaultSettings, ...savedSettings };
      }

      buildWidget();

      // Apply settings checkboxes (widget built after settings loaded)
      const w = document.getElementById("wc-widget");
      if (w) {
        const strip = w.querySelector("#wc-set-stripplus");
        const bang = w.querySelector("#wc-set-bang");
        const plus = w.querySelector("#wc-set-plus");
        if (strip) strip.checked = !!settings.stripPlusInPhrases;
        if (bang) bang.checked = !!settings.addBangPrefix;
        if (plus) plus.checked = !!settings.addPlusPrefix;
      }

      scanAndInject();
      installObserver();
      updateAllTokensUI();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
