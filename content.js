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

  function getPhraseFromHref(el) {
    try {
      if (!el || !el.getAttribute) return "";
      const href = el.getAttribute("href") || "";
      if (!href) return "";
      // Wordstat links often contain ?words=...
      const u = new URL(href, location.origin);
      const w = u.searchParams.get("words") || u.searchParams.get("word") || "";
      if (!w) return "";
      return decodeURIComponent(w).replace(/\+/g, " ").trim();
    } catch (_) {
      return "";
    }
  }

  function getCurrentPhrase(el) {
    // Prefer href-derived phrase when available (SPA updates href even if text was modified by us).
    const fromHref = getPhraseFromHref(el);
    if (fromHref) return fromHref;

    // Fallback: plain text content without our +/- controls
    const txt = (el.textContent || "").replace(/[+−-]/g, " ").replace(/\s+/g, " ").trim();
    return txt;
  }

  function scheduleScanBurst() {
    // Run several scans in a short burst to catch async SPA renders.
    const delays = [0, 120, 300, 700, 1200];
    delays.forEach((ms) => setTimeout(() => {
      try { scanAndInject(); } catch(_) {}
    }, ms));
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
        <button class="wc-tool wc-tool--primary" id="wc-add" title="Добавить слова вручную"><svg class="wc-ico" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M18,13 L13,13 L13,18 C13,18.55 12.55,19 12,19 C11.45,19 11,18.55 11,18 L11,13 L6,13 C5.45,13 5,12.55 5,12 C5,11.45 5.45,11 6,11 L11,11 L11,6 C11,5.45 11.45,5 12,5 C12.55,5 13,5.45 13,6 L13,11 L18,11 C18.55,11 19,11.45 19,12 C19,12.55 18.55,13 18,13 Z"/>
</svg></button>
        <button class="wc-tool" id="wc-copy" title="Копировать"><svg class="wc-ico" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M56.34 17.27C56.2654 17.1214 56.1712 16.9835 56.06 16.86L42.13 2.94C41.8438 2.66648 41.4658 2.50958 41.07 2.5H20.92C19.6159 2.50264 18.3661 3.02185 17.444 3.94395C16.5218 4.86606 16.0026 6.11595 16 7.42V10.62H12.42C11.1159 10.6226 9.86606 11.1418 8.94395 12.064C8.02185 12.9861 7.50264 14.2359 7.5 15.54V56.54C7.50264 57.8441 8.02185 59.0939 8.94395 60.016C9.86606 60.9382 11.1159 61.4574 12.42 61.46H43.08C44.3772 61.4574 45.6211 60.9437 46.542 60.0302C47.463 59.1168 47.9868 57.8771 48 56.58V53.38H51.58C52.8841 53.3774 54.1339 52.8582 55.056 51.936C55.9782 51.0139 56.4974 49.7641 56.5 48.46V17.93C56.4993 17.7005 56.4445 17.4744 56.34 17.27V17.27ZM42.57 7.62L51.38 16.42H42.57V7.62ZM45 56.62C45 57.1292 44.7977 57.6176 44.4376 57.9776C44.0776 58.3377 43.5892 58.54 43.08 58.54H12.42C11.9108 58.54 11.4224 58.3377 11.0624 57.9776C10.7023 57.6176 10.5 57.1292 10.5 56.62V15.62C10.5 15.1108 10.7023 14.6224 11.0624 14.2624C11.4224 13.9023 11.9108 13.7 12.42 13.7H16V48.46C16.0026 49.7641 16.5218 51.0139 17.444 51.936C18.3661 52.8582 19.6159 53.3774 20.92 53.38H45V56.62ZM51.58 50.42H20.92C20.6645 50.4201 20.4115 50.3691 20.1759 50.2701C19.9403 50.1711 19.7268 50.0261 19.548 49.8436C19.3692 49.661 19.2286 49.4446 19.1345 49.207C19.0404 48.9695 18.9947 48.7155 19 48.46V7.46C18.9947 7.20452 19.0404 6.95054 19.1345 6.71296C19.2286 6.47538 19.3692 6.25897 19.548 6.07642C19.7268 5.89388 19.9403 5.74886 20.1759 5.64988C20.4115 5.5509 20.6645 5.49994 20.92 5.5H39.57V17.92C39.57 18.3178 39.728 18.6994 40.0093 18.9807C40.2906 19.262 40.6722 19.42 41.07 19.42H53.5V48.42C53.5053 48.6755 53.4596 48.9295 53.3655 49.167C53.2714 49.4046 53.1308 49.621 52.952 49.8036C52.7732 49.9861 52.5597 50.1311 52.3241 50.2301C52.0885 50.3291 51.8355 50.3801 51.58 50.38V50.42Z"/>
</svg></button>
        <button class="wc-tool" id="wc-clear" title="Очистить"><svg class="wc-ico" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M57.08,13.818l-3.687-3.686c-.178-.179-.357-.357-.536-.536a.987.987,0,0,0-1.377,0l-1.715,1.715-4.118,4.118L40.69,20.386l-4.306,4.306c-.477.477-.962.95-1.439,1.428q-.557-.555-1.112-1.112a6.355,6.355,0,0,0-1.167-1.045,2.711,2.711,0,0,0-2.726.019c-.269.156-.531.322-.8.483l-2.558,1.549-.187.114a26.626,26.626,0,0,1-3.8,2.223q-.453.225-.911.436-.233.107-.466.209l-.22.1-.142.06h0c-.719.29-1.439.57-2.175.812-.785.258-1.582.483-2.388.666q-.624.142-1.256.251c-.211.036-.422.068-.633.1l-.157.02c-.129.015-.257.03-.386.043a18.67,18.67,0,0,1-2.953.071c-.267-.016-.533-.037-.8-.066l-.15-.016-.118-.014-.074-.01-.25-.038a15.827,15.827,0,0,1-1.553-.332.889.889,0,0,0-.1-.006A.81.81,0,0,0,7.71,30.6c-.024,0-.046.014-.07.016a.991.991,0,0,0-.192.045,1.092,1.092,0,0,0-.14.046.981.981,0,0,0-.218.141A1.007,1.007,0,0,0,7,30.924a.863.863,0,0,0-.12.167.82.82,0,0,0-.092.188c0,.015-.016.025-.02.04-.007.03,0,.06,0,.09a.73.73,0,0,0-.03.169,25.935,25.935,0,0,0,1.212,6.553c.007.02.01.041.018.06a25.231,25.231,0,0,0,1.872,4.362,24.552,24.552,0,0,0,1.783,2.782c.014.019.032.032.047.05a.925.925,0,0,0,.14.153c.022.019.044.038.067.056a.963.963,0,0,0,.185.117.926.926,0,0,0,.188.064,1.039,1.039,0,0,0,.113.029.922.922,0,0,0,.359-.022,21.633,21.633,0,0,0,2.114-.7c-.042.033-.083.069-.125.1-.02.016-.039.033-.059.048-.231.178-.469.343-.706.511-.12.084-.237.175-.358.257a1,1,0,0,0-.35,1.333.957.957,0,0,0,.282.292,31.892,31.892,0,0,0,7.669,5.928,33.434,33.434,0,0,0,6.926,2.984h0c.708.209,1.421.394,2.141.544a19.854,19.854,0,0,0,5.074.446.984.984,0,0,0,.974-.973,23.366,23.366,0,0,1,1.185-8.7c.384-1.289.832-2.56,1.329-3.81q.151-.38.309-.758c.018-.044.115-.27.011-.027l.081-.189q.09-.211.183-.422.259-.591.535-1.174c.192-.406.387-.812.6-1.208q.633-1.038,1.265-2.075a6.235,6.235,0,0,0,1.274-2.762,3.067,3.067,0,0,0-1.134-2.314l-1.39-1.39L41.576,30.7l4.118-4.118,4.957-4.957,4.307-4.307c.7-.7,1.419-1.374,2.092-2.092l.03-.03A.99.99,0,0,0,57.08,13.818Z"/>
</svg></button>
        <button class="wc-tool" id="wc-settings" title="Настройки"><svg class="wc-ico" viewBox="0 0 100.25 100.25" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M50,30.5c-10.201,0-18.5,8.299-18.5,18.5S39.799,67.5,50,67.5S68.5,59.201,68.5,49S60.201,30.5,50,30.5z M50,64.5
  c-8.547,0-15.5-6.953-15.5-15.5S41.453,33.5,50,33.5S65.5,40.453,65.5,49S58.547,64.5,50,64.5z"/>
  <path d="M95.225,41.501L83.257,39.69c-0.658-2.218-1.547-4.372-2.651-6.425l7.176-9.733c0.44-0.597,0.378-1.426-0.146-1.951
  l-9.216-9.215c-0.525-0.524-1.354-0.587-1.951-0.147l-9.702,7.152c-2.062-1.12-4.23-2.022-6.466-2.691L58.5,4.776
  C58.389,4.042,57.759,3.5,57.017,3.5H43.985c-0.742,0-1.372,0.542-1.483,1.276L40.701,16.68c-2.236,0.669-4.404,1.572-6.466,2.691
  l-9.702-7.152c-0.597-0.44-1.426-0.378-1.951,0.147l-9.215,9.215c-0.524,0.524-0.587,1.354-0.147,1.951l7.176,9.733
  c-1.104,2.053-1.993,4.207-2.651,6.425L5.777,41.501c-0.734,0.111-1.276,0.741-1.276,1.483v13.032c0,0.742,0.542,1.372,1.275,1.483
  l12.027,1.82c0.665,2.194,1.552,4.319,2.647,6.341l-7.231,9.808c-0.44,0.597-0.377,1.426,0.147,1.951l9.215,9.215
  c0.524,0.525,1.354,0.587,1.951,0.147l9.84-7.254c2.012,1.08,4.124,1.954,6.3,2.607l1.829,12.09
  c0.111,0.734,0.741,1.276,1.483,1.276h13.032c0.742,0,1.372-0.542,1.483-1.276l1.829-12.09c2.176-0.653,4.288-1.527,6.3-2.607
  l9.84,7.254c0.597,0.44,1.426,0.377,1.951-0.147l9.216-9.215c0.524-0.524,0.587-1.354,0.146-1.951L80.55,65.66
  c1.096-2.022,1.983-4.147,2.647-6.341l12.027-1.82c0.733-0.111,1.275-0.741,1.275-1.483V42.984
  C96.5,42.243,95.958,41.612,95.225,41.501z"/>
</svg></button>
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
  <div class="wc-footer-text"><b>Word Collector</b> — открытый и бесплатный инструмент для сбора семантики в Яндекс Wordstat. Все данные хранятся <b>исключительно локально</b> в вашем браузере и никуда не передаются. Проект развивается открыто: обновления и поддержка доступны бесплатно.</div>
  <a class="wc-footer-link" href="${GITHUB_URL}" target="_blank" rel="noreferrer">GitHub</a>
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
    if (!a) return;

    const phraseNow = getCurrentPhrase(a);
    if (!phraseNow) return;

    const hasTokens = !!(a.querySelector && a.querySelector(".wc-token"));

    // If already processed and phrase didn't change, keep it.
    if (a.dataset.wcProcessed === "1" && hasTokens && a.dataset.wcPhrase === phraseNow) {
      return;
    }

    const parts = splitWords(phraseNow);
    if (parts.length <= 1) return;

    // Mark & rebuild
    a.dataset.wcProcessed = "1";
    a.dataset.wcPhrase = phraseNow;

    // Replace contents with tokenized words (rebuild even if tokens existed)
    a.textContent = "";
    for (let i = 0; i < parts.length; i++) {
      const token = makeTokenNode(parts[i]);
      a.appendChild(token);
      if (i < parts.length - 1) a.appendChild(document.createTextNode(" "));
      updateTokenUI(token);
    }
  }

  function scanAndInject() {
    const root = document.querySelector(".wordstat__search-result-content-wrapper");
    if (!root) return;

    const candidates = root.querySelectorAll("a, span");
    candidates.forEach((el) => {
      if (!el) return;
      if (el.closest && el.closest("#wc-widget")) return;

      const phrase = getCurrentPhrase(el);
      if (!phrase) return;
      if (phrase.length > 120) return;
      if (!/\s/.test(phrase)) return;
      if (phrase.split(/\s+/).length < 2) return;

      processPhraseAnchor(el);
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
  // SPA/navigation hooks
  (function installNavHooks(){
    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScanBurst();
      }
    };
    // Patch history methods
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function(){ const r=_pushState.apply(this, arguments); check(); return r; };
    history.replaceState = function(){ const r=_replaceState.apply(this, arguments); check(); return r; };
    window.addEventListener('popstate', () => check(), true);

    // When user submits search, run burst (Wordstat may update without URL change immediately)
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      const btn = t.closest ? t.closest('button') : null;
      if (btn && (btn.type === 'submit' || btn.getAttribute('aria-label') === 'Найти' || btn.getAttribute('data-testid') === 'search')) {
        scheduleScanBurst();
      }
    }, true);

    // Periodic lightweight check (failsafe)
    setInterval(check, 1200);
  })();

      updateAllTokensUI();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
