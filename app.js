/* ============================================================
   app.js — Fena Ekip Sticker Takip
   Firebase Realtime Database senkron, hash router, tüm ekranlar.
   ============================================================ */

// ---------- Firebase kurulumu ----------
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- Yerel cache (Firebase'den canlı güncellenir) ----------
const cache = { stickers: {}, swapCounts: {}, colors: {} };
const loaded = { stickers: false, swapCounts: false, colors: false };

let activeCollector = null; // son ziyaret edilen panelin sahibi (bu oturumda arama için)
const undoStacks = {}; // collector -> [{code, prevStatus, prevSwap}]
let firstRenderDone = false;
let modalState = null; // { collector, code, draftStatus, draftSwap } — aktif modal (varsa)
let swapFinderTarget = null; // Swap Finder sekmesinde seçili karşılaştırma kişisi
const tradeStates = {}; // collector -> { stage: 'intro'|'building'|'summary', selectedSwap:Set, selectedMissing:Set }


db.ref("/stickers").on("value", (snap) => {
  cache.stickers = snap.val() || {};
  loaded.stickers = true;
  tryRender();
});
db.ref("/swapCounts").on("value", (snap) => {
  cache.swapCounts = snap.val() || {};
  loaded.swapCounts = true;
  tryRender();
});
db.ref("/colors").on("value", (snap) => {
  cache.colors = snap.val() || {};
  loaded.colors = true;
  tryRender();
});

function tryRender() {
  if (!(loaded.stickers && loaded.swapCounts && loaded.colors)) return;
  render();
  firstRenderDone = true;
}

// ---------- Veri erişim yardımcıları ----------
function getStatus(collector, code) {
  return (cache.stickers[collector] && cache.stickers[collector][code]) || "missing";
}
function getSwapCount(collector, code) {
  return (cache.swapCounts[collector] && cache.swapCounts[collector][code]) || 0;
}
function getColor(collector) {
  return (cache.colors && cache.colors[collector]) || null;
}

function computeStats(collector) {
  let missing = 0;
  let swapExtra = 0;
  for (const code in STICKER_INDEX) {
    const st = getStatus(collector, code);
    if (st === "missing") missing++;
    else if (st === "swap") swapExtra += getSwapCount(collector, code) || 1;
  }
  const inserted = TOTAL_STICKERS - missing;
  const owned = inserted + swapExtra;
  const pct = (inserted / TOTAL_STICKERS) * 100;
  return { missing, inserted, owned, swapExtra, pct };
}

function codesCompletion(codes, collector) {
  let missing = 0;
  for (const code of codes) if (getStatus(collector, code) === "missing") missing++;
  return { total: codes.length, missing, pct: ((codes.length - missing) / codes.length) * 100 };
}

function totalSwapPool() {
  let total = 0;
  for (const collector of COLLECTORS) {
    for (const code in STICKER_INDEX) {
      if (getStatus(collector, code) === "swap") total++;
    }
  }
  return total;
}

// ---------- Yazma işlemleri ----------
function pushUndo(collector, code, prevStatus, prevSwap) {
  if (!undoStacks[collector]) undoStacks[collector] = [];
  undoStacks[collector].push({ code, prevStatus, prevSwap });
  if (undoStacks[collector].length > 3) undoStacks[collector].shift();
}

function applyLocal(collector, code, status, swapCount) {
  if (!cache.stickers[collector]) cache.stickers[collector] = {};
  if (!cache.swapCounts[collector]) cache.swapCounts[collector] = {};
  cache.stickers[collector][code] = status;
  if (status === "swap") cache.swapCounts[collector][code] = swapCount || 1;
  else delete cache.swapCounts[collector][code];
}

function setStatus(collector, code, status, swapCount, opts) {
  const prevStatus = getStatus(collector, code);
  const prevSwap = getSwapCount(collector, code);
  pushUndo(collector, code, prevStatus, prevSwap);

  applyLocal(collector, code, status, swapCount);

  const updates = {};
  updates[`/stickers/${collector}/${code}`] = status;
  updates[`/swapCounts/${collector}/${code}`] = status === "swap" ? (swapCount || 1) : null;

  db.ref().update(updates)
    .then(() => showToast("Kaydedildi ✓"))
    .catch(() => showToast("Bağlantı sorunu, tekrar deneyin", true));

  if (!opts || !opts.silentRender) render();
}

function undoLast(collector) {
  const stack = undoStacks[collector] || [];
  if (!stack.length) return;
  const last = stack.pop();
  applyLocal(collector, last.code, last.prevStatus, last.prevSwap);
  const updates = {};
  updates[`/stickers/${collector}/${last.code}`] = last.prevStatus;
  updates[`/swapCounts/${collector}/${last.code}`] = last.prevStatus === "swap" ? (last.prevSwap || 1) : null;
  db.ref().update(updates)
    .then(() => showToast("Geri alındı ✓"))
    .catch(() => showToast("Bağlantı sorunu, tekrar deneyin", true));
  render();
}

function setColor(collector, hex) {
  cache.colors[collector] = hex;
  db.ref(`/colors/${collector}`).set(hex).catch(() => showToast("Bağlantı sorunu, tekrar deneyin", true));
}

// ---------- Router ----------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return { view: "home" };
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter((p) => p.length).map(decodeURIComponent);
  if (parts.length === 0) return { view: "home" };
  const collector = parts[0];
  if (!COLLECTORS.includes(collector)) return { view: "home" };
  activeCollector = collector;
  if (parts.length === 1) return { view: "panel-entry", collector };
  const second = parts[1];
  if (second === "renk") return { view: "color-edit", collector };
  if (second === "grup") {
    const g = parts[2];
    const countryCode = parts[3];
    if (countryCode) return { view: "country", collector, group: g, countryCode, highlight: params.get("h") };
    return { view: "group", collector, group: g };
  }
  if (second === "swap-stickers") return { view: "swapstickers", collector, highlight: params.get("h") };
  if (["groups", "fwc", "missing", "swap", "trade"].includes(second)) {
    return { view: second, collector, highlight: params.get("h") };
  }
  return { view: "groups", collector };
}

