(() => {
  const STORAGE_KEYS = {
    // legacy (<=0.3.5)
    WORDS: "wc_words",
    // new bases
    PHRASES: "wc_phrases",
    MINUS: "wc_minus",
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
    addPlusPrefix: false,      // добавлять "+" при добавлении
    // UI / modes
    mode: "phrases",          // "phrases" | "minus" (default = key phrases)
    dontAskUntilPhrasesCleared: false,
    shiftHotkeyEnabled: true
  };

  let settings = { ...defaultSettings };

  // ---------- Data ----------
  let phrases = [];               // stored key phrases
  let minusWords = [];            // stored minus words (may include !/+ prefixes)

  // legacy (<=0.3.5) words list (used for one-time migration)
  let words = [];
  let widgetPos = { x: 24, y: 120 };
  let isCollapsed = false;

  // Derived fast lookup
  let phraseSet = new Set();      // normalized phrase
  let minusSet = new Set();       // normalized minus key (without !/+)
  let minusToStored = new Map();  // normalized -> stored string

  // Shift temporary mode
  let shiftDown = false;

  // ---------- Utils ----------
  function normalizeBase(word) {
    // Used to detect duplicates and highlight tokens.
    // Strips leading operator chars that we add in this tool.
    return String(word || "").replace(/^[!+]+/g, "");
  }

  function normalizePhrase(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function normalizeMinusKey(s) {
    return normalizeBase(s).toLowerCase();
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



  function rebuildPhraseIndex() {
    phraseSet = new Set();
    for (const p of phrases) {
      const key = normalizePhrase(p);
      if (key) phraseSet.add(key);
    }
  }

  function rebuildMinusIndex() {
    minusSet = new Set();
    minusToStored = new Map();
    for (const w of minusWords) {
      const key = normalizeMinusKey(w);
      if (!key) continue;
      if (!minusSet.has(key)) {
        minusSet.add(key);
        minusToStored.set(key, w);
      }
    }
  }

  function savePhrases() { chrome.storage.local.set({ [STORAGE_KEYS.PHRASES]: phrases }); }
  function saveMinus() { chrome.storage.local.set({ [STORAGE_KEYS.MINUS]: minusWords }); }
  function savePos() { chrome.storage.local.set({ [STORAGE_KEYS.POS]: widgetPos }); }
  function saveCollapsed() { chrome.storage.local.set({ [STORAGE_KEYS.COLLAPSED]: isCollapsed }); }
  function saveSettings() { chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings }); }

  function effectiveMode() {
    // Shift works only when base mode is "phrases" and hotkey enabled.
    if (settings.shiftHotkeyEnabled && settings.mode === "phrases" && shiftDown) return "minus";
    return settings.mode;
  }

  function addPhrase(phrase) {
    const key = normalizePhrase(phrase);
    if (!key) return;
    if (phraseSet.has(key)) {
      flashToast("Уже добавлено");
      return;
    }
    phrases.push(key);
    rebuildPhraseIndex();
    renderWidgetList();
    updateAllTokensUI();
    updateAllPhraseActionsUI();
    savePhrases();
  }

  function removePhrase(phrase) {
    const key = normalizePhrase(phrase);
    if (!key || !phraseSet.has(key)) return;
    phrases = phrases.filter(p => normalizePhrase(p) !== key);
    rebuildPhraseIndex();
    renderWidgetList();
    updateAllPhraseActionsUI();
    savePhrases();
  }

  function addMinusWord(wordBase) {
    const b = normalizeMinusKey(wordBase);
    if (!b) return;
    if (minusSet.has(b)) {
      flashToast("Уже добавлено");
      return;
    }
    const stored = applyPrefixes(normalizeBase(wordBase));
    minusWords.push(stored);
    rebuildMinusIndex();
    renderWidgetList();
    updateAllTokensUI();
    updateAllPhraseActionsUI();
    saveMinus();
  }

  function removeMinusByBase(wordBase) {
    const b = normalizeMinusKey(wordBase);
    if (!b || !minusSet.has(b)) return;
    const stored = minusToStored.get(b);
    minusWords = minusWords.filter(x => x !== stored);
    rebuildMinusIndex();
    renderWidgetList();
    updateAllTokensUI();
    updateAllPhraseActionsUI();
    saveMinus();
  }

  function removeStoredItem(storedValue) {
    // remove from active list
    if (settings.mode === "phrases") {
      phrases = phrases.filter(x => x !== storedValue);
      rebuildPhraseIndex();
      savePhrases();
      // clearing phrases does not happen here
    } else {
      minusWords = minusWords.filter(x => x !== storedValue);
      rebuildMinusIndex();
      saveMinus();
    }
    renderWidgetList();
    updateAllTokensUI();
    updateAllPhraseActionsUI();
  }

  function clearActiveList() {
    if (settings.mode === "phrases") {
      phrases = [];
      rebuildPhraseIndex();
      savePhrases();
      // IMPORTANT: reset "dont ask" only when phrases are cleared
      settings.dontAskUntilPhrasesCleared = false;
      saveSettings();
    } else {
      minusWords = [];
      rebuildMinusIndex();
      saveMinus();
    }
    renderWidgetList();
    updateAllTokensUI();
    updateAllPhraseActionsUI();
  }

  async function copyActiveList() {
    const text = (settings.mode === "phrases" ? phrases : minusWords).join("\n");
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

  function phraseMinusHits(phrase) {
    const toks = splitWords(phrase);
    const hits = new Set();
    for (const t of toks) {
      const key = normalizeMinusKey(tokenKeyFromRaw(t));
      if (key && minusSet.has(key)) hits.add(key);
    }
    return Array.from(hits);
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
      <div class="wc-header-top">
        <div class="wc-title">
          <span class="wc-dot"></span>
          <span>Word Collector</span>
          <span class="wc-count" id="wc-count">0</span>
        </div>
        <button class="wc-icon-btn" id="wc-toggle" title="Свернуть/развернуть">—</button>
      </div>

      <div class="wc-header-bottom">
        <div class="wc-modes" role="tablist" aria-label="Режим сбора">
          <button class="wc-mode-btn" id="wc-mode-phr" role="tab" aria-selected="true">Ключевые фразы</button>
          <button class="wc-mode-btn" id="wc-mode-min" role="tab" aria-selected="false">Минус-слова</button>
        </div>
      </div>
    `;

    const body = document.createElement("div");
    body.className = "wc-body";
    body.innerHTML = `
      <div class="wc-toolbar">
        <button class="wc-tool wc-tool--primary" id="wc-add" title="Добавить слова вручную"><svg class="wc-ico" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M18,13 L13,13 L13,18 C13,18.55 12.55,19 12,19 C11.45,19 11,18.55 11,18 L11,13 L6,13 C5.45,13 5,12.55 5,12 C5,11.45 5.45,11 6,11 L11,11 L11,6 C11,5.45 11.45,5 12,5 C12.55,5 13,5.45 13,6 L13,11 L18,11 C18.55,11 19,11.45 19,12 C19,12.55 18.55,13 18,13 Z"/>
</svg></button>
        <button class="wc-tool" id="wc-copy" title="Копировать">
          <svg class="wc-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g id="Layer_100" data-name="Layer 100"><path d="M44.84,10.5H24.9a5,5,0,0,0-5,5V42.8a5,5,0,0,0,5,5H44.84a5,5,0,0,0,5-5V15.46A5,5,0,0,0,44.84,10.5Zm2,32.3a2,2,0,0,1-2,2H24.9a2,2,0,0,1-2-2V15.46a2,2,0,0,1,2-2H44.84a2,2,0,0,1,2,2Z"></path><path d="M39.07,50.5H19.18a2,2,0,0,1-2-2V21.23a1.5,1.5,0,0,0-3,0V48.51a5,5,0,0,0,5,5H39.07A1.5,1.5,0,0,0,39.07,50.5Z"></path></g></svg>
        </button>
        <button class="wc-tool" id="wc-clear" title="Очистить">
        <svg class="wc-ico" id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><style>.cls-1{fill:#010101;}</style></defs><path class="cls-1" d="M57.08,13.818l-3.687-3.686c-.178-.179-.357-.357-.536-.536a.987.987,0,0,0-1.377,0l-1.715,1.715-4.118,4.118L40.69,20.386l-4.306,4.306c-.477.477-.962.95-1.439,1.428q-.557-.555-1.112-1.112a6.355,6.355,0,0,0-1.167-1.045,2.711,2.711,0,0,0-2.726.019c-.269.156-.531.322-.8.483l-2.558,1.549-.187.114a26.626,26.626,0,0,1-3.8,2.223q-.453.225-.911.436-.233.107-.466.209l-.22.1-.142.06h0c-.719.29-1.439.57-2.175.812-.785.258-1.582.483-2.388.666q-.624.142-1.256.251c-.211.036-.422.068-.633.1l-.157.02c-.129.015-.257.03-.386.043a18.67,18.67,0,0,1-2.953.071c-.267-.016-.533-.037-.8-.066l-.15-.016-.118-.014-.074-.01-.25-.038a15.827,15.827,0,0,1-1.553-.332.889.889,0,0,0-.1-.006A.81.81,0,0,0,7.71,30.6c-.024,0-.046.014-.07.016a.991.991,0,0,0-.192.045,1.092,1.092,0,0,0-.14.046.981.981,0,0,0-.218.141A1.007,1.007,0,0,0,7,30.924a.863.863,0,0,0-.12.167.82.82,0,0,0-.092.188c0,.015-.016.025-.02.04-.007.03,0,.06,0,.09a.73.73,0,0,0-.03.169,25.935,25.935,0,0,0,1.212,6.553c.007.02.01.041.018.06a25.231,25.231,0,0,0,1.872,4.362,24.552,24.552,0,0,0,1.783,2.782c.014.019.032.032.047.05a.925.925,0,0,0,.14.153c.022.019.044.038.067.056a.963.963,0,0,0,.185.117.926.926,0,0,0,.188.064,1.039,1.039,0,0,0,.113.029.922.922,0,0,0,.359-.022,21.633,21.633,0,0,0,2.114-.7c-.042.033-.083.069-.125.1-.02.016-.039.033-.059.048-.231.178-.469.343-.706.511-.12.084-.237.175-.358.257a1,1,0,0,0-.35,1.333.957.957,0,0,0,.282.292,31.892,31.892,0,0,0,7.669,5.928,33.434,33.434,0,0,0,6.926,2.984h0c.708.209,1.421.394,2.141.544a19.854,19.854,0,0,0,5.074.446.984.984,0,0,0,.974-.973,23.366,23.366,0,0,1,1.185-8.7c.384-1.289.832-2.56,1.329-3.81q.151-.38.309-.758c.018-.044.115-.27.011-.027l.081-.189q.09-.211.183-.422.259-.591.535-1.174c.192-.406.387-.812.6-1.208q.633-1.038,1.265-2.075a6.235,6.235,0,0,0,1.274-2.762,3.067,3.067,0,0,0-1.134-2.314l-1.39-1.39L41.576,30.7l4.118-4.118,4.957-4.957,4.307-4.307c.7-.7,1.419-1.374,2.092-2.092l.03-.03A.99.99,0,0,0,57.08,13.818ZM21.886,48.856l0,0C21.833,48.925,21.863,48.886,21.886,48.856Zm15.223-5.75a39.043,39.043,0,0,0-2.425,8.135,23.3,23.3,0,0,0-.363,4.355c-.373,0-.747-.018-1.12-.046-.326-.024-.65-.059-.974-.1l-.145-.019L31.9,55.4c-.218-.034-.436-.072-.653-.112-.572-.107-1.135-.252-1.7-.4a52.709,52.709,0,0,1,1.948-6.466.978.978,0,0,0-.68-1.2,1,1,0,0,0-1.2.68,52.622,52.622,0,0,0-1.938,6.421c-.267-.09-.538-.164-.8-.262-.822-.3-1.37-.531-2.131-.881q-1.08-.5-2.124-1.068c-.209-.114-.408-.245-.615-.363a31.5,31.5,0,0,0,3.215-4.28,27.124,27.124,0,0,0,1.584-2.855,1,1,0,0,0-.349-1.333.982.982,0,0,0-1.332.35,28.954,28.954,0,0,1-2.759,4.578c-.107.146-.215.292-.324.436l-.144.19-.1.121c-.2.261-.414.52-.628.774q-.421.505-.867.989c-.561-.364-1.117-.736-1.655-1.133-.607-.447-1.228-.944-1.88-1.518-.411-.361-.786-.76-1.174-1.146A26.431,26.431,0,0,0,20.55,42.2a1.373,1.373,0,0,0,.184-.3.948.948,0,0,0,.059-.657.908.908,0,0,0-.167-.319.971.971,0,0,0-1.256-.251,24.535,24.535,0,0,1-2.6,1.477q-.612.3-1.237.571l-.167.071-.267.11c-.18.073-.36.145-.541.214-.385.148-.774.293-1.165.426-.176.06-.354.108-.531.163a23.771,23.771,0,0,1-2.63-4.946,24.244,24.244,0,0,0,4.337-.666.974.974,0,0,0-.517-1.878q-1.044.249-2.1.407c-.239.035-.417.057-.756.092q-.393.041-.788.069c-.274.019-.55.034-.825.043a23.394,23.394,0,0,1-.782-4.013,21.109,21.109,0,0,0,9.678-.739,32.725,32.725,0,0,0,7.565-3.39c.245-.148.48-.313.721-.468l3.792,3.792,6.875,6.875,1.092,1.092C38.006,41,37.541,42.048,37.109,43.106Zm3.86-8.206a1.275,1.275,0,0,1,.1.175c0,.015.038.122.047.156,0,0,0,.023.007.042,0,.042,0,.141,0,.156a.268.268,0,0,0,0,.047s-.009,0-.024.061-.012.067-.008.065a.526.526,0,0,0-.034.054c-.022.04-.045.079-.068.118-.172.289-.35.574-.525.86l-.961,1.577-3.475-3.475-6.874-6.875-.7-.7.867-.525,1.24-.751.327-.2.046-.027c.022-.013.116-.057.146-.074.019,0,.251-.051.072-.03.062-.007.122,0,.184-.008l.047,0c.035.01.159.036.192.045l.013,0c.031.016.063.032.093.05s.057.035.085.054c.012.012.038.035.056.054s.033.034.05.051c.126.124.251.25.376.376l1.581,1.58.431.431,3.7,3.7.391.392c.855.855,1.687,1.744,2.571,2.57C40.936,34.864,40.957,34.887,40.969,34.9ZM53.988,15.533,49.87,19.651l-4.957,4.957-4.307,4.307c-.474.474-.965.944-1.443,1.423L36.327,27.5l1.027-1.027,4.117-4.118L46.428,17.4,50.735,13.1c.477-.477.961-.95,1.439-1.428q1.421,1.419,2.84,2.84Z"></path></svg></button>
        <button class="wc-tool" id="wc-settings" title="Настройки"><svg  class="wc-ico" version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100.25 100.25" style="enable-background:new 0 0 100.25 100.25;" xml:space="preserve">
<g>
  <path d="M50,30.5c-10.201,0-18.5,8.299-18.5,18.5S39.799,67.5,50,67.5S68.5,59.201,68.5,49S60.201,30.5,50,30.5z M50,64.5
    c-8.547,0-15.5-6.953-15.5-15.5S41.453,33.5,50,33.5S65.5,40.453,65.5,49S58.547,64.5,50,64.5z"></path>
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
    C96.5,42.243,95.958,41.612,95.225,41.501z M93.5,54.726l-11.703,1.771c-0.588,0.089-1.068,0.517-1.224,1.09
    c-0.704,2.595-1.748,5.095-3.103,7.432c-0.3,0.517-0.265,1.162,0.09,1.643l7.04,9.549l-7.391,7.391l-9.578-7.061
    c-0.48-0.353-1.122-0.39-1.637-0.093c-2.331,1.339-4.818,2.369-7.395,3.06c-0.575,0.155-1.005,0.635-1.094,1.225l-1.78,11.769
    H45.273l-1.78-11.769c-0.089-0.589-0.519-1.07-1.094-1.225c-2.577-0.691-5.064-1.721-7.395-3.06
    c-0.515-0.296-1.158-0.259-1.637,0.093l-9.578,7.061l-7.391-7.391l7.04-9.549c0.354-0.481,0.39-1.126,0.09-1.643
    c-1.355-2.336-2.399-4.837-3.103-7.432c-0.156-0.574-0.636-1.001-1.224-1.09L7.498,54.726V44.274l11.65-1.762
    c0.591-0.089,1.073-0.521,1.226-1.099c0.693-2.616,1.735-5.144,3.099-7.514c0.297-0.516,0.26-1.159-0.093-1.638l-6.982-9.471
    l7.391-7.391l9.443,6.961c0.481,0.354,1.126,0.39,1.644,0.089c2.375-1.38,4.916-2.437,7.55-3.142
    c0.576-0.154,1.006-0.635,1.095-1.225l1.752-11.583h10.452l1.752,11.583c0.089,0.59,0.519,1.071,1.095,1.225
    c2.634,0.705,5.174,1.762,7.55,3.142c0.517,0.302,1.162,0.265,1.644-0.089l9.443-6.961L84.6,22.79l-6.982,9.471
    c-0.353,0.479-0.39,1.122-0.093,1.638c1.363,2.37,2.406,4.898,3.099,7.514c0.153,0.578,0.635,1.009,1.226,1.099l11.65,1.762
    L93.5,54.726L93.5,54.726z"></path>
</g>
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

          <label class="wc-check">
            <input type="checkbox" id="wc-set-shift" />
            <span>Shift — быстрый сбор минус-слов (удерживать)</span>
          </label>
          <div class="wc-panel-hint">Работает в режиме «Ключевые фразы»: пока зажат Shift, можно кликом добавлять/удалять минус-слова. По умолчанию включено.</div>


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
    widget.querySelector("#wc-copy").addEventListener("click", copyActiveList);
    widget.querySelector("#wc-clear").addEventListener("click", () => { clearActiveList(); flashToast("Очищено"); });
    widget.querySelector("#wc-settings").addEventListener("click", () => togglePanel("wc-panel-settings"));
    widget.querySelector("#wc-add").addEventListener("click", () => togglePanel("wc-panel-add"));

    // Mode switch
    const modeP = widget.querySelector("#wc-mode-phr");
    const modeM = widget.querySelector("#wc-mode-min");
    modeP.addEventListener("click", () => {
      settings.mode = "phrases";
      saveSettings();
      renderWidgetList();
      updateAllTokensUI();
      updateAllPhraseActionsUI();
    });
    modeM.addEventListener("click", () => {
      settings.mode = "minus";
      saveSettings();
      renderWidgetList();
      updateAllTokensUI();
      updateAllPhraseActionsUI();
    });

    // Add panel actions
    widget.querySelector("#wc-add-apply").addEventListener("click", () => {
      const ta = widget.querySelector("#wc-add-input");
      const raw = (ta.value || "").trim();
      if (!raw) { flashToast("Пусто"); return; }
      const items = raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
      if (settings.mode === "phrases") {
        for (const it of items) addPhrase(it);
      } else {
        for (const it of items) addMinusWord(it);
      }
      ta.value = "";
      closePanels();
      flashToast("Добавлено");
    });
    widget.querySelector("#wc-add-cancel").addEventListener("click", closePanels);

    // Settings bindings
    const stripPlusEl = widget.querySelector("#wc-set-stripplus");
    const bangEl = widget.querySelector("#wc-set-bang");
    const plusEl = widget.querySelector("#wc-set-plus");
    const shiftEl = widget.querySelector("#wc-set-shift");
    stripPlusEl.checked = !!settings.stripPlusInPhrases;
    bangEl.checked = !!settings.addBangPrefix;
    plusEl.checked = !!settings.addPlusPrefix;
    if (shiftEl) shiftEl.checked = settings.shiftHotkeyEnabled !== false;

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

    if (shiftEl) {
      shiftEl.addEventListener("change", () => {
        settings.shiftHotkeyEnabled = !!shiftEl.checked;
        if (!settings.shiftHotkeyEnabled && shiftDown) shiftDown = false;
        saveSettings();
        updateAllTokensUI();
        flashToast("Сохранено");
      });
    }

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
    const modeP = document.getElementById("wc-mode-phr");
    const modeM = document.getElementById("wc-mode-min");
    const addPanelTitle = document.querySelector("#wc-panel-add .wc-panel-title");
    const addPanelHint = document.querySelector("#wc-panel-add .wc-panel-hint");
    const addPanelTextarea = document.getElementById("wc-add-input");
    if (!list || !count) return;

    const isPhrases = settings.mode === "phrases";
    const items = isPhrases ? phrases : minusWords;

    // header mode UI
    if (modeP && modeM) {
      modeP.classList.toggle("wc-mode-btn--active", isPhrases);
      modeM.classList.toggle("wc-mode-btn--active", !isPhrases);
      modeP.setAttribute("aria-selected", String(isPhrases));
      modeM.setAttribute("aria-selected", String(!isPhrases));
    }

    // add panel texts
    if (addPanelTitle) addPanelTitle.textContent = isPhrases ? "Добавить ключевые фразы" : "Добавить минус-слова";
    if (addPanelHint) addPanelHint.textContent = isPhrases
      ? "Вставь ключевые фразы столбиком или через запятую/точку с запятой."
      : "Вставь минус-слова столбиком или через запятую/точку с запятой.";
    if (addPanelTextarea) addPanelTextarea.placeholder = isPhrases
      ? "купить чехол gopro\nкрепление на шлем\nаквабокс 45м"
      : "дешево\nбесплатно\nбу";

    count.textContent = String(items.length);

    list.innerHTML = "";
    for (const stored of items) {
      const li = document.createElement("li");
      li.className = "wc-item";
      li.innerHTML = `
        <span class="wc-item-text"></span>
        <button class="wc-item-del" title="Удалить">×</button>
      `;
      li.querySelector(".wc-item-text").textContent = stored;
      li.querySelector(".wc-item-del").addEventListener("click", () => removeStoredItem(stored));
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

      // Token buttons are used to collect minus-words.
      // In phrases mode, they are active only while Shift is held.
      if (effectiveMode() !== "minus") return;

      const raw = wrap.dataset.wcWordRaw || "";
      const key = tokenKeyFromRaw(raw);
      const base = normalizeBase(key);

      if (minusSet.has(normalizeMinusKey(base))) removeMinusByBase(base);
      else addMinusWord(base);
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

    const tokenActive = (effectiveMode() === "minus");
    btn.style.display = tokenActive ? "inline-flex" : "none";
    if (!tokenActive) {
      tokenEl.classList.remove("wc-token--selected");
      return;
    }

    if (minusSet.has(normalizeMinusKey(base))) {
      tokenEl.classList.add("wc-token--selected");
      btn.textContent = "−";
      btn.title = "Удалить из минус-слов";
    } else {
      tokenEl.classList.remove("wc-token--selected");
      btn.textContent = "+";
      btn.title = "Добавить в минус-слова";
    }
  }

  function updateAllTokensUI() {
    document.querySelectorAll(".wc-token").forEach(updateTokenUI);
  }

  function refreshTokensAfterSettingChange() {
    // Update token display & matching based on settings.stripPlusInPhrases
    updateAllTokensUI();
  }

  // ---------- Phrase actions (+ / ⚠️) ----------
  function makePhraseActionsNode(phraseText) {
    const wrap = document.createElement("span");
    wrap.className = "wc-phrase-actions";
    wrap.dataset.wcPhrase = phraseText;

    const warn = document.createElement("span");
    warn.className = "wc-phrase-warn";
    warn.textContent = "⚠️";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wc-phrase-btn";

    wrap.appendChild(warn);
    wrap.appendChild(btn);

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Phrase add/remove is available only in phrases mode (not in minus mode)
      if (settings.mode !== "phrases") {
        flashToast("Переключись на ключевые фразы");
        return;
      }

      const phrase = wrap.dataset.wcPhrase || "";
      const key = normalizePhrase(phrase);
      if (!key) return;

      if (phraseSet.has(key)) {
        removePhrase(key);
        flashToast("Удалено");
        return;
      }

      const hits = phraseMinusHits(phrase);
      if (hits.length && !settings.dontAskUntilPhrasesCleared) {
        const res = await showPhraseWarningModal({ phrase: key, hits });
        if (res?.dontAsk) {
          settings.dontAskUntilPhrasesCleared = true;
          saveSettings();
        }
        if (!res?.confirmed) return;
      }

      addPhrase(key);
      flashToast("Добавлено");
    });

    return wrap;
  }

  function updatePhraseActionsUI(wrap) {
    if (!wrap) return;
    const phrase = wrap.dataset.wcPhrase || "";
    const key = normalizePhrase(phrase);
    const btn = wrap.querySelector(".wc-phrase-btn");
    const warn = wrap.querySelector(".wc-phrase-warn");
    if (!btn || !warn) return;

    // show warning if phrase contains any minus word
    const hits = phraseMinusHits(phrase);
    warn.style.display = hits.length ? "inline" : "none";
    if (hits.length) {
      warn.title = hits.length === 1
        ? `Фраза содержит минус-слово: ${hits[0]}`
        : `Фраза содержит минус-слова: ${hits.join(", ")}`;
    } else {
      warn.removeAttribute("title");
    }

    if (settings.mode !== "phrases") {
      btn.textContent = "+";
      btn.disabled = true;
      btn.title = "Переключись на ключевые фразы";
      return;
    }

    btn.disabled = false;
    if (key && phraseSet.has(key)) {
      btn.textContent = "−";
      btn.title = "Удалить ключевую фразу";
      wrap.classList.add("wc-phrase-actions--added");
    } else {
      btn.textContent = "+";
      btn.title = "Добавить ключевую фразу";
      wrap.classList.remove("wc-phrase-actions--added");
    }
  }

  function updateAllPhraseActionsUI() {
    document.querySelectorAll(".wc-phrase-actions").forEach(updatePhraseActionsUI);
  }

  function showPhraseWarningModal({ phrase, hits }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "wc-modal-backdrop";

      const modal = document.createElement("div");
      modal.className = "wc-modal";

      const hd = document.createElement("div");
      hd.className = "wc-modal-hd";
      hd.textContent = "Фраза содержит минус-слово";

      const bd = document.createElement("div");
      bd.className = "wc-modal-bd";

      const txt1 = document.createElement("div");
      txt1.className = "wc-modal-txt";
      txt1.textContent = hits.length === 1
        ? "В этой ключевой фразе найдено минус-слово:"
        : "В этой ключевой фразе найдены минус-слова:";

      const chips = document.createElement("div");
      chips.className = "wc-chips";
      hits.forEach((w) => {
        const chip = document.createElement("span");
        chip.className = "wc-chip";
        chip.textContent = w;
        chips.appendChild(chip);
      });

      const box = document.createElement("div");
      box.className = "wc-phrasebox";
      box.textContent = phrase;

      const txt2 = document.createElement("div");
      txt2.className = "wc-modal-txt";
      txt2.textContent = "Все равно добавить эту фразу?";

      const check = document.createElement("label");
      check.className = "wc-check-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const sp = document.createElement("span");
      sp.textContent = "Больше не спрашивать до очистки базы ключевых фраз";
      check.appendChild(cb);
      check.appendChild(sp);

      bd.appendChild(txt1);
      bd.appendChild(chips);
      bd.appendChild(box);
      bd.appendChild(txt2);
      bd.appendChild(check);

      const ft = document.createElement("div");
      ft.className = "wc-modal-ft";
      const cancel = document.createElement("button");
      cancel.className = "wc-btn wc-btn--ghost";
      cancel.textContent = "Отмена";
      const ok = document.createElement("button");
      ok.className = "wc-btn wc-btn--primary";
      ok.textContent = "Все равно добавить";

      ft.appendChild(cancel);
      ft.appendChild(ok);

      modal.appendChild(hd);
      modal.appendChild(bd);
      modal.appendChild(ft);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      const cleanup = () => backdrop.remove();

      cancel.addEventListener("click", () => {
        cleanup();
        resolve({ confirmed: false, dontAsk: cb.checked });
      });
      ok.addEventListener("click", () => {
        cleanup();
        resolve({ confirmed: true, dontAsk: cb.checked });
      });
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) {
          cleanup();
          resolve({ confirmed: false, dontAsk: cb.checked });
        }
      });
    });
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

    // Replace contents with tokenized words + phrase-level action
    a.textContent = "";

    // Phrase-level add/remove must be on the LEFT (at the beginning of the line)
    const actions = makePhraseActionsNode(phraseNow);
    a.appendChild(actions);
    a.appendChild(document.createTextNode(" "));

    for (let i = 0; i < parts.length; i++) {
      const token = makeTokenNode(parts[i]);
      a.appendChild(token);
      if (i < parts.length - 1) a.appendChild(document.createTextNode(" "));
      updateTokenUI(token);
    }

    updatePhraseActionsUI(actions);
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
          updateAllPhraseActionsUI();
        }, 120);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ---------- Boot ----------
  function boot() {
    chrome.storage.local.get([
      STORAGE_KEYS.PHRASES,
      STORAGE_KEYS.MINUS,
      STORAGE_KEYS.WORDS,
      STORAGE_KEYS.POS,
      STORAGE_KEYS.COLLAPSED,
      STORAGE_KEYS.SETTINGS
    ], (res) => {
      phrases = Array.isArray(res[STORAGE_KEYS.PHRASES]) ? res[STORAGE_KEYS.PHRASES] : [];
      minusWords = Array.isArray(res[STORAGE_KEYS.MINUS]) ? res[STORAGE_KEYS.MINUS] : [];

      // legacy migration: old "words" list becomes minus-words if minus list empty
      words = Array.isArray(res[STORAGE_KEYS.WORDS]) ? res[STORAGE_KEYS.WORDS] : [];
      if ((!minusWords || minusWords.length === 0) && words && words.length) {
        minusWords = [...words];
        saveMinus();
      }

      rebuildPhraseIndex();
      rebuildMinusIndex();

      const savedPos = res[STORAGE_KEYS.POS];
      if (savedPos && typeof savedPos.x === "number" && typeof savedPos.y === "number") {
        widgetPos = savedPos;
      }

      isCollapsed = !!res[STORAGE_KEYS.COLLAPSED];

      const savedSettings = res[STORAGE_KEYS.SETTINGS];
      if (savedSettings && typeof savedSettings === "object") {
        settings = { ...defaultSettings, ...savedSettings };
      }

      // Safety: ensure valid mode
      if (settings.mode !== "phrases" && settings.mode !== "minus") settings.mode = "phrases";

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
        const shift = w.querySelector("#wc-set-shift");
        if (shift) shift.checked = settings.shiftHotkeyEnabled !== false;
      }

      scanAndInject();
      installObserver();

      // Shift hotkey: temporary minus-words mode while holding Shift (only in phrases mode)
      window.addEventListener("keydown", (e) => {
        if (!settings.shiftHotkeyEnabled) return;
        if (settings.mode !== "phrases") return;
        if (e.key === "Shift" && !shiftDown) {
          shiftDown = true;
          updateAllTokensUI();
        }
      }, true);
      window.addEventListener("keyup", (e) => {
        if (e.key === "Shift") {
          if (!shiftDown) return;
          shiftDown = false;
          updateAllTokensUI();
        }
      }, true);
      window.addEventListener("blur", () => {
        if (shiftDown) {
          shiftDown = false;
          updateAllTokensUI();
        }
      }, true);
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

      renderWidgetList();
      updateAllTokensUI();
      updateAllPhraseActionsUI();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
