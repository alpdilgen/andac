/* ============================================================
   app.js — Fena Ekip Sticker Takip
   Firebase Realtime Database senkron, hash router, tüm ekranlar.
   ============================================================ */

// ---------- Firebase kurulumu ----------
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- Yerel cache (Firebase'den canlı güncellenir) ----------
const cache = { stickers: {}, swapCounts: {}, colors: {}, tradeHistory: {} };
const loaded = { stickers: false, swapCounts: false, colors: false, tradeHistory: false };

let activeCollector = null; // son ziyaret edilen panelin sahibi (bu oturumda arama için)
const undoStacks = {}; // collector -> [{code, prevStatus, prevSwap}]
let firstRenderDone = false;
let modalState = null; // { collector, code, draftStatus, draftSwap } — aktif modal (varsa)
let swapFinderTarget = null; // Swap Finder sekmesinde seçili karşılaştırma kişisi
const tradeStates = {}; // collector -> { stage, activeList, confirmArmed, showHistory, selectedSwap:Set, selectedMissing:Set }
const lastTradeLog = {}; // collector -> [{code, prevStatus, prevSwap}] (son onaylanan trade — toplu geri alma için) veya null
// Ortak Sayfa (Combo) tanımları — parseHash() bu sabite erişiyor, bu yüzden dosyanın en
// üstünde olmalı (aksi halde senkron Firebase callback'lerinde TDZ hatası oluşabilir).
const COMBO_PAIRS = [
  { key: "andac-d-berker", label: "Andaç D & Berker", members: [
    { collector: "Andaç D", tag: "A" },
    { collector: "Berker", tag: "B" },
  ] },
];


// Her .on("value") çağrısı, kendi yazdığın veriyi de Firebase'den "yankı" olarak geri
// alır. setStatus/undoLast/setColor zaten anlık optimistic render() yapıyor; birkaç yüz
// ms sonra gelen bu yankı AYNI veriyle tekrar tam bir render tetikliyordu — özellikle
// Missing/Swap Stickers gibi 400+ kartlık sayfalarda, art arda çok işlem yapınca bu
// gereksiz çift render'lar birikip kaydırma sırasında takılmaya yol açıyordu.
// Çözüm: gelen veri gerçekten değişmediyse (kendi yazdığımızın yankısıysa) render() atla.
const lastSnapshotJSON = { stickers: null, swapCounts: null, colors: null, tradeHistory: null };

function handleSnapshot(key, snap) {
  const val = snap.val() || {};
  const json = JSON.stringify(val);
  const changed = json !== lastSnapshotJSON[key];
  lastSnapshotJSON[key] = json;
  cache[key] = val;
  loaded[key] = true;
  if (changed || !firstRenderDone) tryRender();
}

db.ref("/stickers").on("value", (snap) => handleSnapshot("stickers", snap));
db.ref("/swapCounts").on("value", (snap) => handleSnapshot("swapCounts", snap));
db.ref("/colors").on("value", (snap) => handleSnapshot("colors", snap));
// Takas geçmişi — /stickers, /swapCounts, /colors'tan bağımsız, ek/yeni bir veri yolu.
// Onaylanan her trade burada bir kayıt bırakır; sadece görüntüleme amaçlı (Swap History).
db.ref("/tradeHistory").on("value", (snap) => handleSnapshot("tradeHistory", snap));

function tryRender() {
  if (!(loaded.stickers && loaded.swapCounts && loaded.colors && loaded.tradeHistory)) return;
  render();
  firstRenderDone = true;
}

// ---------- Ortak Sayfa (Combo) yardımcıları ----------
// Combo id'ler gerçek Firebase collector'ları DEĞİLDİR — sadece "combo:<key>" biçiminde
// bir routing/görüntüleme kimliğidir. Asla setStatus/setColor'a bu id ile yazılmaz;
// her yazma işlemi mutlaka gerçek üyenin (Andaç D / Berker) adıyla yapılır.
function isComboId(id) {
  return typeof id === "string" && id.startsWith("combo:");
}
function comboMembersFor(id) {
  const key = id.slice("combo:".length);
  const combo = COMBO_PAIRS.find((c) => c.key === key);
  return combo ? combo.members : [];
}
function comboDefFor(id) {
  const key = id.slice("combo:".length);
  return COMBO_PAIRS.find((c) => c.key === key) || null;
}
// Panelde başlık olarak gösterilecek isim: gerçek kişi için kendi adı, combo için etiketi.
function collectorDisplayLabel(id) {
  if (isComboId(id)) {
    const combo = comboDefFor(id);
    return combo ? combo.label : id;
  }
  return id;
}
const COMBO_COLOR = "#8a8fff"; // combo panelleri için sabit, gerçek kullanıcı renkleriyle çakışmayan ayırt edici renk

// ---------- Veri erişim yardımcıları ----------
function getStatus(collector, code) {
  if (isComboId(collector)) {
    // Birleşik mantık: biri owned ise owned (evde zaten var); değilse biri swap ise
    // swap (evde fazlalık var, ama ikisi de "sahip" değil); ikisi de yoksa missing.
    let anySwap = false;
    for (const { collector: c } of comboMembersFor(collector)) {
      const st = (cache.stickers[c] && cache.stickers[c][code]) || "missing";
      if (st === "owned") return "owned";
      if (st === "swap") anySwap = true;
    }
    return anySwap ? "swap" : "missing";
  }
  return (cache.stickers[collector] && cache.stickers[collector][code]) || "missing";
}
function getSwapCount(collector, code) {
  if (isComboId(collector)) {
    let total = 0;
    for (const { collector: c } of comboMembersFor(collector)) {
      const st = (cache.stickers[c] && cache.stickers[c][code]) || "missing";
      if (st === "swap") total += (cache.swapCounts[c] && cache.swapCounts[c][code]) || 1;
    }
    return total;
  }
  return (cache.swapCounts[collector] && cache.swapCounts[collector][code]) || 0;
}
function getColor(collector) {
  if (isComboId(collector)) return COMBO_COLOR;
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
  // Anlık (optimistic) yazmayı da "son bilinen anlık görüntü" olarak işaretle.
  // Böylece birazdan Firebase'den kendi yazdığımızın yankısı geldiğinde içerik
  // zaten eşleşiyor olur ve gereksiz bir render() tetiklenmez (bkz. handleSnapshot).
  lastSnapshotJSON.stickers = JSON.stringify(cache.stickers);
  lastSnapshotJSON.swapCounts = JSON.stringify(cache.swapCounts);
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
    .then(() => { if (!opts || !opts.silentToast) showToast("Kaydedildi ✓"); })
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
  lastSnapshotJSON.colors = JSON.stringify(cache.colors);
  db.ref(`/colors/${collector}`).set(hex).catch(() => showToast("Bağlantı sorunu, tekrar deneyin", true));
}

// ---------- Router ----------
function isValidCollectorId(id) {
  return COLLECTORS.includes(id) || isComboId(id);
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return { view: "home" };
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter((p) => p.length).map(decodeURIComponent);
  if (parts.length === 0) return { view: "home" };

  const collector = parts[0];
  if (!isValidCollectorId(collector)) return { view: "home" };
  activeCollector = collector;
  if (parts.length === 1) return { view: "panel-entry", collector };
  const second = parts[1];
  // Combo panelinde gerçek bir renk yok — "renk" rotası anlamsız, Gruplar'a düş.
  if (second === "renk") return isComboId(collector) ? { view: "groups", collector } : { view: "color-edit", collector };
  if (second === "grup") {
    const g = parts[2];
    const countryCode = parts[3];
    if (!GROUPS[g]) return { view: "groups", collector }; // geçersiz grup — çökmek yerine Gruplar'a dön
    if (countryCode) {
      if (!COUNTRY_CODES[countryCode] || STICKER_INDEX[COUNTRY_CODES[countryCode][0]].group !== g) {
        return { view: "group", collector, group: g }; // geçersiz/yanlış gruba ait ülke kodu
      }
      return { view: "country", collector, group: g, countryCode, highlight: params.get("h") };
    }
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
let activeConfettiCount = 0;
const MAX_ACTIVE_CONFETTI = 140; // art arda çok hızlı işlemde DOM'da birikmeyi önler

function fireConfetti() {
  if (activeConfettiCount >= MAX_ACTIVE_CONFETTI) return; // zaten çok fazla parça varsa yeni patlama atla
  const colors = ["#3ddc84", "#e6b649", "#e0574f", "#4fa8e0", "#c179e0", "#f2f2f2"];
  const n = 36;
  const fragment = document.createDocumentFragment();
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (1.6 + Math.random() * 1.2) + "s";
    piece.style.opacity = "0.9";
    fragment.appendChild(piece);
    pieces.push(piece);
  }
  document.body.appendChild(fragment); // tek reflow, 36 ayrı yerine
  activeConfettiCount += pieces.length;
  setTimeout(() => {
    for (const piece of pieces) piece.remove();
    activeConfettiCount -= pieces.length;
  }, 3000);
}

// ---------- Modal ----------
function openCardModal(collector, code) {
  if (isComboId(collector)) {
    // Birleşik (tek slotlu) görünümde bir kart iki farklı gerçek kişiye ait olabilir —
    // önce "kimin için değiştiriyorsun" sorulur, gerçek kişi seçilene kadar yazma yapılmaz.
    modalState = { collector, code, comboChoosing: true, realCollector: null, draftStatus: null, draftSwap: 1 };
  } else {
    modalState = { collector, code, comboChoosing: false, realCollector: collector, draftStatus: getStatus(collector, code), draftSwap: getSwapCount(collector, code) || 1 };
  }
  renderModal();
}
function closeModal() {
  modalState = null;
  document.getElementById("modal-root").innerHTML = "";
}

function renderModal() {
  const root = document.getElementById("modal-root");
  if (!modalState) { root.innerHTML = ""; return; }
  const { code } = modalState;
  const meta = STICKER_INDEX[code];
  const label = meta.group === "FWC" ? "⚽ FWC" : `${meta.flag} ${meta.countryName}`;

  if (modalState.comboChoosing) {
    const members = comboMembersFor(modalState.collector);
    const rows = members.map(({ collector: c, tag }) => {
      const st = getStatus(c, code);
      const n = st === "swap" ? (getSwapCount(c, code) || 1) : 0;
      const col = getColor(c) || "var(--text-faint)";
      return `<button class="status-opt combo-person-opt" data-real="${esc(c)}">
        <span class="cpo-name"><span class="cpo-dot" style="background:${col}"></span>(${esc(tag)}) ${esc(c)}</span>
        <span class="cpo-status">${statusLabel(st)}${st === "swap" ? ` (${n})` : ""}</span>
      </button>`;
    }).join("");
    root.innerHTML = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-box">
          <h3>${esc(code)}</h3>
          <div class="modal-sub">${esc(label)} — kimin için değiştiriyorsun?</div>
          <div class="status-options">${rows}</div>
          <div class="modal-actions">
            <button class="btn-secondary" id="modal-cancel">Vazgeç</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "modal-overlay") closeModal();
    });
    document.getElementById("modal-cancel").addEventListener("click", closeModal);
    root.querySelectorAll(".combo-person-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const real = btn.dataset.real;
        modalState.comboChoosing = false;
        modalState.realCollector = real;
        modalState.draftStatus = getStatus(real, code);
        modalState.draftSwap = getSwapCount(real, code) || 1;
        renderModal();
      });
    });
    return;
  }

  const { draftStatus, draftSwap, realCollector } = modalState;
  const comboBackBtn = isComboId(modalState.collector)
    ? `<div class="modal-sub" style="margin-top:-8px;">${esc(realCollector)} için düzenleniyor · <button class="combo-back-link" id="modal-combo-back">‹ değiştir</button></div>`
    : "";

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3>${esc(code)}</h3>
        <div class="modal-sub">${esc(label)}</div>
        ${comboBackBtn}
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
  const comboBack = document.getElementById("modal-combo-back");
  if (comboBack) comboBack.addEventListener("click", () => {
    modalState.comboChoosing = true;
    modalState.realCollector = null;
    renderModal();
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
    const { code, draftStatus, draftSwap, realCollector } = modalState;
    const wasComplete100 = checkContainerComplete(realCollector, code);
    setStatus(realCollector, code, draftStatus, draftStatus === "swap" ? (draftSwap || 1) : null);
    if (draftStatus === "owned") fireConfetti();
    else {
      const nowComplete = checkContainerComplete(realCollector, code);
      if (nowComplete && !wasComplete100) fireConfetti();
    }
    flashCard(realCollector, code);
    closeModal();
  });
}