function go(hash) {
  location.hash = hash;
}
function collectorHash(c) { return `#/${encodeURIComponent(c)}`; }

window.addEventListener("hashchange", render);

// ---------- Küçük yardımcılar ----------
function pctLabel(p) { return `${p.toFixed(1)}%`; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function groupTone(index) {
  // 12 grup için hafif yeşil-antrasit ton varyasyonu
  const light = 9 + index * 1.5;
  return `hsl(150, 32%, ${light}%)`;
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg, isError) {
  const root = document.getElementById("toast-root");
  root.innerHTML = `<div class="toast ${isError ? "error" : ""}" id="toast-el">${esc(msg)}</div>`;
  const el = document.getElementById("toast-el");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, isError ? 2400 : 1600);
}

// ---------- Konfeti ----------
function fireConfetti() {
  const colors = ["#3ddc84", "#e6b649", "#e0574f", "#4fa8e0", "#c179e0", "#f2f2f2"];
  const n = 36;
  for (let i = 0; i < n; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (1.6 + Math.random() * 1.2) + "s";
    piece.style.opacity = "0.9";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3000);
  }
}

// ---------- Modal ----------
function openCardModal(collector, code) {
  modalState = { collector, code, draftStatus: getStatus(collector, code), draftSwap: getSwapCount(collector, code) || 1 };
  renderModal();
}
function closeModal() {
  modalState = null;
  document.getElementById("modal-root").innerHTML = "";
}

function renderModal() {
  const root = document.getElementById("modal-root");
  if (!modalState) { root.innerHTML = ""; return; }
  const { collector, code, draftStatus, draftSwap } = modalState;
  const meta = STICKER_INDEX[code];
  const label = meta.group === "FWC" ? "⚽ FWC" : `${meta.flag} ${meta.countryName}`;

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3>${esc(code)}</h3>
        <div class="modal-sub">${esc(label)}</div>
        <div class="status-options">
          <button class="status-opt ${draftStatus === "missing" ? "selected missing" : ""}" data-st="missing">Missing ${draftStatus === "missing" ? "✓" : ""}</button>
          <button class="status-opt ${draftStatus === "owned" ? "selected owned" : ""}" data-st="owned">Owned ${draftStatus === "owned" ? "✓" : ""}</button>
          <button class="status-opt ${draftStatus === "swap" ? "selected swap" : ""}" data-st="swap">Swap ${draftStatus === "swap" ? "✓" : ""}</button>
        </div>
        <div class="swap-counter ${draftStatus === "swap" ? "visible" : ""}" id="swap-counter">
          <button id="swap-minus">−</button>
          <span class="count" id="swap-count-val">${draftSwap}</span>
          <button id="swap-plus">+</button>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" id="modal-cancel">Vazgeç</button>
          <button class="btn-primary" id="modal-confirm">Onayla</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  root.querySelectorAll(".status-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      modalState.draftStatus = btn.dataset.st;
      if (modalState.draftStatus === "swap" && !modalState.draftSwap) modalState.draftSwap = 1;
      renderModal();
    });
  });
  const plus = document.getElementById("swap-plus");
  const minus = document.getElementById("swap-minus");
  if (plus) plus.addEventListener("click", () => {
    modalState.draftSwap = Math.min(10, (modalState.draftSwap || 1) + 1);
    renderModal();
  });
  if (minus) minus.addEventListener("click", () => {
    modalState.draftSwap = Math.max(0, (modalState.draftSwap || 1) - 1);
    renderModal();
  });
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-confirm").addEventListener("click", () => {
    const { collector, code, draftStatus, draftSwap } = modalState;
    const wasComplete100 = checkContainerComplete(collector, code);
    setStatus(collector, code, draftStatus, draftStatus === "swap" ? (draftSwap || 1) : null);
    if (draftStatus === "owned") fireConfetti();
    else {
      const nowComplete = checkContainerComplete(collector, code);
      if (nowComplete && !wasComplete100) fireConfetti();
    }
    closeModal();
  });
}

// bir kartın ait olduğu ülke/FWC bloğunun tamamlanıp tamamlanmadığını kontrol eder
function checkContainerComplete(collector, code) {
  const meta = STICKER_INDEX[code];
  const codes = meta.group === "FWC" ? FWC_CODE_LIST : COUNTRY_CODES[meta.countryCode];
  return codesCompletion(codes, collector).missing === 0;
}

// ============================================================
// RENDER
// ============================================================
function render() {
  if (!(loaded.stickers && loaded.swapCounts && loaded.colors)) {
    renderLoading();
    return;
  }
  const route = parseHash();
  renderBreadcrumb(route);
  renderMiniNavbar(route);

  const app = document.getElementById("app");
  switch (route.view) {
    case "home": app.innerHTML = renderHome(); attachHomeEvents(); break;
    case "panel-entry": renderPanelEntry(route); break;
    case "color-edit": app.innerHTML = renderColorScreen(route.collector, true); attachColorEvents(route.collector, true); break;
    case "groups": app.innerHTML = renderGroups(route); attachGroupsEvents(route); break;
    case "fwc": app.innerHTML = renderFwc(route); attachPanelHeaderEvents(route.collector); attachCardEvents(route.collector); scrollToHighlight(route.highlight); break;
    case "missing": app.innerHTML = renderMissing(route); attachPanelHeaderEvents(route.collector); attachCardEvents(route.collector); break;
    case "swapstickers": app.innerHTML = renderSwapStickers(route); attachPanelHeaderEvents(route.collector); attachCardEvents(route.collector); break;
    case "swap": app.innerHTML = renderSwapFinder(route); attachSwapFinderEvents(route); break;
    case "trade": app.innerHTML = renderTradeMaker(route); attachTradeMakerEvents(route); break;
    case "group": app.innerHTML = renderGroupCountries(route); attachGroupCountriesEvents(route); break;
    case "country": app.innerHTML = renderCountryCards(route); attachCountryCardsEvents(route); scrollToHighlight(route.highlight); break;
    default: app.innerHTML = renderHome(); attachHomeEvents();
  }
  renderModal();
}

function renderLoading() {
  document.getElementById("mini-navbar-wrap").innerHTML = "";
  document.getElementById("breadcrumb-wrap").innerHTML = "";
  document.getElementById("app").innerHTML = `
    <div class="ball-loader-wrap">
      <div class="ball">⚽</div>
      <div class="ball-shadow"></div>
      <div class="welcome-text">Veriler yükleniyor…</div>
    </div>`;
}

// ---------- Breadcrumb ----------
function renderBreadcrumb(route) {
  const wrap = document.getElementById("breadcrumb-wrap");
  if (route.view === "home") { wrap.innerHTML = ""; return; }
  const crumbs = [{ label: "Ana Sayfa", hash: "#/" }];
  if (route.collector) crumbs.push({ label: route.collector, hash: `${collectorHash(route.collector)}/groups` });
  if (route.view === "group" || route.view === "country") {
    crumbs.push({ label: `${route.group} Grubu`, hash: `${collectorHash(route.collector)}/grup/${route.group}` });
  }
  if (route.view === "country") {
    const name = STICKER_INDEX[COUNTRY_CODES[route.countryCode][0]].countryName;
    crumbs.push({ label: name, hash: null });
  }
  wrap.innerHTML = `<div class="breadcrumb">${crumbs.map((c, i) => {
    const isLast = i === crumbs.length - 1;
    const sep = i > 0 ? '<span class="sep">›</span>' : "";
    if (isLast || !c.hash) return `${sep}<span class="current">${esc(c.label)}</span>`;
    return `${sep}<button data-go="${esc(c.hash)}">${esc(c.label)}</button>`;
  }).join("")}</div>`;
  wrap.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
}

// ---------- Mini navbar ----------
function renderMiniNavbar(route) {
  const wrap = document.getElementById("mini-navbar-wrap");
  if (!route.collector || route.view === "panel-entry" || route.view === "color-edit") { wrap.innerHTML = ""; return; }
  const tabs = [
    { key: "groups", label: "Gruplar" },
    { key: "missing", label: "Missing Stickers" },
    { key: "swap-stickers", label: "Swap Stickers" },
    { key: "swap", label: "Swap Finder" },
    { key: "trade", label: "Trade Maker" },
  ];
  let activeKey = route.view;
  if (route.view === "group" || route.view === "country" || route.view === "fwc") activeKey = "groups";
  if (route.view === "swapstickers") activeKey = "swap-stickers";
  wrap.innerHTML = `<div class="mini-navbar">${tabs.map((t) =>
    `<button class="${t.key === activeKey ? "active" : ""}" data-tab="${t.key}">${t.label}</button>`
  ).join("")}</div>`;
  wrap.querySelectorAll("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => go(`${collectorHash(route.collector)}/${b.dataset.tab}`));
  });
}