// Durumu değişen kart, o an ekranda görünürse (örn. ülke/FWC sayfasında) kısa bir
// yeşil parlama efektiyle vurgulanır — art arda birden fazla kart işaretlerken
// "işte değişen bu" hissini verir. Kart artık listede yoksa (örn. Missing
// sekmesinden çıkarıldıysa) sessizce hiçbir şey yapmaz.
function flashCard(collector, code) {
  requestAnimationFrame(() => {
    const el = document.getElementById(`card-${safeIdPart(collector)}-${code}`);
    if (!el) return;
    el.classList.add("just-changed");
    setTimeout(() => el.classList.remove("just-changed"), 700);
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
  if (!(loaded.stickers && loaded.swapCounts && loaded.colors && loaded.tradeHistory)) {
    renderLoading();
    return;
  }
  const route = parseHash();
  renderBreadcrumb(route);
  renderMiniNavbar(route);
  updateSearchContextHint();

  const app = document.getElementById("app");
  switch (route.view) {
    case "home": app.innerHTML = renderHome(); attachHomeEvents(); break;
    case "panel-entry": renderPanelEntry(route); break;
    case "color-edit": app.innerHTML = renderColorScreen(route.collector, true); attachColorEvents(route.collector, true); break;
    case "groups": app.innerHTML = renderGroups(route); attachGroupsEvents(route); break;
    case "fwc": app.innerHTML = renderFwc(route); attachPanelHeaderEvents(route.collector); attachCardEvents(); scrollToHighlight(route.collector, route.highlight); break;
    case "missing": app.innerHTML = renderMissing(route); attachPanelHeaderEvents(route.collector); attachCardEvents(); break;
    case "swapstickers": app.innerHTML = renderSwapStickers(route); attachPanelHeaderEvents(route.collector); attachCardEvents(); break;
    case "swap": app.innerHTML = renderSwapFinder(route); attachSwapFinderEvents(route); break;
    case "trade": app.innerHTML = renderTradeMaker(route); attachTradeMakerEvents(route); break;
    case "group": app.innerHTML = renderGroupCountries(route); attachGroupCountriesEvents(route); break;
    case "country": app.innerHTML = renderCountryCards(route); attachCountryCardsEvents(route); scrollToHighlight(route.collector, route.highlight); break;
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
  if (route.collector) crumbs.push({ label: collectorDisplayLabel(route.collector), hash: `${collectorHash(route.collector)}/groups` });
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

  const comboLinks = COMBO_PAIRS.map((c) => {
    const stats = computeStats(`combo:${c.key}`);
    return `<button class="btn-secondary combo-home-link" data-combo="${esc(c.key)}">
      <span>🤝 ${esc(c.label)} — Ortak Sayfa</span>
      <span class="combo-home-pct">${pctLabel(stats.pct)}</span>
    </button>`;
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
    ${comboLinks ? `<div class="combo-links-wrap">${comboLinks}</div>` : ""}
  `;
}

function attachHomeEvents() {
  document.querySelectorAll("[data-collector]").forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.dataset.collector;
      go(collectorHash(c));
    });
  });
  document.querySelectorAll("[data-combo]").forEach((b) => {
    b.addEventListener("click", () => go(collectorHash(`combo:${b.dataset.combo}`)));
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

// 8 önceden seçilmiş, birbirinden net ayrılan renk (koyu tema üzerinde okunaklı)
const PRESET_COLORS = ["#3ddc84", "#4fa8e0", "#e0574f", "#e6b649", "#c179e0", "#f27db0", "#4fd6c5", "#f2954f"];
const colorDrafts = {}; // collector -> { hex, customOpen } — renk ekranında henüz kaydedilmemiş seçim

function getColorDraft(collector) {
  if (!colorDrafts[collector]) {
    colorDrafts[collector] = { hex: getColor(collector) || PRESET_COLORS[0], customOpen: false };
  }
  return colorDrafts[collector];
}

function renderColorScreen(collector, isEdit) {
  const draft = getColorDraft(collector);

  const usedColors = {}; // hex(küçük harf) -> sahibi (kendisi hariç herkes)
  for (const c of COLLECTORS) {
    if (c === collector) continue;
    const col = getColor(c);
    if (col) usedColors[col.toLowerCase()] = c;
  }

  const swatches = PRESET_COLORS.map((hex) => {
    const takenBy = usedColors[hex.toLowerCase()];
    const isSelected = draft.hex.toLowerCase() === hex.toLowerCase();
    return `<button class="color-swatch ${isSelected ? "selected" : ""} ${takenBy ? "taken" : ""}"
        data-hex="${hex}" ${takenBy ? "disabled" : ""} title="${takenBy ? `${esc(takenBy)}'de var` : hex}">
      <span class="cs-dot" style="background:${hex}"></span>
      ${takenBy ? `<span class="cs-taken-label">${esc(takenBy)}</span>` : ""}
    </button>`;
  }).join("");

  const isCustomHex = !PRESET_COLORS.some((p) => p.toLowerCase() === draft.hex.toLowerCase());
  const customTakenBy = isCustomHex ? usedColors[draft.hex.toLowerCase()] : null;

  return `
    <div class="color-picker-screen">
      <h2>${esc(collector)} ${isEdit ? "— rengini güncelle" : "için bir renk seç"}</h2>
      <div class="welcome-text">Bu renk kutu/panel kenarlığın olarak kullanılacak.</div>
      <div class="color-swatch-grid">${swatches}</div>
      <button class="btn-secondary" id="color-custom-toggle" style="margin-top:14px;">${draft.customOpen ? "Hazır renklere dön" : "🎨 Özel renk seç"}</button>
      ${draft.customOpen ? `
        <div style="margin-top:14px;">
          <input type="color" id="color-input-custom" value="${draft.hex}">
          ${customTakenBy ? `<div class="color-warning">⚠️ Bu renk ${esc(customTakenBy)} tarafından kullanılıyor, farklı bir renk seçmen önerilir.</div>` : ""}
        </div>
      ` : ""}
      <div style="margin-top:20px;">
        <button class="btn-primary" id="color-confirm">${isEdit ? "Kaydet" : "Devam Et"}</button>
      </div>
      ${isEdit ? `<div style="margin-top:14px;"><button class="btn-secondary" id="color-cancel">Vazgeç</button></div>` : ""}
    </div>
  `;
}

function attachColorEvents(collector, isEdit) {
  const draft = getColorDraft(collector);

  document.querySelectorAll(".color-swatch:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      draft.hex = btn.dataset.hex;
      draft.customOpen = false;
      render();
    });
  });

  const customToggle = document.getElementById("color-custom-toggle");
  if (customToggle) customToggle.addEventListener("click", () => {
    draft.customOpen = !draft.customOpen;
    render();
  });

  // "change" kullanılıyor (input değil): tarayıcının kendi renk seçici popup'ı
  // sürüklenirken her ara adımda tüm ekranı yeniden çizmek popup'ı bozabilir.
  const customInput = document.getElementById("color-input-custom");
  if (customInput) customInput.addEventListener("change", () => {
    draft.hex = customInput.value;
    render();
  });

  document.getElementById("color-confirm").addEventListener("click", () => {
    setColor(collector, draft.hex);
    delete colorDrafts[collector];
    go(`${collectorHash(collector)}/groups`);
  });
  const cancel = document.getElementById("color-cancel");
  if (cancel) cancel.addEventListener("click", () => {
    delete colorDrafts[collector];
    go(`${collectorHash(collector)}/groups`);
  });
}

// ---------- Panel header + undo (ortak) ----------
function statusLabel(st) {
  return st === "owned" ? "Owned" : st === "swap" ? "Swap" : "Missing";
}

function panelHeaderHtml(collector, title) {
  const color = getColor(collector);
  const stack = undoStacks[collector] || [];
  const last = stack[stack.length - 1];
  let preview = "";
  if (last) {
    const currentSt = getStatus(collector, last.code);
    preview = `<div class="undo-preview">${esc(last.code)}: ${statusLabel(currentSt)} → ${statusLabel(last.prevStatus)}</div>`;
  }
  const combo = isComboId(collector);
  return `
    <div class="panel-header" style="${color ? `--box-color:${color}` : ""}">
      <div class="who">${combo ? "🤝 " : ""}${esc(title)}</div>
      ${combo ? "" : `<button class="icon-btn" id="settings-btn" title="Rengi değiştir">⚙️</button>`}
    </div>
    <div class="undo-bar">
      <div class="undo-preview-wrap">${preview}</div>
      <button class="undo-btn" id="undo-btn" ${stack.length ? "" : "disabled"}>↩ Geri Al${stack.length ? ` (${stack.length})` : ""}</button>
    </div>
  `;
}
function attachPanelHeaderEvents(collector) {
  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", () => go(`${collectorHash(collector)}/renk`));
  const undoBtn = document.getElementById("undo-btn");
  if (undoBtn && !undoBtn.disabled) undoBtn.addEventListener("click", () => undoLast(collector));
}

// ---------- Kart bileşeni ----------
function safeIdPart(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function stickerCardHtml(collector, code, opts) {
  opts = opts || {};
  const st = getStatus(collector, code);
  const meta = STICKER_INDEX[code];
  const swapN = st === "swap" ? (getSwapCount(collector, code) || 1) : 0;
  const color = getColor(collector);
  const highlight = opts.highlight && opts.highlight.toUpperCase() === code.toUpperCase();
  const icon = meta.group === "FWC" ? "⚽" : meta.flag;
  const statusIcon = st === "owned" ? "✅" : st === "swap" ? "🔁" : "❌";
  const domId = `card-${safeIdPart(collector)}-${esc(code)}`;
  return `<div class="sticker-card status-${st} ${highlight ? "highlight" : ""} ${opts.tag ? "combo-card" : ""}" data-code="${esc(code)}" data-collector="${esc(collector)}" id="${domId}" style="${color ? `--box-color:${color}` : ""}" ${opts.tag ? `title="${esc(collector)}"` : ""}>
    ${opts.tag ? `<div class="combo-tag">${esc(opts.tag)}</div>` : ""}
    <div class="sc-status-badge">${statusIcon}</div>
    <div>${icon}</div>
    <div>${esc(code)}</div>
    ${st === "swap" ? `<div class="swap-tag">Swap (${swapN})</div>` : ""}
  </div>`;
}


// Kartın kendi üzerindeki data-collector'ı okur, tıklanınca DAİMA doğru gerçek
// kişinin modalını açar — combo modunda aynı ekranda farklı kartlar farklı gerçek
// kişilere ait olabileceği için parametre olarak sabit bir collector KULLANILMAZ.
function attachCardEvents() {
  document.querySelectorAll("#app .sticker-card").forEach((el) => {
    el.addEventListener("click", () => openCardModal(el.dataset.collector, el.dataset.code));
  });
}

function scrollToHighlight(collector, code) {
  if (!code) return;
  setTimeout(() => {
    const el = document.getElementById(`card-${safeIdPart(collector)}-${code}`);
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
    ${panelHeaderHtml(collector, collectorDisplayLabel(collector))}
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
    ${panelHeaderHtml(collector, collectorDisplayLabel(collector))}
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
    ${panelHeaderHtml(collector, isComboId(collector) ? `${collectorDisplayLabel(collector)} — ${group} Grubu` : `${group} Grubu`)}
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
  const prevG = prevGroupKey(group);
  const nextG = nextGroupKey(group);
  const cards = codes.map((code) => stickerCardHtml(collector, code, { highlight })).join("");
  return `
    ${panelHeaderHtml(collector, isComboId(collector) ? `${collectorDisplayLabel(collector)} — ${group} Grubu` : `${group} Grubu`)}
    <div class="country-nav">
      <button class="nav-arrow" id="prev-country">‹</button>
      <div class="country-title">${flag} ${esc(name)} <span style="color:var(--green);font-size:0.9rem;">${pctLabel(stats.pct)}</span>${stats.missing === 0 ? " ⚽" : ""}</div>
      <button class="nav-arrow" id="next-country">›</button>
    </div>
    <div class="group-nav-mini">
      <button class="nav-arrow small" id="prev-group-from-country" title="${esc(prevG)} Grubu">« ${esc(prevG)}</button>
      <span class="group-nav-label">${esc(group)} Grubu</span>
      <button class="nav-arrow small" id="next-group-from-country" title="${esc(nextG)} Grubu">${esc(nextG)} »</button>
    </div>
    <div class="cards-grid">${cards}</div>
    <input type="hidden" id="prev-code" value="${prev ? prev.code : ""}">
    <input type="hidden" id="next-code" value="${next ? next.code : ""}">
  `;
}
function attachCountryCardsEvents(route) {
  attachPanelHeaderEvents(route.collector);
  attachCardEvents();
  const prev = document.getElementById("prev-code").value;
  const next = document.getElementById("next-code").value;
  if (prev) document.getElementById("prev-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${route.group}/${prev}`));
  if (next) document.getElementById("next-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${route.group}/${next}`));

  const prevG = prevGroupKey(route.group);
  const nextG = nextGroupKey(route.group);
  const prevGFirst = countriesInGroup(prevG)[0];
  const nextGFirst = countriesInGroup(nextG)[0];
  document.getElementById("prev-group-from-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${prevG}/${prevGFirst.code}`));
  document.getElementById("next-group-from-country").addEventListener("click", () => go(`${collectorHash(route.collector)}/grup/${nextG}/${nextGFirst.code}`));
}

// ---------- Ortak: durum bazlı ülke blokları (Missing / Swap Stickers / Trade Maker ortak kullanır) ----------
// Combo id verilirse, HER üyenin kendi kartlarını ayrı ayrı (kime ait olduğu tag'iyle)
// listeler — böylece "kimin kartı" hiç belirsiz kalmaz ve düzenleme her zaman doğru
// gerçek kişiye gider. Normal tek kişilik kullanımda tag her zaman null'dur.
function collectStatusBlocks(collector, status) {
  const members = isComboId(collector) ? comboMembersFor(collector) : [{ collector, tag: null }];
  const blocks = [];
  for (const g of GROUP_ORDER) {
    for (const [name, code] of GROUPS[g]) {
      const items = [];
      for (const { collector: c, tag } of members) {
        for (const stickerCode of COUNTRY_CODES[code]) {
          if (getStatus(c, stickerCode) === status) items.push({ code: stickerCode, collector: c, tag });
        }
      }
      if (items.length) blocks.push({ title: `${countryFlag(name)} ${name}`, items });
    }
  }
  const fwcItems = [];
  for (const { collector: c, tag } of members) {
    for (const stickerCode of FWC_CODE_LIST) {
      if (getStatus(c, stickerCode) === status) fwcItems.push({ code: stickerCode, collector: c, tag });
    }
  }
  if (fwcItems.length) blocks.push({ title: "⚽ FWC", items: fwcItems });
  return blocks;
}

// ---------- Missing Stickers sekmesi ----------
function renderMissing(route) {
  const { collector } = route;
  const blocks = collectStatusBlocks(collector, "missing");
  const html = blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)} — ${b.items.length} eksik</div>
      <div class="cards-grid">${b.items.map((item) => stickerCardHtml(item.collector, item.code, { tag: item.tag })).join("")}</div>
    </div>`).join("");
  return `
    ${panelHeaderHtml(collector, collectorDisplayLabel(collector))}
    ${blocks.length ? html : `<div class="missing-empty-all">🎉 Hiç eksik sticker yok, albüm tam!</div>`}
  `;
}

// ---------- Swap Stickers sekmesi (kendi swap'a açık kartların, ülkelere göre) ----------
function renderSwapStickers(route) {
  const { collector, highlight } = route;
  const blocks = collectStatusBlocks(collector, "swap");
  const html = blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)} — ${b.items.length} swap'ta</div>
      <div class="cards-grid">${b.items.map((item) => stickerCardHtml(item.collector, item.code, { highlight, tag: item.tag })).join("")}</div>
    </div>`).join("");
  return `
    ${panelHeaderHtml(collector, collectorDisplayLabel(collector))}
    ${blocks.length ? html : `<div class="missing-empty-all">Şu an swap'ta işaretlenmiş bir kartın yok.</div>`}
  `;
}

// ---------- Swap Finder sekmesi ----------
function renderSwapFinder(route) {
  const { collector } = route;
  const exclude = isComboId(collector) ? [collector, ...comboMembersFor(collector).map((m) => m.collector)] : [collector];
  const others = COLLECTORS.filter((c) => !exclude.includes(c));
  if (!swapFinderTarget || !others.includes(swapFinderTarget)) swapFinderTarget = others[0];

  const selectBtns = others.map((c) =>
    `<button class="${c === swapFinderTarget ? "active" : ""}" data-target="${esc(c)}">${esc(c)}</button>`
  ).join("");

  const mine = buildSwapList(collector, swapFinderTarget);
  const theirs = buildSwapList(swapFinderTarget, collector);
  const mineClickable = !isComboId(collector); // combo'da merge edilmiş bir swap kartının kime ait olduğu belirsizdir, bilgi amaçlı kalır

  const emptyMsg = `<div class="swap-empty-msg">Bu ikilide takas fırsatı yok, ikiniz de birbirine denk gelmiyorsunuz ⚽</div>`;

  return `
    ${panelHeaderHtml(collector, collectorDisplayLabel(collector))}
    <div class="swap-finder-select">${selectBtns}</div>
    <div class="swap-pair-block">
      <div class="sp-title mine">Sen → ${esc(swapFinderTarget)}</div>
      <div class="swap-opp-list">${mine.length ? mine.map((o) => swapOppRow(o, mineClickable)).join("") : ""}</div>
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
  if (!isComboId(route.collector)) {
    document.querySelectorAll(".swap-opp-row [data-code]").forEach((b) => {
      b.addEventListener("click", () => openCardModal(route.collector, b.dataset.code));
    });
  }
}

// ---------- Trade Maker sekmesi ----------
function getTradeState(collector) {
  if (!tradeStates[collector]) {
    tradeStates[collector] = { stage: "intro", activeList: null, confirmArmed: false, showHistory: false, selectedSwap: new Set(), selectedMissing: new Set() };
  }
  return tradeStates[collector];
}
function resetTradeState(collector) {
  tradeStates[collector] = { stage: "intro", activeList: null, confirmArmed: false, showHistory: false, selectedSwap: new Set(), selectedMissing: new Set() };
}
function toggleInSet(set, key) {
  if (set.has(key)) set.delete(key); else set.add(key);
}

// Sepet anahtarı "gerçekKişi::kod" biçimindedir. Normal (tek kişilik) kullanımda bu
// sadece kendi adın+kod olur; combo modunda aynı kodun Andaç D'ye ve Berker'e ait iki
// AYRI girişini birbirinden ayırt etmeyi sağlar (bir Set'te bare "MEX2" tek başına yeterli olmazdı).
function cartKey(collector, code) { return `${collector}::${code}`; }
function parseCartKey(key) {
  const idx = key.indexOf("::");
  return { collector: key.slice(0, idx), code: key.slice(idx + 2) };
}
// Combo panelinde bir gerçek kişinin (A)/(B) etiketini bulur; normal kullanımda null.
function tagForRealCollector(panelCollector, realCollector) {
  if (!isComboId(panelCollector)) return null;
  const m = comboMembersFor(panelCollector).find((x) => x.collector === realCollector);
  return m ? m.tag : null;
}

// Trade Maker'daki kartlar: tek tıkla direkt sepete ekler/çıkarır, modal AÇMAZ.
function cartCardHtml(item, selected) {
  const { code, collector, tag } = item;
  const meta = STICKER_INDEX[code];
  const icon = meta.group === "FWC" ? "⚽" : meta.flag;
  const key = cartKey(collector, code);
  return `<div class="sticker-card cart-card ${selected ? "cart-selected" : ""} ${tag ? "combo-card" : ""}" data-key="${esc(key)}" ${tag ? `title="${esc(collector)}"` : ""}>
    ${tag ? `<div class="combo-tag">${esc(tag)}</div>` : ""}
    <div>${icon}</div>
    <div>${esc(code)}</div>
    ${selected ? '<div class="cart-check">✓ Sepette</div>' : ""}
  </div>`;
}

function renderCartBlocks(blocks, selectedSet, emptyMsg) {
  if (!blocks.length) return `<div class="swap-empty-msg">${esc(emptyMsg)}</div>`;
  return blocks.map((b) => `<div class="missing-country-block">
      <div class="mc-title">${esc(b.title)}</div>
      <div class="cards-grid">${b.items.map((item) => cartCardHtml(item, selectedSet.has(cartKey(item.collector, item.code)))).join("")}</div>
    </div>`).join("");
}

function containerKeyForCode(code) {
  const meta = STICKER_INDEX[code];
  return meta.group === "FWC" ? "FWC" : meta.countryCode;
}
function containerCodesForCode(code) {
  const meta = STICKER_INDEX[code];
  return meta.group === "FWC" ? FWC_CODE_LIST : COUNTRY_CODES[meta.countryCode];
}
function containerLabelForKey(key) {
  return key === "FWC" ? "⚽ FWC" : STICKER_INDEX[COUNTRY_CODES[key][0]].countryName;
}

// Bir trade onaylandığında gerçek durum değişikliklerini uygular — HER ZAMAN sepet
// anahtarındaki gerçek kişiye yazar (panel combo olsa bile asla "combo:..." kimliğine yazmaz):
// - Verilen swap kartı: swap sayısı 1 azalır; 0'a düşerse kart "owned"a döner (elindeki tek kopyan kalır)
// - Alınan missing kartı: doğrudan "owned" olur
// Ayrıca: (a) her gerçek kişi için ayrı toplu-geri-alma kaydı tutar, (b) trade sonucu
// tamamlanan ülke/grup/FWC var mı (panelin kendi — combo ise birleşik — tamamlanma durumuna göre) tespit eder.
function confirmTrade(collector, state) {
  const affectedCodes = [...state.selectedSwap, ...state.selectedMissing].map((k) => parseCartKey(k).code);
  const containersBefore = new Map(); // key -> { codes, wasComplete }
  for (const code of affectedCodes) {
    const key = containerKeyForCode(code);
    if (!containersBefore.has(key)) {
      const codes = containerCodesForCode(code);
      containersBefore.set(key, { codes, wasComplete: codesCompletion(codes, collector).missing === 0 });
    }
  }

  const logsByReal = {}; // gerçekKişi -> [{code, prevStatus, prevSwap}]
  const givenByReal = {}; // gerçekKişi -> [kod, ...]
  const receivedByReal = {}; // gerçekKişi -> [kod, ...]
  let totalChanged = 0;

  for (const key of state.selectedSwap) {
    const { collector: real, code } = parseCartKey(key);
    if (getStatus(real, code) !== "swap") continue; // arada başka yerden değişmiş olabilir, dokunma
    const prevStatus = getStatus(real, code);
    const prevSwap = getSwapCount(real, code);
    const newCount = (prevSwap || 1) - 1;
    if (newCount > 0) setStatus(real, code, "swap", newCount, { silentRender: true, silentToast: true });
    else setStatus(real, code, "owned", null, { silentRender: true, silentToast: true });
    (logsByReal[real] = logsByReal[real] || []).push({ code, prevStatus, prevSwap });
    (givenByReal[real] = givenByReal[real] || []).push(code);
    totalChanged++;
  }
  for (const key of state.selectedMissing) {
    const { collector: real, code } = parseCartKey(key);
    if (getStatus(real, code) !== "missing") continue; // arada başka yerden değişmiş olabilir, dokunma
    const prevStatus = getStatus(real, code);
    const prevSwap = getSwapCount(real, code);
    setStatus(real, code, "owned", null, { silentRender: true, silentToast: true });
    (logsByReal[real] = logsByReal[real] || []).push({ code, prevStatus, prevSwap });
    (receivedByReal[real] = receivedByReal[real] || []).push(code);
    totalChanged++;
  }

  // "Son Trade'i Geri Al" — panelin kendi kimliğinde (combo id veya gerçek isim) saklanır;
  // her girişte gerçek sahibi de taşınır ki geri alma her zaman doğru kişiye yazsın.
  const combinedLog = [];
  for (const real in logsByReal) {
    for (const entry of logsByReal[real]) combinedLog.push({ ...entry, collector: real });
  }
  lastTradeLog[collector] = combinedLog.length ? combinedLog : null;

  const newlyCompleted = [];
  for (const [key, info] of containersBefore) {
    if (!info.wasComplete && codesCompletion(info.codes, collector).missing === 0) newlyCompleted.push(key);
  }
  return { changed: totalChanged, newlyCompleted, givenByReal, receivedByReal };
}

// Son onaylanan trade'i tek seferde geri alır (undo stack'in 3 sınırından bağımsız).
// Her giriş kendi gerçek sahibine yazar (combo'dan yapılan bir trade iki farklı
// gerçek kişiyi etkilemiş olabilir).
function undoLastTrade(collector) {
  const log = lastTradeLog[collector];
  if (!log || !log.length) return;
  for (const entry of log) {
    const real = entry.collector || collector; // eski kayıtlarla geriye dönük uyumluluk
    applyLocal(real, entry.code, entry.prevStatus, entry.prevSwap);
    const updates = {};
    updates[`/stickers/${real}/${entry.code}`] = entry.prevStatus;
    updates[`/swapCounts/${real}/${entry.code}`] = entry.prevStatus === "swap" ? (entry.prevSwap || 1) : null;
    db.ref().update(updates).catch(() => showToast("Bağlantı sorunu, tekrar deneyin", true));
  }
  lastTradeLog[collector] = null;
  showToast("Son trade geri alındı ✓");
  render();
}

// Bir kişinin (combo ise İKİ kişinin birleşik) en son N takasını (yeniden eskiye) döndürür.
function getTradeHistoryList(collector, limit) {
  const members = isComboId(collector)
    ? comboMembersFor(collector).map((m) => ({ real: m.collector, tag: m.tag }))
    : [{ real: collector, tag: null }];
  const entries = [];
  for (const { real, tag } of members) {
    const raw = cache.tradeHistory[real] || {};
    for (const k in raw) entries.push({ ...raw[k], _owner: real, _tag: tag });
  }
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return entries.slice(0, limit);
}

function formatTradeTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const datePart = d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
  const timePart = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} ${timePart}`;
}

function renderTradeHistoryEntry(entry) {
  const given = (entry.given && entry.given.length) ? entry.given.join(", ") : "—";
  const received = (entry.received && entry.received.length) ? entry.received.join(", ") : "—";
  const ownerTag = entry._tag ? `<span class="combo-tag" style="position:static;display:inline-block;margin-right:6px;">${esc(entry._tag)}</span>${esc(entry._owner)} — ` : "";
  return `<div class="trade-history-entry">
    <div class="the-date">${ownerTag}${esc(formatTradeTimestamp(entry.timestamp))}</div>
    <div class="the-row"><span class="the-label out">📤 Verildi:</span> ${esc(given)}</div>
    <div class="the-row"><span class="the-label in">📥 Alındı:</span> ${esc(received)}</div>
  </div>`;
}

function renderTradeMaker(route) {
  const { collector } = route;
  const state = getTradeState(collector);
  const label = collectorDisplayLabel(collector);

  if (state.stage === "intro") {
    if (state.showHistory) {
      const history = getTradeHistoryList(collector, 5);
      return `
        ${panelHeaderHtml(collector, label)}
        <div class="trade-history">
          <div class="trade-section-title">📜 Son 5 Takas</div>
          ${history.length ? history.map(renderTradeHistoryEntry).join("") : '<div class="swap-empty-msg">Henüz takas geçmişin yok.</div>'}
          <div style="text-align:center;margin-top:16px;">
            <button class="btn-secondary" id="trade-history-back">← Geri</button>
          </div>
        </div>
      `;
    }
    const hasLastTrade = lastTradeLog[collector] && lastTradeLog[collector].length > 0;
    return `
      ${panelHeaderHtml(collector, label)}
      <div class="trade-intro">
        <div class="welcome-text">Bir arkadaşınla takas yapmadan önce burada teklifini hazırla:<br>vereceğin swap kartlarını ve almak istediğin eksik kartları seç.</div>
        <button class="btn-primary" id="trade-start">+ Create a Trade</button>
        <div style="margin-top:12px;"><button class="btn-secondary" id="trade-history-btn">📜 Swap History</button></div>
        ${hasLastTrade ? `<div style="margin-top:16px;"><button class="undo-btn" id="trade-undo-last">↩ Son Trade'i Geri Al (${lastTradeLog[collector].length} kart)</button></div>` : ""}
      </div>
    `;
  }

  if (state.stage === "building") {
    const swapBlocks = collectStatusBlocks(collector, "swap");
    const missingBlocks = collectStatusBlocks(collector, "missing");
    const total = state.selectedSwap.size + state.selectedMissing.size;
    const activeContent = state.activeList === "swap"
      ? renderCartBlocks(swapBlocks, state.selectedSwap, "Swap'ta işaretli kartın yok.")
      : state.activeList === "missing"
      ? renderCartBlocks(missingBlocks, state.selectedMissing, "Eksik kartın yok, tebrikler!")
      : `<div class="swap-empty-msg">Yukarıdan bir kategori seç, kartlar burada açılsın.</div>`;
    return `
      ${panelHeaderHtml(collector, label)}
      <div class="trade-toggle-row">
        <button class="trade-toggle-box ${state.activeList === "swap" ? "active" : ""}" data-list="swap">
          <div class="ttb-title">🔁 Swaps</div>
          <div class="ttb-count">${state.selectedSwap.size} seçili</div>
        </button>
        <button class="trade-toggle-box ${state.activeList === "missing" ? "active" : ""}" data-list="missing">
          <div class="ttb-title">📋 Missings</div>
          <div class="ttb-count">${state.selectedMissing.size} seçili</div>
        </button>
      </div>
      <div id="trade-active-list">${activeContent}</div>
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
  const swapItems = [...state.selectedSwap].map((k) => { const { collector: c, code } = parseCartKey(k); return { code, collector: c, tag: tagForRealCollector(collector, c) }; });
  const missingItems = [...state.selectedMissing].map((k) => { const { collector: c, code } = parseCartKey(k); return { code, collector: c, tag: tagForRealCollector(collector, c) }; });
  return `
    ${panelHeaderHtml(collector, label)}
    <div class="trade-summary">
      <div class="trade-section-title">📤 Vereceklerin (Swap) <span class="trade-hint">— çıkarmak için karta tıkla</span></div>
      <div class="cards-grid" id="trade-summary-swap">${swapItems.length ? swapItems.map((item) => cartCardHtml(item, true)).join("") : '<div class="swap-empty-msg">Seçim yok</div>'}</div>
      <div class="trade-section-title">📥 Alacakların (Missing) <span class="trade-hint">— çıkarmak için karta tıkla</span></div>
      <div class="cards-grid" id="trade-summary-missing">${missingItems.length ? missingItems.map((item) => cartCardHtml(item, true)).join("") : '<div class="swap-empty-msg">Seçim yok</div>'}</div>

      ${state.confirmArmed ? `
        <div class="trade-confirm-warning">Emin misin? Bu işlem kartların durumunu gerçekten değiştirir.</div>
        <div class="modal-actions" style="margin-top:10px;">
          <button class="btn-secondary" id="trade-confirm-cancel">Vazgeç</button>
          <button class="btn-primary" id="trade-confirm-yes">✅ Evet, Onayla</button>
        </div>
      ` : `
        <div class="modal-actions" style="margin-top:20px;">
          <button class="btn-secondary" id="trade-edit">✏️ Düzenle</button>
          <button class="btn-primary" id="trade-confirm" ${(swapItems.length + missingItems.length) === 0 ? "disabled" : ""}>✅ Confirm Trade</button>
        </div>
      `}
      <div style="text-align:center;margin-top:12px;">
        <button class="undo-btn" id="trade-cancel-summary">Vazgeç ve Sıfırla</button>
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

  const historyBtn = document.getElementById("trade-history-btn");
  if (historyBtn) historyBtn.addEventListener("click", () => { state.showHistory = true; render(); });

  const historyBackBtn = document.getElementById("trade-history-back");
  if (historyBackBtn) historyBackBtn.addEventListener("click", () => { state.showHistory = false; render(); });

  const undoLastBtn = document.getElementById("trade-undo-last");
  if (undoLastBtn) undoLastBtn.addEventListener("click", () => undoLastTrade(collector));

  const cancelBtn = document.getElementById("trade-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { resetTradeState(collector); render(); });

  const finishBtn = document.getElementById("trade-finish");
  if (finishBtn) finishBtn.addEventListener("click", () => { state.stage = "summary"; render(); });

  const editBtn = document.getElementById("trade-edit");
  if (editBtn) editBtn.addEventListener("click", () => { state.stage = "building"; render(); });

  const cancelSummaryBtn = document.getElementById("trade-cancel-summary");
  if (cancelSummaryBtn) cancelSummaryBtn.addEventListener("click", () => { resetTradeState(collector); render(); });

  // 1. tık: "Confirm Trade" -> uyarı moduna geçer. 2. tık: "Evet, Onayla" -> gerçekten uygular.
  const confirmBtn = document.getElementById("trade-confirm");
  if (confirmBtn) confirmBtn.addEventListener("click", () => { state.confirmArmed = true; render(); });

  const confirmCancelBtn = document.getElementById("trade-confirm-cancel");
  if (confirmCancelBtn) confirmCancelBtn.addEventListener("click", () => { state.confirmArmed = false; render(); });

  const confirmYesBtn = document.getElementById("trade-confirm-yes");
  if (confirmYesBtn) confirmYesBtn.addEventListener("click", () => {
    const result = confirmTrade(collector, state);
    // Takas geçmişi — sadece görüntüleme amaçlı, /stickers'a hiç dokunmaz.
    // Combo'dan yapılan bir trade iki farklı gerçek kişiyi etkilemiş olabilir;
    // her biri KENDİ geçmişine kaydedilir (kendi panelinden yapmış gibi).
    const realsInvolved = new Set([...Object.keys(result.givenByReal), ...Object.keys(result.receivedByReal)]);
    for (const real of realsInvolved) {
      db.ref(`/tradeHistory/${real}`).push({
        timestamp: Date.now(),
        given: result.givenByReal[real] || [],
        received: result.receivedByReal[real] || [],
      }).catch(() => {}); // geçmiş kaydı kritik değil, sessizce yut
    }
    fireConfetti();
    if (result.newlyCompleted.length) {
      const names = result.newlyCompleted.map(containerLabelForKey).join(", ");
      showToast(`Trade tamamlandı ✓ ⚽ ${names} tamamlandı!`);
    } else {
      showToast("Trade tamamlandı ✓");
    }
    resetTradeState(collector);
    render();
  });

  document.querySelectorAll(".trade-toggle-box").forEach((box) => {
    box.addEventListener("click", () => {
      state.activeList = state.activeList === box.dataset.list ? null : box.dataset.list;
      render();
    });
  });

  const activeListWrap = document.getElementById("trade-active-list");
  if (activeListWrap) {
    const targetSet = state.activeList === "swap" ? state.selectedSwap
      : state.activeList === "missing" ? state.selectedMissing
      : null;
    if (targetSet) {
      activeListWrap.querySelectorAll(".cart-card").forEach((el) => {
        el.addEventListener("click", () => { toggleInSet(targetSet, el.dataset.key); render(); });
      });
    }
  }

  // Özet ekranında bir karta tıklamak onu sepetten çıkarır (tekli çıkarma).
  const summarySwapWrap = document.getElementById("trade-summary-swap");
  if (summarySwapWrap) summarySwapWrap.querySelectorAll(".cart-card").forEach((el) => {
    el.addEventListener("click", () => { state.selectedSwap.delete(el.dataset.key); render(); });
  });
  const summaryMissingWrap = document.getElementById("trade-summary-missing");
  if (summaryMissingWrap) summaryMissingWrap.querySelectorAll(".cart-card").forEach((el) => {
    el.addEventListener("click", () => { state.selectedMissing.delete(el.dataset.key); render(); });
  });
}


// ---------- Genel arama (+ otomatik öneri) ----------
// Arama kutusunun hemen altında, aramanın hangi panel bağlamında yapılacağını gösterir
// (özellikle Ortak Sayfa'dayken hangi kişinin/combo'nun aranacağı belirsiz olabilirdi).
function updateSearchContextHint() {
  const hint = document.getElementById("search-context-hint");
  if (!hint) return;
  if (!activeCollector) { hint.innerHTML = ""; return; }
  const label = collectorDisplayLabel(activeCollector);
  const icon = isComboId(activeCollector) ? "🤝" : "👤";
  hint.innerHTML = `${icon} <b>${esc(label)}</b> panelinde aranıyor`;
}

function goToStickerCode(rawCode) {
  const code = rawCode.toUpperCase();
  const meta = STICKER_INDEX[code];
  if (!meta) { showToast("Sticker kodu bulunamadı", true); return; }
  if (!activeCollector) { showToast("Önce bir koleksiyoncu seç", true); return; }
  if (meta.group === "FWC") {
    go(`${collectorHash(activeCollector)}/fwc?h=${code}`);
  } else {
    go(`${collectorHash(activeCollector)}/grup/${meta.group}/${meta.countryCode}?h=${code}`);
  }
}

function doSearch() {
  const input = document.getElementById("search-input");
  const raw = input.value.trim();
  if (!raw) return;
  goToStickerCode(raw);
  input.value = "";
  hideSearchSuggestions();
}

function hideSearchSuggestions() {
  document.getElementById("search-suggestions").innerHTML = "";
}

function renderSearchSuggestions(rawInput) {
  const box = document.getElementById("search-suggestions");
  const q = rawInput.trim().toUpperCase();
  if (!q) { box.innerHTML = ""; return; }
  const matches = Object.keys(STICKER_INDEX)
    .filter((code) => code.startsWith(q))
    .slice(0, 8);
  if (!matches.length) { box.innerHTML = ""; return; }
  box.innerHTML = matches.map((code) => {
    const meta = STICKER_INDEX[code];
    const icon = meta.group === "FWC" ? "⚽" : meta.flag;
    const label = meta.group === "FWC" ? "FWC" : meta.countryName;
    return `<button class="search-sugg-item" data-code="${esc(code)}">
      <span>${icon}</span> <b>${esc(code)}</b> <span class="ssi-label">${esc(label)}</span>
    </button>`;
  }).join("");
  box.querySelectorAll(".search-sugg-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      goToStickerCode(btn.dataset.code);
      document.getElementById("search-input").value = "";
      hideSearchSuggestions();
    });
  });
}

const searchInputEl = document.getElementById("search-input");
document.getElementById("search-btn").addEventListener("click", doSearch);
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
  if (e.key === "Escape") { hideSearchSuggestions(); searchInputEl.blur(); }
});
searchInputEl.addEventListener("input", () => renderSearchSuggestions(searchInputEl.value));
searchInputEl.addEventListener("blur", () => {
  // Öneriye tıklama olayının işlenebilmesi için küçük bir gecikmeyle kapat
  setTimeout(hideSearchSuggestions, 150);
});

// ---------- Header kaydırınca kaybolur + yukarı kaydır butonu ----------
// requestAnimationFrame ile throttle edilir: ham "scroll" olayı saniyede
// onlarca kez tetiklenebilir (özellikle dokunmatik kaydırmada); her tetiklenmede
// DOM okuma/yazma yapmak yerine, kare başına en fazla bir kez işlem yapılır.
let scrollTicking = false;
function handleScrollFrame() {
  const y = window.scrollY;
  const header = document.getElementById("site-header");
  if (header) header.classList.toggle("hidden", y > 40);
  const topBtn = document.getElementById("scroll-top-btn");
  if (topBtn) topBtn.classList.toggle("visible", y > 400);
  scrollTicking = false;
}
window.addEventListener("scroll", () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(handleScrollFrame);
}, { passive: true });

document.getElementById("scroll-top-btn").addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------- İlk render ----------
// Not: Firebase .on() callback'leri veri zaten cache'deyse senkron
// çağrılabilir; bu durumda tryRender() bu satırdan ÖNCE render()'ı
// çalıştırmış olabilir. O yüzden sadece hâlâ yüklenmemişse loading göster.
if (!firstRenderDone) renderLoading();