// ---------- Home ----------
function renderHome() {
  const order = [
    COLLECTORS_LEFT[0], COLLECTORS_RIGHT[0],
    COLLECTORS_LEFT[1], COLLECTORS_RIGHT[1],
    COLLECTORS_LEFT[2], COLLECTORS_RIGHT[2],
  ];
  const boxes = order.map((c) => {
    const stats = computeStats(c);
    const color = getColor(c);
    return `<div class="collector-box" style="${color ? `--box-color:${color}` : ""}">
      <button data-collector="${esc(c)}">
        <div class="name">${esc(c)}</div>
        <div class="pct">${pctLabel(stats.pct)}</div>
      </button>
    </div>`;
  }).join("");

  const ranked = COLLECTORS.map((c) => ({ c, stats: computeStats(c) }))
    .sort((a, b) => b.stats.pct - a.stats.pct);
  let lastPct = null, rank = 0, shown = 0;
  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map((r) => {
    shown++;
    if (r.stats.pct !== lastPct) { rank = shown; lastPct = r.stats.pct; }
    const color = getColor(r.c);
    const medal = rank <= 3 ? medals[rank - 1] : "";
    return `<div class="leaderboard-row" style="${color ? `--row-color:${color}` : ""}">
      <div class="rank">${rank}.</div>
      <div class="medal">${medal}</div>
      <div class="info">
        <div class="lb-name">${esc(r.c)}</div>
        <div class="lb-stats">Owned: ${r.stats.owned} · Missing: ${r.stats.missing} · Swap: ${r.stats.swapExtra}</div>
      </div>
      <div class="lb-pct">${pctLabel(r.stats.pct)}</div>
    </div>`;
  }).join("");

  return `
    <div class="welcome-text">Hoş Geldiniz! Herkesin albümü burada.</div>
    <div class="ball-loader-wrap" style="padding:10px 0 4px;">
      <div class="ball">⚽</div>
      <div class="ball-shadow"></div>
    </div>
    <div class="collectors-grid">${boxes}</div>
    <div class="section-divider">🏆 Sıralama</div>
    <div class="leaderboard">${rows}</div>
    <div class="swap-pool">Toplam Swap Havuzu: <b>${totalSwapPool()}</b> kart</div>
  `;
}

function attachHomeEvents() {
  document.querySelectorAll("[data-collector]").forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.dataset.collector;
      go(collectorHash(c));
    });
  });
}

// ---------- Panel giriş (renk var mı kontrolü) ----------
function renderPanelEntry(route) {
  const color = getColor(route.collector);
  if (color) {
    go(`${collectorHash(route.collector)}/groups`);
    return;
  }
  document.getElementById("app").innerHTML = renderColorScreen(route.collector, false);
  attachColorEvents(route.collector, false);
}

function renderColorScreen(collector, isEdit) {
  const current = getColor(collector) || "#3ddc84";
  return `
    <div class="color-picker-screen">
      <h2>${esc(collector)} ${isEdit ? "— rengini güncelle" : "için bir renk seç"}</h2>
      <div class="welcome-text">Bu renk kutu/panel kenarlığın olarak kullanılacak.</div>
      <input type="color" id="color-input" value="${current}">
      <div>
        <button class="btn-primary" id="color-confirm">${isEdit ? "Kaydet" : "Devam Et"}</button>
      </div>
      ${isEdit ? `<div style="margin-top:14px;"><button class="btn-secondary" id="color-cancel">Vazgeç</button></div>` : ""}
    </div>
  `;
}

function attachColorEvents(collector, isEdit) {
  document.getElementById("color-confirm").addEventListener("click", () => {
    const hex = document.getElementById("color-input").value;
    setColor(collector, hex);
    go(`${collectorHash(collector)}/groups`);
  });
  const cancel = document.getElementById("color-cancel");
  if (cancel) cancel.addEventListener("click", () => go(`${collectorHash(collector)}/groups`));
}

// ---------- Panel header + undo (ortak) ----------
function panelHeaderHtml(collector, title) {
  const color = getColor(collector);
  const stack = undoStacks[collector] || [];
  return `
    <div class="panel-header" style="${color ? `--box-color:${color}` : ""}">
      <div class="who">${esc(title)}</div>
      <button class="icon-btn" id="settings-btn" title="Rengi değiştir">⚙️</button>
    </div>
    <div class="undo-bar">
      <button class="undo-btn" id="undo-btn" ${stack.length ? "" : "disabled"}>↩ Geri Al${stack.length ? ` (${stack.length})` : ""}</button>
    </div>
  `;
}
function attachPanelHeaderEvents(collector) {
  document.getElementById("settings-btn").addEventListener("click", () => go(`${collectorHash(collector)}/renk`));
  const undoBtn = document.getElementById("undo-btn");
  if (undoBtn && !undoBtn.disabled) undoBtn.addEventListener("click", () => undoLast(collector));
}

// ---------- Kart bileşeni ----------
function stickerCardHtml(collector, code, opts) {
  opts = opts || {};
  const st = getStatus(collector, code);
  const meta = STICKER_INDEX[code];
  const swapN = st === "swap" ? (getSwapCount(collector, code) || 1) : 0;
  const color = getColor(collector);
  const highlight = opts.highlight && opts.highlight.toUpperCase() === code.toUpperCase();
  const icon = meta.group === "FWC" ? "⚽" : meta.flag;
  return `<div class="sticker-card status-${st} ${highlight ? "highlight" : ""}" data-code="${esc(code)}" id="card-${esc(code)}" style="${color ? `--box-color:${color}` : ""}">
    <div>${icon}</div>
    <div>${esc(code)}</div>
    ${st === "swap" ? `<div class="swap-tag">Swap (${swapN})</div>` : ""}
  </div>`;
}

function attachCardEvents(collector) {
  document.querySelectorAll(".sticker-card").forEach((el) => {
    el.addEventListener("click", () => openCardModal(collector, el.dataset.code));
  });
}

function scrollToHighlight(code) {
  if (!code) return;
  setTimeout(() => {
    const el = document.getElementById(`card-${code}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 60);
}

// ---------- Gruplar sekmesi ----------
function renderGroups(route) {
  const { collector } = route;
  let completeGroups = 0;
  const boxes = GROUP_ORDER.map((g, idx) => {
    const stats = codesCompletion(GROUP_CODES[g], collector);
    const isComplete = stats.missing === 0;
    if (isComplete) completeGroups++;
    const countryNames = countriesInGroup(g).map((c) => c.name).join(", ");
    return `<div class="group-box ${isComplete ? "complete" : ""}" style="background:${groupTone(idx)}" data-group="${g}">
      ${isComplete ? '<div class="gol-badge">⚽ GOL!</div>' : ""}
      <div class="g-name">${g} Grubu</div>
      <div class="g-countries">${esc(countryNames)}</div>
      <div class="g-bar-track"><div class="g-bar-fill" style="width:${stats.pct}%"></div></div>
      <div class="g-pct">${pctLabel(stats.pct)}</div>
    </div>`;
  }).join("");

  const fwcStats = codesCompletion(FWC_CODE_LIST, collector);
  const fwcComplete = fwcStats.missing === 0;
  const fwcBox = `<div class="group-box fwc-tile ${fwcComplete ? "complete" : ""}" style="background:${groupTone(12)}" data-fwc="1">
      ${fwcComplete ? '<div class="gol-badge">⚽ GOL!</div>' : ""}
      <div class="g-name">⚽ FWC</div>
      <div class="g-countries">Özel Dünya Kupası kartları</div>
      <div class="g-bar-track"><div class="g-bar-fill" style="width:${fwcStats.pct}%"></div></div>
      <div class="g-pct">${pctLabel(fwcStats.pct)}</div>
    </div>`;

  return `
    ${panelHeaderHtml(collector, collector)}
    <div class="groups-summary">12 gruptan ${completeGroups}'ü tamamlandı</div>
    <div class="groups-grid">${boxes}${fwcBox}</div>
  `;
}

function attachGroupsEvents(route) {
  attachPanelHeaderEvents(route.collector);
  document.querySelectorAll("[data-group]").forEach((el) => {
    el.addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${el.dataset.group}`));
  });
  const fwcTile = document.querySelector("[data-fwc]");
  if (fwcTile) fwcTile.addEventListener("click", () => go(`${collectorHash(route.collector)}/fwc`));
}

// ---------- FWC sekmesi ----------
function renderFwc(route) {
  const { collector, highlight } = route;
  const stats = codesCompletion(FWC_CODE_LIST, collector);
  const cards = FWC_CODE_LIST.map((code) => stickerCardHtml(collector, code, { highlight })).join("");
  return `
    ${panelHeaderHtml(collector, collector)}
    <div class="groups-summary">FWC tamamlanma: ${pctLabel(stats.pct)} ${stats.missing === 0 ? "⚽ GOL!" : ""}</div>
    <div class="fwc-grid">${cards}</div>
  `;
}

// ---------- Grup içi ülkeler ----------
function renderGroupCountries(route) {
  const { collector, group } = route;
  const countries = countriesInGroup(group);
  const boxes = countries.map((c) => {
    const stats = codesCompletion(COUNTRY_CODES[c.code], collector);
    const flag = countryFlag(c.name);
    return `<div class="country-box" data-country="${c.code}">
      <div class="flag">${flag}</div>
      <div class="c-name">${esc(c.name)}</div>
      <div class="c-pct">${pctLabel(stats.pct)}</div>
    </div>`;
  }).join("");
  const prevG = prevGroupKey(group);
  const nextG = nextGroupKey(group);
  return `
    ${panelHeaderHtml(collector, `${group} Grubu`)}
    <div class="country-nav">
      <button class="nav-arrow" id="prev-group" title="${esc(prevG)} Grubu">‹</button>
      <div class="country-title">${esc(group)} Grubu</div>
      <button class="nav-arrow" id="next-group" title="${esc(nextG)} Grubu">›</button>
    </div>
    <div class="countries-grid">${boxes}</div>
  `;
}
function attachGroupCountriesEvents(route) {
  attachPanelHeaderEvents(route.collector);
  document.querySelectorAll("[data-country]").forEach((el) => {
    el.addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${route.group}/${el.dataset.country}`));
  });
  const prevG = prevGroupKey(route.group);
  const nextG = nextGroupKey(route.group);
  document.getElementById("prev-group").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${prevG}`));
  document.getElementById("next-group").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${nextG}`));
}

// ---------- Ülke kartları (20 sticker) ----------
function renderCountryCards(route) {
  const { collector, group, countryCode, highlight } = route;
  const codes = COUNTRY_CODES[countryCode];
  const name = STICKER_INDEX[codes[0]].countryName;
  const flag = countryFlag(name);
  const stats = codesCompletion(codes, collector);
  const prev = prevCountryInGroup(group, countryCode);
  const next = nextCountryInGroup(group, countryCode);
  const cards = codes.map((code) => stickerCardHtml(collector, code, { highlight })).join("");
  return `
    ${panelHeaderHtml(collector, `${group} Grubu`)}
    <div class="country-nav">
      <button class="nav-arrow" id="prev-country">‹</button>
      <div class="country-title">${flag} ${esc(name)} <span style="color:var(--green);font-size:0.9rem;">${pctLabel(stats.pct)}</span>${stats.missing === 0 ? " ⚽" : ""}</div>
      <button class="nav-arrow" id="next-country">›</button>
    </div>
    <div class="cards-grid">${cards}</div>
    <input type="hidden" id="prev-code" value="${prev ? prev.code : ""}">
    <input type="hidden" id="next-code" value="${next ? next.code : ""}">
  `;
}
function attachCountryCardsEvents(route) {
  attachPanelHeaderEvents(route.collector);
  attachCardEvents(route.collector);
  const prev = document.getElementById("prev-code").value;
  const next = document.getElementById("next-code").value;
  if (prev) document.getElementById("prev-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${route.group}/${prev}`));
  if (next) document.getElementById("next-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${route.group}/${next}`));
}

// ---------- Ortak: durum bazlı ülke blokları (Missing / Swap Stickers / Trade Maker ortak kullanır) ----------
function collectStatusBlocks(collector, status) {
  const blocks = [];
  for (const g of GROUP_ORDER) {
    for (const [name, code] of GROUPS[g]) {
      const codes = COUNTRY_CODES[code].filter((c) => getStatus(collector, c) === status);
      if (codes.length) blocks.push({ title: `${countryFlag(name)} ${name}`, codes });
    }
  }
  const fwcCodes = FWC_CODE_LIST.filter((c) => getStatus(collector, c) === status);
  if (fwcCodes.length) blocks.push({ title: "⚽ FWC", codes: fwcCodes });
  return blocks;
}

// ---------- Missing Stickers sekmesi ----------
function renderMissing(route) {
  const { collector } = route;
  const blocks = collectStatusBlocks(collector, "missing");
  const html = blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)} — ${b.codes.length} eksik</div>
      <div class="cards-grid">${b.codes.map((c) => stickerCardHtml(collector, c)).join("")}</div>
    </div>`).join("");
  return `
    ${panelHeaderHtml(collector, collector)}
    ${blocks.length ? html : `<div class="missing-empty-all">🎉 Hiç eksik sticker yok, albüm tam!</div>`}
  `;
}

// ---------- Swap Stickers sekmesi (kendi swap'a açık kartların, ülkelere göre) ----------
function renderSwapStickers(route) {
  const { collector, highlight } = route;
  const blocks = collectStatusBlocks(collector, "swap");
  const html = blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)} — ${b.codes.length} swap'ta</div>
      <div class="cards-grid">${b.codes.map((c) => stickerCardHtml(collector, c, { highlight })).join("")}</div>
    </div>`).join("");
  return `
    ${panelHeaderHtml(collector, collector)}
    ${blocks.length ? html : `<div class="missing-empty-all">Şu an swap'ta işaretlenmiş bir kartın yok.</div>`}
  `;
}

// ---------- Swap Finder sekmesi ----------
function renderSwapFinder(route) {
  const { collector } = route;
  const others = COLLECTORS.filter((c) => c !== collector);
  if (!swapFinderTarget || !others.includes(swapFinderTarget)) swapFinderTarget = others[0];

  const selectBtns = others.map((c) =>
    `<button class="${c === swapFinderTarget ? "active" : ""}" data-target="${esc(c)}">${esc(c)}</button>`
  ).join("");

  const mine = buildSwapList(collector, swapFinderTarget);
  const theirs = buildSwapList(swapFinderTarget, collector);

  const emptyMsg = `<div class="swap-empty-msg">Bu ikilide takas fırsatı yok, ikiniz de birbirine denk gelmiyorsunuz ⚽</div>`;

  return `
    ${panelHeaderHtml(collector, collector)}
    <div class="swap-finder-select">${selectBtns}</div>
    <div class="swap-pair-block">
      <div class="sp-title mine">Sen → ${esc(swapFinderTarget)}</div>
      <div class="swap-opp-list">${mine.length ? mine.map((o) => swapOppRow(o, true)).join("") : ""}</div>
      ${mine.length === 0 ? emptyMsg : ""}
    </div>
    <div class="swap-pair-block">
      <div class="sp-title">${esc(swapFinderTarget)} → Sen</div>
      <div class="swap-opp-list">${theirs.length ? theirs.map((o) => swapOppRow(o, false)).join("") : ""}</div>
      ${theirs.length === 0 ? emptyMsg : ""}
    </div>
  `;
}

function buildSwapList(owner, needer) {
  const list = [];
  for (const code in STICKER_INDEX) {
    if (getStatus(owner, code) === "swap" && getStatus(needer, code) === "missing") {
      const n = getSwapCount(owner, code) || 1;
      for (let i = 0; i < n; i++) list.push(code);
    }
  }
  return list;
}

function swapOppRow(code, clickable) {
  const meta = STICKER_INDEX[code];
  const icon = meta.group === "FWC" ? "⚽" : meta.flag;
  const label = meta.group === "FWC" ? "FWC" : meta.countryName;
  if (clickable) {
    return `<div class="swap-opp-row"><button data-code="${esc(code)}">${icon} <b>${esc(code)}</b> <span style="color:var(--text-faint)">${esc(label)}</span></button></div>`;
  }
  return `<div class="swap-opp-row">${icon} <b>${esc(code)}</b> <span style="color:var(--text-faint)">${esc(label)}</span></div>`;
}

function attachSwapFinderEvents(route) {
  attachPanelHeaderEvents(route.collector);
  document.querySelectorAll("[data-target]").forEach((b) => {
    b.addEventListener("click", () => { swapFinderTarget = b.dataset.target; render(); });
  });
  document.querySelectorAll(".swap-opp-row [data-code]").forEach((b) => {
    b.addEventListener("click", () => openCardModal(route.collector, b.dataset.code));
  });
}

// ---------- Trade Maker sekmesi ----------
function getTradeState(collector) {
  if (!tradeStates[collector]) {
    tradeStates[collector] = { stage: "intro", selectedSwap: new Set(), selectedMissing: new Set() };
  }
  return tradeStates[collector];
}
function resetTradeState(collector) {
  tradeStates[collector] = { stage: "intro", selectedSwap: new Set(), selectedMissing: new Set() };
}
function toggleInSet(set, code) {
  if (set.has(code)) set.delete(code); else set.add(code);
}

// Trade Maker'daki kartlar: tek tıkla direkt sepete ekler/çıkarır, modal AÇMAZ.
function cartCardHtml(code, selected) {
  const meta = STICKER_INDEX[code];
  const icon = meta.group === "FWC" ? "⚽" : meta.flag;
  return `<div class="sticker-card cart-card ${selected ? "cart-selected" : ""}" data-code="${esc(code)}">
    <div>${icon}</div>
    <div>${esc(code)}</div>
    ${selected ? '<div class="cart-check">✓ Sepette</div>' : ""}
  </div>`;
}

function renderCartBlocks(blocks, selectedSet, emptyMsg) {
  if (!blocks.length) return `<div class="swap-empty-msg">${esc(emptyMsg)}</div>`;
  return blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)}</div>
      <div class="cards-grid">${b.codes.map((c) => cartCardHtml(c, selectedSet.has(c))).join("")}</div>
    </div>`).join("");
}

function renderTradeMaker(route) {
  const { collector } = route;
  const state = getTradeState(collector);

  if (state.stage === "intro") {
    return `
      ${panelHeaderHtml(collector, collector)}
      <div class="trade-intro">
        <div class="welcome-text">Bir arkadaşınla takas yapmadan önce burada teklifini hazırla:<br>vereceğin swap kartlarını ve almak istediğin eksik kartları seç.</div>
        <button class="btn-primary" id="trade-start">+ Create a Trade</button>
      </div>
    `;
  }

  if (state.stage === "building") {
    const swapBlocks = collectStatusBlocks(collector, "swap");
    const missingBlocks = collectStatusBlocks(collector, "missing");
    const total = state.selectedSwap.size + state.selectedMissing.size;
    return `
      ${panelHeaderHtml(collector, collector)}
      <div class="trade-section-title">🔁 Swaps — vereceklerin (tıkla, seç)</div>
      <div id="trade-swap-list">${renderCartBlocks(swapBlocks, state.selectedSwap, "Swap'ta işaretli kartın yok.")}</div>
      <div class="trade-section-title">📋 Missings — almak istediklerin (tıkla, seç)</div>
      <div id="trade-missing-list">${renderCartBlocks(missingBlocks, state.selectedMissing, "Eksik kartın yok, tebrikler!")}</div>
      <div class="trade-footer">
        <div class="trade-count">${state.selectedSwap.size} swap · ${state.selectedMissing.size} missing seçili</div>
        <div class="modal-actions">
          <button class="btn-secondary" id="trade-cancel">Vazgeç</button>
          <button class="btn-primary" id="trade-finish" ${total === 0 ? "disabled" : ""}>Finish Trade</button>
        </div>
      </div>
    `;
  }

  // stage === "summary"
  const swapList = [...state.selectedSwap];
  const missingList = [...state.selectedMissing];
  return `
    ${panelHeaderHtml(collector, collector)}
    <div class="trade-summary">
      <div class="trade-section-title">📤 Vereceklerin (Swap)</div>
      <div class="cards-grid">${swapList.length ? swapList.map((c) => cartCardHtml(c, true)).join("") : '<div class="swap-empty-msg">Seçim yok</div>'}</div>
      <div class="trade-section-title">📥 Alacakların (Missing)</div>
      <div class="cards-grid">${missingList.length ? missingList.map((c) => cartCardHtml(c, true)).join("") : '<div class="swap-empty-msg">Seçim yok</div>'}</div>
      <div style="text-align:center;margin-top:20px;">
        <button class="btn-primary" id="trade-reset">Yeni Trade</button>
      </div>
    </div>
  `;
}

function attachTradeMakerEvents(route) {
  attachPanelHeaderEvents(route.collector);
  const { collector } = route;
  const state = getTradeState(collector);

  const startBtn = document.getElementById("trade-start");
  if (startBtn) startBtn.addEventListener("click", () => { state.stage = "building"; render(); });

  const cancelBtn = document.getElementById("trade-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { resetTradeState(collector); render(); });

  const finishBtn = document.getElementById("trade-finish");
  if (finishBtn) finishBtn.addEventListener("click", () => { state.stage = "summary"; render(); });

  const resetBtn = document.getElementById("trade-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => { resetTradeState(collector); render(); });

  const swapList = document.getElementById("trade-swap-list");
  if (swapList) swapList.querySelectorAll(".cart-card").forEach((el) => {
    el.addEventListener("click", () => { toggleInSet(state.selectedSwap, el.dataset.code); render(); });
  });
  const missingList = document.getElementById("trade-missing-list");
  if (missingList) missingList.querySelectorAll(".cart-card").forEach((el) => {
    el.addEventListener("click", () => { toggleInSet(state.selectedMissing, el.dataset.code); render(); });
  });
}

// ---------- Genel arama ----------
function doSearch() {
  const input = document.getElementById("search-input");
  const raw = input.value.trim().toUpperCase();
  if (!raw) return;
  const meta = STICKER_INDEX[raw];
  if (!meta) { showToast("Sticker kodu bulunamadı", true); return; }
  if (!activeCollector) { showToast("Önce bir koleksiyoncu seç", true); return; }
  if (meta.group === "FWC") {
    go(`${collectorHash(activeCollector)}/fwc?h=${raw}`);
  } else {
    go(`${collectorHash(activeCollector)}/grup/${meta.group}/${meta.countryCode}?h=${raw}`);
  }
  input.value = "";
}

document.getElementById("search-btn").addEventListener("click", doSearch);
document.getElementById("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

// ---------- Header kaydırınca kaybolur ----------
let lastScrollY = 0;
window.addEventListener("scroll", () => {
  const header = document.getElementById("site-header");
  if (!header) return;
  if (window.scrollY > 40) header.classList.add("hidden");
  else header.classList.remove("hidden");
  lastScrollY = window.scrollY;
});

// ---------- İlk render ----------
// Not: Firebase .on() callback'leri veri zaten cache'deyse senkron
// çağrılabilir; bu durumda tryRender() bu satırdan ÖNCE render()'ı
// çalıştırmış olabilir. O yüzden sadece hâlâ yüklenmemişse loading göster.
if (!firstRenderDone) renderLoading();

