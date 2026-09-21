// Kitchen Order Book — Firebase-backed version
//
// This replaces the Claude-artifact self-publishing storage with Firestore,
// so the app can be hosted anywhere (GitHub Pages, Netlify, Vercel, ...).
//
// Data model in Firestore:
//   config/main   — one document: { business: {...}, menu: [...], rounds: [...] }
//                   (rounds hold label/date/status/createdAt only — no orders)
//   orders/{id}   — one document per order, id = "<roundId>_<normalizedPhone>"
//                   so two customers ordering at the same time never collide.
//
// See README.md for how to create the Firebase project and fill in
// firebase-config.js, and firestore.rules for the security rules to paste in.

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

(function () {
  "use strict";

  /* ---------------------------------------------------------------- *
   *  Default data (used once, to seed a brand-new empty database)
   * ---------------------------------------------------------------- */
  var DEFAULT_STATE = {
    business: {
      name: "Nandu's Kitchen",
      closedMessage: "Ordering isn't open right now — check back soon!",
      pin: "1234"
    },
    menu: [
      { id: "veg-thali", name: "Veg Thali", active: true, price: 120, image: "" },
      { id: "chicken-curry", name: "Chicken Curry Meal", active: true, price: 150, image: "" },
      { id: "curd-rice", name: "Curd Rice", active: true, price: 60, image: "" },
      { id: "chapati2", name: "Chapati (2 pcs)", active: true, price: 40, image: "" },
      { id: "sweet", name: "Today's Sweet", active: false, price: 30, image: "" }
    ],
    rounds: []
  };

  /* ---------------------------------------------------------------- *
   *  Small pure helpers (unchanged from the original app)
   * ---------------------------------------------------------------- */
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function uid() { return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function normPhone(p) { return (p || "").replace(/\D/g, ""); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function formatMoney(n) {
    n = Number(n) || 0;
    var rounded = Math.round(n * 100) / 100;
    var str = (rounded % 1 === 0) ? String(rounded) : rounded.toFixed(2);
    return "$" + str;
  }
  function e164Phone(p) {
    var digits = normPhone(p);
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;
    return "+" + digits;
  }
  function smsHref(phone, text) {
    var isIOS = /iP(hone|od|ad)/.test(navigator.userAgent || "");
    var sep = isIOS ? "&" : "?";
    return "sms:" + e164Phone(phone) + sep + "body=" + encodeURIComponent(text);
  }
  function orderMessageText(round, o, menu) {
    var total = 0;
    var lines = Object.keys(o.items).map(function (id) {
      var m = menu.find(function (x) { return x.id === id; });
      var qty = o.items[id];
      total += m ? (m.price || 0) * qty : 0;
      return (m ? m.name : "Item") + " x" + qty;
    });
    var text = "Hi " + (o.name.split(" ")[0] || o.name) + ", thanks for your order at " + STATE.business.name +
      " (" + round.label + "): " + lines.join(", ") + ".";
    if (total) text += " Total: " + formatMoney(total) + ".";
    text += " We'll have it ready for you!";
    return text;
  }
  function findOpenRound(state) {
    for (var i = 0; i < state.rounds.length; i++) if (state.rounds[i].status === "open") return state.rounds[i];
    return null;
  }
  function computeTotals(orders, menu) {
    var byId = {};
    menu.forEach(function (m) { byId[m.id] = m; });
    var totals = {};
    orders.forEach(function (o) {
      Object.keys(o.items || {}).forEach(function (itemId) {
        var qty = o.items[itemId] || 0;
        if (qty <= 0) return;
        totals[itemId] = (totals[itemId] || 0) + qty;
      });
    });
    var list = Object.keys(totals).map(function (itemId) {
      var m = byId[itemId];
      var price = m ? (m.price || 0) : 0;
      return { id: itemId, name: m ? m.name : "Removed item", qty: totals[itemId], price: price, amount: price * totals[itemId] };
    });
    list.sort(function (a, b) { return b.qty - a.qty; });
    return list;
  }
  function pruneRounds(rounds) {
    var MAX_ROUNDS = 40;
    if (rounds.length > MAX_ROUNDS) {
      var open = rounds.filter(function (r) { return r.status === "open"; });
      var closed = rounds.filter(function (r) { return r.status !== "open"; });
      closed.sort(function (a, b) { return b.createdAt - a.createdAt; });
      closed = closed.slice(0, Math.max(0, MAX_ROUNDS - open.length));
      return open.concat(closed);
    }
    return rounds;
  }
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  function fmtDate(iso) {
    try {
      var d = new Date(iso + "T00:00:00");
      return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    } catch (e) { return iso; }
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
  }

  /* ---------------------------------------------------------------- *
   *  Firebase / Firestore wiring
   * ---------------------------------------------------------------- */
  var db = null;
  var CONFIG_REF = null;
  var bootstrapAttempted = false;
  var currentOpenRoundId = null;
  var openOrdersUnsub = null;

  var STATE = null;              // { business, menu, rounds } once loaded
  var OPEN_ROUND_ORDERS = [];    // live orders for the currently open round
  var HISTORY_ORDERS = {};       // roundId -> orders array, fetched on demand
  var HISTORY_LOADING = {};      // roundId -> true while a fetch is in flight
  var MY_ORDERS = null;          // a customer's own orders across all rounds, fetched on demand
  var MY_ORDERS_LOADING = false;
  var MY_ORDERS_PHONE = null;    // which normalized phone MY_ORDERS currently holds

  function firebaseNotConfigured() {
    return !firebaseConfig || firebaseConfig.apiKey === "YOUR_API_KEY";
  }

  function subscribeConfig() {
    onSnapshot(CONFIG_REF, function (snap) {
      if (!snap.exists()) {
        if (!bootstrapAttempted) {
          bootstrapAttempted = true;
          var seeded = clone(DEFAULT_STATE);
          seeded.rounds = [{ id: "r_" + Date.now().toString(36), label: "Today's Orders", date: todayISO(), status: "open", createdAt: Date.now() }];
          setDoc(CONFIG_REF, seeded).catch(function (err) {
            console.error(err);
            showToast("Couldn't set up the database — check your Firebase config and security rules.");
          });
        }
        return; // the setDoc above will trigger another snapshot
      }
      var data = snap.data();
      STATE = {
        business: data.business || DEFAULT_STATE.business,
        menu: Array.isArray(data.menu) ? clone(data.menu) : [],
        rounds: Array.isArray(data.rounds) ? clone(data.rounds) : []
      };
      STATE.menu.forEach(function (m) { if (typeof m.price !== "number" || isNaN(m.price)) m.price = 0; });

      var round = findOpenRound(STATE);
      var nextId = round ? round.id : null;
      if (nextId !== currentOpenRoundId) {
        currentOpenRoundId = nextId;
        subscribeOpenRoundOrders(nextId);
      }
      render();
    }, function (err) {
      console.error(err);
      showToast("Lost connection to the database — check your internet connection.");
    });
  }

  function subscribeOpenRoundOrders(roundId) {
    if (openOrdersUnsub) { openOrdersUnsub(); openOrdersUnsub = null; }
    OPEN_ROUND_ORDERS = [];
    if (!roundId) { render(); return; }
    var q = query(collection(db, "orders"), where("roundId", "==", roundId));
    openOrdersUnsub = onSnapshot(q, function (snap) {
      OPEN_ROUND_ORDERS = snap.docs.map(function (d) { return d.data(); });
      render();
    }, function (err) { console.error(err); });
  }

  function fetchHistoryOrders(roundId) {
    if (HISTORY_ORDERS[roundId] || HISTORY_LOADING[roundId]) return;
    HISTORY_LOADING[roundId] = true;
    var q = query(collection(db, "orders"), where("roundId", "==", roundId));
    getDocs(q).then(function (snap) {
      HISTORY_ORDERS[roundId] = snap.docs.map(function (d) { return d.data(); });
      HISTORY_LOADING[roundId] = false;
      render();
    }).catch(function (err) {
      HISTORY_LOADING[roundId] = false;
      console.error(err);
    });
  }

  // A customer's own orders across every round (past and present), matched by
  // phone number rather than round — this is what powers "my past orders".
  function fetchMyOrders(phone) {
    var digits = normPhone(phone);
    if (digits.length < 7) return;
    MY_ORDERS_LOADING = true;
    MY_ORDERS_PHONE = digits;
    var q = query(collection(db, "orders"), where("id", "==", digits));
    getDocs(q).then(function (snap) {
      if (MY_ORDERS_PHONE !== digits) return; // phone changed while this was in flight
      MY_ORDERS = snap.docs.map(function (d) { return d.data(); });
      MY_ORDERS_LOADING = false;
      render();
    }).catch(function (err) {
      MY_ORDERS_LOADING = false;
      console.error(err);
      showToast("Couldn't load your past orders — check your connection and try again.");
      render();
    });
  }

  /* ---------------------------------------------------------------- *
   *  Mutations (each writes to Firestore; onSnapshot re-renders)
   * ---------------------------------------------------------------- */
  function submitOrder(round, name, phone, qtyMap) {
    var items = {};
    Object.keys(qtyMap).forEach(function (id) { if (qtyMap[id] > 0) items[id] = qtyMap[id]; });
    var normalizedPhone = normPhone(phone);
    var order = {
      id: normalizedPhone, roundId: round.id, name: name.trim(), phone: phone.trim(),
      items: items, submittedAt: Date.now()
    };
    return setDoc(doc(db, "orders", round.id + "_" + normalizedPhone), order).then(function () {
      try { localStorage.setItem("lastOrderContact", JSON.stringify({ name: order.name, phone: order.phone })); } catch (e) {}
      return order;
    });
  }

  function openRound(label, date) {
    if (findOpenRound(STATE)) return Promise.resolve();
    var newRounds = pruneRounds([{ id: "r_" + Date.now().toString(36), label: label, date: date, status: "open", createdAt: Date.now() }].concat(STATE.rounds));
    return updateDoc(CONFIG_REF, { rounds: newRounds });
  }
  function closeRound(roundId) {
    var newRounds = STATE.rounds.map(function (r) { return r.id === roundId ? Object.assign({}, r, { status: "closed" }) : r; });
    return updateDoc(CONFIG_REF, { rounds: newRounds });
  }
  function deleteOrder(orderId) {
    return deleteDoc(doc(db, "orders", orderId));
  }
  function updateBusiness(patch) {
    return updateDoc(CONFIG_REF, { business: Object.assign({}, STATE.business, patch) });
  }
  function saveMenu(newMenu) {
    return updateDoc(CONFIG_REF, { menu: newMenu });
  }

  /* ---------------------------------------------------------------- *
   *  UI state
   * ---------------------------------------------------------------- */
  var UI = {
    view: location.hash === "#kitchen" ? "kitchen" : "order",
    authed: (function () { try { return sessionStorage.getItem("kitchenAuthed") === "1"; } catch (e) { return false; } })(),
    tab: "orders",
    draft: {},
    showMyOrders: false,
    menuDraft: null,
    menuDirty: false,
    toastTimer: null
  };

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(UI.toastTimer);
    UI.toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  function showConfirm(message, confirmLabel, onYes) {
    var existing = document.getElementById("confirm-overlay");
    if (existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.id = "confirm-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-card">' +
        "<p>" + escapeHtml(message) + "</p>" +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline btn-sm" id="confirm-cancel">Cancel</button>' +
          '<button class="btn btn-danger btn-sm" id="confirm-yes">' + escapeHtml(confirmLabel) + "</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.getElementById("confirm-cancel").addEventListener("click", close);
    document.getElementById("confirm-yes").addEventListener("click", function () { close(); onYes(); });
  }

  /* ---------------------------------------------------------------- *
   *  Rendering
   * ---------------------------------------------------------------- */
  var root;

  function render() {
    root = document.getElementById("app");
    if (!root) return;
    if (firebaseNotConfigured()) { renderSetupNeeded(); return; }
    if (!STATE) { renderLoading(); return; }
    if (UI.view === "kitchen") {
      if (!UI.authed) renderPinGate(); else renderKitchen();
    } else {
      renderOrderForm();
    }
  }

  function renderSetupNeeded() {
    root.innerHTML =
      '<div class="shell">' +
        '<div class="empty-state">' +
          '<h2>Firebase isn’t set up yet</h2>' +
          '<p>Open <code>firebase-config.js</code> and paste in your Firebase project’s config, then reload this page. See README.md for step-by-step instructions.</p>' +
        '</div>' +
      '</div>';
  }

  function renderLoading() {
    root.innerHTML =
      '<div class="shell">' +
        '<div class="empty-state"><h2>Loading…</h2><p>Connecting to the kitchen database.</p></div>' +
      '</div>';
  }

  function renderCheckingExisting(round) {
    root.innerHTML =
      '<div class="shell">' +
        '<div class="topbar"><div class="brand"><h1>' + escapeHtml(STATE.business.name) + '</h1><span class="tag">' + escapeHtml(round.label) + ' · ' + fmtDate(round.date) + '</span></div></div>' +
        '<div class="empty-state"><h2>One moment…</h2><p>Checking whether you already have an order in for today.</p></div>' +
      '</div>';
  }

  // A customer's own orders across every round, matched by phone number.
  function renderMyOrders(round) {
    var biz = STATE.business;
    var digits = normPhone(UI.draft.phone);
    var body;
    if (MY_ORDERS_LOADING || MY_ORDERS === null || MY_ORDERS_PHONE !== digits) {
      body = '<div class="empty-state"><h2>Loading…</h2><p>Fetching your past orders.</p></div>';
    } else if (!MY_ORDERS.length) {
      body = '<div class="empty-state"><h2>No past orders</h2><p>We couldn’t find any previous orders for this mobile number.</p></div>';
    } else {
      var rows = MY_ORDERS.slice().sort(function (a, b) {
        var ra = STATE.rounds.find(function (r) { return r.id === a.roundId; });
        var rb = STATE.rounds.find(function (r) { return r.id === b.roundId; });
        return (rb ? rb.createdAt : 0) - (ra ? ra.createdAt : 0);
      });
      body = '<div class="stack">' + rows.map(function (o) {
        var r = STATE.rounds.find(function (x) { return x.id === o.roundId; });
        var label = r ? r.label : "Past order";
        var date = r ? fmtDate(r.date) : "";
        var isOpen = !!(r && r.status === "open");
        var total = 0;
        var lines = Object.keys(o.items || {}).map(function (id) {
          var m = STATE.menu.find(function (x) { return x.id === id; });
          var qty = o.items[id];
          var price = m ? (m.price || 0) : 0;
          total += price * qty;
          return (m ? m.name : "Item") + " × " + qty;
        });
        return '<div class="ticket"><div class="ticket-inner stack">' +
          '<div class="row between"><h3 style="font-size:1rem;">' + escapeHtml(label) + '</h3><span class="pill ' + (isOpen ? "open" : "closed") + '">' + (isOpen ? "Open" : "Closed") + '</span></div>' +
          (date ? '<span class="tag" style="color:var(--muted); font-size:0.8rem;">' + escapeHtml(date) + '</span>' : "") +
          '<p style="margin:6px 0;">' + (lines.length ? escapeHtml(lines.join(", ")) : "No items") + '</p>' +
          (lines.length ? '<div class="item-row" style="border-top:1px solid var(--line); border-bottom:none; font-weight:600;"><span class="item-name">Total</span><span class="mono">' + formatMoney(total) + '</span></div>' : "") +
          (isOpen ? '<button class="btn btn-outline btn-block" data-edit-mine="' + escapeHtml(o.roundId) + '">Edit this order</button>' : "") +
        '</div></div>';
      }).join("") + '</div>';
    }
    root.innerHTML =
      '<div class="shell">' +
        '<div class="topbar"><div class="brand"><h1>' + escapeHtml(biz.name) + '</h1><span class="tag">Your past orders</span></div></div>' +
        body +
        '<button class="btn btn-outline btn-block" id="btn-back-from-history" style="margin-top:12px;">Back</button>' +
      '</div>';
    attach("btn-back-from-history", "click", function () { UI.showMyOrders = false; render(); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-edit-mine]"), function (btn) {
      btn.addEventListener("click", function () {
        var rId = btn.getAttribute("data-edit-mine");
        if (rId !== round.id) return; // only the currently open round can be edited
        var mine = MY_ORDERS && MY_ORDERS.find(function (o) { return o.roundId === rId; });
        if (mine) {
          UI.draft.submitted = mine;
          UI.draft.qty = Object.assign({}, mine.items);
          UI.draft.name = mine.name;
          UI.draft.phone = mine.phone;
        }
        UI.showMyOrders = false;
        render();
      });
    });
  }

  function renderOrderForm() {
    var round = findOpenRound(STATE);
    var biz = STATE.business;

    if (!round) {
      root.innerHTML =
        '<div class="shell">' +
          '<div class="topbar"><div class="brand"><h1>' + escapeHtml(biz.name) + '</h1><span class="tag">Order book</span></div></div>' +
          '<div class="empty-state">' +
            '<h2>Not taking orders right now</h2>' +
            '<p>' + escapeHtml(biz.closedMessage) + '</p>' +
          '</div>' +
        '</div>';
      return;
    }

    if (UI.draft.roundId !== round.id) {
      UI.draft = { roundId: round.id, name: "", phone: "", qty: {}, submitted: null, checking: false, checked: false };
      UI.showMyOrders = false;
      try {
        var last = JSON.parse(localStorage.getItem("lastOrderContact") || "null");
        if (last) { UI.draft.name = last.name || ""; UI.draft.phone = last.phone || ""; }
      } catch (e) {}

      // If we already know this customer's number (from last time on this
      // device), check Firestore for an order they already placed in this
      // round — so a refresh lands them back on their existing order instead
      // of a blank form that looks like their order vanished.
      var knownDigits = normPhone(UI.draft.phone);
      if (knownDigits.length >= 7) {
        var draftAtCheckTime = UI.draft;
        UI.draft.checking = true;
        getDoc(doc(db, "orders", round.id + "_" + knownDigits)).then(function (snap) {
          if (UI.draft !== draftAtCheckTime) return; // user already moved on (e.g. round changed again)
          UI.draft.checking = false;
          UI.draft.checked = true;
          if (snap.exists()) UI.draft.submitted = snap.data();
          render();
        }).catch(function (err) {
          console.error(err);
          if (UI.draft !== draftAtCheckTime) return;
          UI.draft.checking = false;
          UI.draft.checked = true;
          render();
        });
      } else {
        UI.draft.checked = true;
      }
    }

    if (UI.draft.checking) { renderCheckingExisting(round); return; }

    if (UI.showMyOrders) { renderMyOrders(round); return; }

    if (UI.draft.submitted) {
      var order = UI.draft.submitted;
      var orderTotal = 0;
      var lines = Object.keys(order.items).map(function (id) {
        var m = STATE.menu.find(function (x) { return x.id === id; });
        var qty = order.items[id];
        var price = m ? (m.price || 0) : 0;
        orderTotal += price * qty;
        return (m ? m.name : "Item") + " × " + qty + " — " + formatMoney(price * qty);
      });
      root.innerHTML =
        '<div class="shell">' +
          '<div class="topbar"><div class="brand"><h1>' + escapeHtml(biz.name) + '</h1><span class="tag">' + escapeHtml(round.label) + ' · ' + fmtDate(round.date) + '</span></div></div>' +
          '<div class="ticket"><div class="ticket-inner stack">' +
            '<div class="confirm-check">✓</div>' +
            '<h2 style="text-align:center;">Thanks, ' + escapeHtml(order.name.split(" ")[0]) + '!</h2>' +
            '<p style="text-align:center; color:var(--muted); margin:0;">Your order is in for ' + escapeHtml(round.label) + '.</p>' +
            '<div class="section-title">Your order</div>' +
            '<div>' + (lines.length ? lines.map(function (l) { return '<div class="item-row"><span class="item-name">' + escapeHtml(l) + '</span></div>'; }).join("") : '<p style="color:var(--muted);">No items.</p>') + '</div>' +
            (lines.length ? '<div class="item-row" style="border-top:1px solid var(--line); border-bottom:none; font-weight:600;"><span class="item-name">Total</span><span class="mono">' + formatMoney(orderTotal) + '</span></div>' : "") +
            '<button class="btn btn-outline btn-block" id="btn-edit-order">Edit order</button>' +
            '<button class="btn btn-outline btn-block" id="btn-view-history">View my past orders</button>' +
            '<button class="btn btn-danger btn-block" id="btn-cancel-order">Cancel order</button>' +
          '</div></div>' +
          '<p class="foot-link">Changed your mind? Just tap edit — orders can be updated until ordering closes.</p>' +
        '</div>';
      attach("btn-edit-order", "click", function () { UI.draft.submitted = null; render(); });
      attach("btn-view-history", "click", function () {
        UI.showMyOrders = true;
        fetchMyOrders(order.phone);
        render();
      });
      attach("btn-cancel-order", "click", function () {
        showConfirm("Cancel your order for " + round.label + "? This can't be undone.", "Cancel order", function () {
          var btn = document.getElementById("btn-cancel-order");
          if (btn) btn.disabled = true;
          deleteOrder(round.id + "_" + normPhone(order.phone)).then(function () {
            UI.draft.submitted = null;
            UI.draft.qty = {};
            render();
            showToast("Your order has been cancelled.");
          }).catch(function (err) {
            console.error(err);
            showToast("Couldn't cancel your order — check your connection and try again.");
            if (btn) btn.disabled = false;
          });
        });
      });
      return;
    }

    var activeMenu = STATE.menu.filter(function (m) { return m.active; });
    var totalQty = Object.keys(UI.draft.qty).reduce(function (s, k) { return s + (UI.draft.qty[k] || 0); }, 0);
    var totalPrice = STATE.menu.reduce(function (s, m) { return s + (m.price || 0) * (UI.draft.qty[m.id] || 0); }, 0);
    var canSubmit = UI.draft.name.trim().length > 1 && normPhone(UI.draft.phone).length >= 7 && totalQty > 0;

    root.innerHTML =
      '<div class="shell">' +
        '<div class="topbar"><div class="brand"><h1>' + escapeHtml(biz.name) + '</h1><span class="tag">' + escapeHtml(round.label) + ' · ' + fmtDate(round.date) + '</span></div><span class="pill open">Open</span></div>' +
        '<div class="ticket"><div class="ticket-inner stack">' +
          '<div>' +
            '<div class="field"><label for="f-name">Your name</label><input type="text" id="f-name" placeholder="e.g. Priya" autocomplete="name" value="' + escapeHtml(UI.draft.name) + '"></div>' +
            '<div class="field" style="margin-bottom:0;"><label for="f-phone">Mobile number</label><input type="tel" id="f-phone" placeholder="e.g. 9876543210" autocomplete="tel" value="' + escapeHtml(UI.draft.phone) + '"><span class="hint">Used to match your order if you re-submit.</span></div>' +
          '</div>' +
          '<div>' +
            '<div class="section-title">Menu</div>' +
            (activeMenu.length ? activeMenu.map(renderItemRow).join("") : '<p style="color:var(--muted);">No items on the menu yet.</p>') +
            (activeMenu.length ? '<div class="item-row" style="border-top:1px solid var(--line); border-bottom:none; font-weight:600;"><span class="item-name">Total</span><span class="mono">' + formatMoney(totalPrice) + '</span></div>' : "") +
          '</div>' +
        '</div></div>' +
        '<div class="submit-bar">' +
          '<span class="total">Items: <b class="mono">' + totalQty + '</b> &middot; Total: <b class="mono">' + formatMoney(totalPrice) + '</b></span>' +
          '<button class="btn btn-primary" id="btn-submit" ' + (canSubmit ? "" : "disabled") + '>Submit order</button>' +
        '</div>' +
        '<p class="foot-link"><a href="#" id="link-view-history">View my past orders</a></p>' +
      '</div>';

    attach("f-name", "input", function (e) { UI.draft.name = e.target.value; syncSubmitState(); });
    attach("f-phone", "input", function (e) { UI.draft.phone = e.target.value; syncSubmitState(); });
    attach("f-phone", "blur", function () {
      var digits = normPhone(UI.draft.phone);
      if (digits.length < 7) return;
      getDoc(doc(db, "orders", round.id + "_" + digits)).then(function (snap) {
          if (snap.exists()) {
            var data = snap.data();
            UI.draft.submitted = data;
            UI.draft.qty = Object.assign({}, data.items);
            UI.draft.name = data.name;
            UI.draft.phone = data.phone;
          }
      }).catch(function (err) { console.error(err); });
    });
    attach("link-view-history", "click", function (e) {
      e.preventDefault();
      var digits = normPhone(UI.draft.phone);
      if (digits.length < 7) { showToast("Enter your mobile number above first."); return; }
      UI.showMyOrders = true;
      fetchMyOrders(UI.draft.phone);
      render();
    });
    activeMenu.forEach(function (m) {
      attach("dec-" + m.id, "click", function () { UI.draft.qty[m.id] = Math.max(0, (UI.draft.qty[m.id] || 0) - 1); render(); });
      attach("inc-" + m.id, "click", function () { UI.draft.qty[m.id] = (UI.draft.qty[m.id] || 0) + 1; render(); });
    });
    attach("btn-submit", "click", function () {
      // Recomputed here rather than trusting the outer `canSubmit` — that
      // variable is only fresh right after a full render (e.g. tapping +/-).
      // Typing in the name/phone fields updates state without a full
      // re-render, so a stale `canSubmit` from an earlier render could make
      // this silently no-op even while the button looked enabled.
      var liveQty = Object.keys(UI.draft.qty).reduce(function (s, k) { return s + (UI.draft.qty[k] || 0); }, 0);
      var liveOk = UI.draft.name.trim().length > 1 && normPhone(UI.draft.phone).length >= 7 && liveQty > 0;
      if (!liveOk) return;
      var btn = document.getElementById("btn-submit");
      if (btn) btn.disabled = true;
      submitOrder(round, UI.draft.name, UI.draft.phone, UI.draft.qty).then(function (order) {
        UI.draft.submitted = order;
        render();
      }).catch(function (err) {
        console.error(err);
        showToast("Couldn't submit your order — check your connection and try again.");
        if (btn) btn.disabled = false;
      });
    });

    function syncSubmitState() {
      var ok = UI.draft.name.trim().length > 1 && normPhone(UI.draft.phone).length >= 7 && totalQty > 0;
      var btn = document.getElementById("btn-submit");
      if (btn) btn.disabled = !ok;
    }
  }

  function renderItemRow(m) {
    var qty = UI.draft.qty[m.id] || 0;
    return '<div class="item-row">' +
      '<div style="display:flex; align-items:center; gap:10px; min-width:0;">' +
        (m.image ? '<img src="' + escapeHtml(m.image) + '" alt="" style="width:44px; height:44px; border-radius:8px; object-fit:cover; flex:none;">' : '') +
        '<span class="item-name">' + escapeHtml(m.name) + '<span class="sub">' + formatMoney(m.price) + ' each</span></span>' +
      '</div>' +
      '<div class="qty-block">' +
        '<div class="stepper">' +
          '<button type="button" id="dec-' + m.id + '" aria-label="Decrease ' + escapeHtml(m.name) + '" ' + (qty <= 0 ? "disabled" : "") + '>−</button>' +
          '<span class="qty mono">' + qty + '</span>' +
          '<button type="button" id="inc-' + m.id + '" aria-label="Increase ' + escapeHtml(m.name) + '">+</button>' +
        '</div>' +
        '<span class="line-amt mono">' + (qty > 0 ? formatMoney(m.price * qty) : "") + '</span>' +
      '</div></div>';
  }

  function renderPinGate() {
    root.innerHTML =
      '<div class="shell">' +
        '<div class="topbar"><div class="brand"><h1>' + escapeHtml(STATE.business.name) + '</h1><span class="tag">Kitchen access</span></div></div>' +
        '<div class="ticket"><div class="ticket-inner pin-wrap">' +
          '<div class="section-title">Enter kitchen PIN</div>' +
          '<input type="password" inputmode="numeric" id="pin-input" maxlength="8" autofocus>' +
          '<div class="error-text" id="pin-error" hidden>Incorrect PIN</div>' +
          '<button class="btn btn-primary" id="pin-go">Unlock</button>' +
        '</div></div>' +
        '<div class="foot-link"><a href="#" id="link-order">Back to order form</a></div>' +
      '</div>';
    attach("link-order", "click", function (e) { e.preventDefault(); location.hash = ""; UI.view = "order"; render(); });
    attach("pin-go", "click", tryPin);
    attach("pin-input", "keydown", function (e) { if (e.key === "Enter") tryPin(); });
    function tryPin() {
      var v = document.getElementById("pin-input").value;
      if (v === STATE.business.pin) {
        try { sessionStorage.setItem("kitchenAuthed", "1"); } catch (e) {}
        UI.authed = true; render();
      } else {
        document.getElementById("pin-error").hidden = false;
      }
    }
  }

  function renderKitchen() {
    var round = findOpenRound(STATE);
    var closedRounds = STATE.rounds.filter(function (r) { return r.status !== "open"; }).sort(function (a, b) { return b.createdAt - a.createdAt; });

    var tabsHtml = '<div class="tabs">' +
      ["orders", "menu", "history", "settings"].map(function (t) {
        var labels = { orders: "Today's Orders", menu: "Menu", history: "History", settings: "Settings" };
        return '<button data-tab="' + t + '" class="' + (UI.tab === t ? "active" : "") + '">' + labels[t] + '</button>';
      }).join("") + '</div>';

    var body = "";
    if (UI.tab === "orders") body = renderOrdersTab(round);
    else if (UI.tab === "menu") body = renderMenuTab();
    else if (UI.tab === "history") body = renderHistoryTab(closedRounds);
    else body = renderSettingsTab();

    root.innerHTML =
      '<div class="shell wide">' +
        '<div class="topbar"><div class="brand"><h1>' + escapeHtml(STATE.business.name) + '</h1><span class="tag">Kitchen view</span></div><a class="btn btn-outline btn-sm" href="#" id="link-order">View order form</a></div>' +
        tabsHtml +
        body +
      '</div>';

    attach("link-order", "click", function (e) {
      e.preventDefault();
      if (UI.menuDirty) {
        showConfirm("You have unsaved menu changes that haven't been published yet. Leave without saving?", "Leave without saving", function () {
          UI.menuDraft = null; UI.menuDirty = false;
          location.hash = ""; UI.view = "order"; render();
        });
        return;
      }
      UI.menuDraft = null; UI.menuDirty = false;
      location.hash = ""; UI.view = "order"; render();
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (btn) {
      btn.addEventListener("click", function () {
        var nextTab = btn.getAttribute("data-tab");
        if (UI.tab === "menu" && nextTab !== "menu" && UI.menuDirty) {
          showConfirm("You have unsaved menu changes that haven't been published yet. Switch tabs without saving?", "Switch without saving", function () {
            UI.tab = nextTab;
            render();
          });
          return;
        }
        UI.tab = nextTab;
        render();
      });
    });

    if (UI.tab === "orders") wireOrdersTab(round);
    else if (UI.tab === "menu") wireMenuTab();
    else if (UI.tab === "history") wireHistoryTab(closedRounds);
    else wireSettingsTab();
  }

  function renderOrdersTab(round) {
    if (!round) {
      return '<div class="stack">' +
        '<div class="empty-state"><h2>No order round is open</h2><p>Open one so customers can start ordering.</p></div>' +
        '<div class="ticket"><div class="ticket-inner stack">' +
          '<div class="field"><label for="new-round-label">Round label</label><input type="text" id="new-round-label" value="Today’s Orders"></div>' +
          '<div class="field" style="margin-bottom:0;"><label for="new-round-date">Date</label><input type="date" id="new-round-date" value="' + todayISO() + '"></div>' +
          '<button class="btn btn-primary btn-block" id="btn-open-round">Open ordering</button>' +
        '</div></div>' +
      '</div>';
    }
    var orders = OPEN_ROUND_ORDERS;
    var totals = computeTotals(orders, STATE.menu);
    var grandTotal = totals.reduce(function (s, t) { return s + t.qty; }, 0);
    var grandRevenue = totals.reduce(function (s, t) { return s + t.amount; }, 0);
    return '<div class="stack">' +
      '<div class="row between">' +
        '<div><h2 style="font-size:1.05rem;">' + escapeHtml(round.label) + '</h2><span class="tag" style="color:var(--muted); font-size:0.8rem;">' + fmtDate(round.date) + ' · <span class="pill open" style="padding:2px 8px;">Open</span></span></div>' +
        '<button class="btn btn-danger btn-sm" id="btn-close-round">Close ordering</button>' +
      '</div>' +
      '<div class="summary-bar"><span>' + orders.length + ' customer' + (orders.length === 1 ? "" : "s") + ' ordered</span><span class="n mono">' + grandTotal + ' items · ' + formatMoney(grandRevenue) + '</span><button class="btn btn-outline btn-sm" id="btn-copy">Copy summary</button></div>' +
      '<div class="totals-grid">' + (totals.length ? totals.map(function (t) {
        return '<div class="stat-tile"><span class="num">' + t.qty + '</span><span class="label">' + escapeHtml(t.name) + '</span>' + (t.price ? '<span class="label" style="color:var(--muted);">' + formatMoney(t.amount) + '</span>' : '') + '</div>';
      }).join("") : '<p style="color:var(--muted);">No orders yet.</p>') + '</div>' +
      '<div class="section-title">Orders received</div>' +
      '<div class="order-list">' + (orders.length ? orders.slice().sort(function (a, b) { return b.submittedAt - a.submittedAt; }).map(function (o) { return renderOrderCard(round, o); }).join("") : '<p style="color:var(--muted);">Waiting for the first order.</p>') + '</div>' +
    '</div>';
  }

  function renderOrderCard(round, o) {
    var orderAmount = 0;
    var items = Object.keys(o.items).map(function (id) {
      var m = STATE.menu.find(function (x) { return x.id === id; });
      var qty = o.items[id];
      var price = m ? (m.price || 0) : 0;
      orderAmount += price * qty;
      return (m ? m.name : "Removed item") + " × " + qty;
    }).join(", ");
    var orderId = round.id + "_" + o.id;
    var msgHref = smsHref(o.phone, orderMessageText(round, o, STATE.menu));
    return '<div class="order-card">' +
      '<div class="head"><span class="name">' + escapeHtml(o.name) + '</span><span class="time">' + fmtTime(o.submittedAt) + '</span></div>' +
      '<span class="phone">' + escapeHtml(o.phone) + '</span>' +
      '<span class="items">' + escapeHtml(items || "—") + (orderAmount ? ' <span class="mono" style="color:var(--muted);">· ' + formatMoney(orderAmount) + '</span>' : '') + '</span>' +
      '<div class="row-actions"><a class="btn btn-outline btn-sm" href="' + msgHref + '">Message customer</a><button class="btn btn-danger btn-sm" data-del="' + orderId + '">Remove</button></div>' +
    '</div>';
  }

  function wireOrdersTab(round) {
    if (!round) {
      attach("btn-open-round", "click", function () {
        var label = document.getElementById("new-round-label").value.trim() || "Today's Orders";
        var date = document.getElementById("new-round-date").value || todayISO();
        openRound(label, date).catch(function (err) { console.error(err); showToast("Couldn't open ordering — please try again."); });
      });
      return;
    }
    attach("btn-close-round", "click", function () {
      showConfirm("Close ordering for “" + round.label + "”? Customers won't be able to order until you open a new round.", "Close ordering", function () {
        closeRound(round.id).catch(function (err) { console.error(err); showToast("Couldn't close ordering — please try again."); });
      });
    });
    attach("btn-copy", "click", function () { copySummary(round, OPEN_ROUND_ORDERS); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        showConfirm("Remove this order?", "Remove", function () {
          deleteOrder(btn.getAttribute("data-del")).catch(function (err) { console.error(err); showToast("Couldn't remove that order — please try again."); });
        });
      });
    });
  }

  function copySummary(round, orders) {
    var totals = computeTotals(orders, STATE.menu);
    var lines = [STATE.business.name + " — " + round.label + " (" + fmtDate(round.date) + ")", ""];
    if (totals.length) totals.forEach(function (t) { lines.push(t.name + ": " + t.qty + (t.price ? " (" + formatMoney(t.amount) + ")" : "")); });
    else lines.push("No orders yet.");
    lines.push("");
    lines.push("Total items: " + totals.reduce(function (s, t) { return s + t.qty; }, 0));
    var grandRevenue = totals.reduce(function (s, t) { return s + t.amount; }, 0);
    if (grandRevenue) lines.push("Total revenue: " + formatMoney(grandRevenue));
    lines.push("Customers: " + orders.length);
    var text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast("Summary copied"); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); showToast("Summary copied"); } catch (e) { showToast("Couldn't copy — select and copy manually."); }
    document.body.removeChild(ta);
  }

  function renderMenuTab() {
    if (!UI.menuDraft) { UI.menuDraft = clone(STATE.menu); UI.menuDirty = false; }
    var dirty = !!UI.menuDirty;
    return '<div class="stack">' +
      '<div class="ticket"><div class="ticket-inner">' +
        '<div class="section-title">Menu items</div>' +
        UI.menuDraft.map(function (m) {
          return '<div class="menu-row">' +
            '<label class="switch"><input type="checkbox" data-toggle="' + m.id + '" ' + (m.active ? "checked" : "") + '><span class="track"></span><span class="knob"></span></label>' +
            (m.image ? '<img src="' + escapeHtml(m.image) + '" alt="" style="width:32px; height:32px; border-radius:6px; object-fit:cover; flex:none;">' : "") +
            '<input type="text" class="menu-name" data-name="' + m.id + '" value="' + escapeHtml(m.name) + '">' +
            '<label class="price-field">$<input type="number" min="0" step="0.01" inputmode="decimal" data-price="' + m.id + '" value="' + (m.price || 0) + '"></label>' +
            '<button class="btn btn-danger btn-sm" data-remove="' + m.id + '">Remove</button>' +
            '<input type="url" data-image="' + m.id + '" placeholder="Photo URL (optional)" value="' + escapeHtml(m.image || "") + '" style="flex:1 1 100%; margin-top:4px;">' +
          '</div>';
        }).join("") +
        '<div class="row" style="margin-top:12px;">' +
          '<input type="text" id="new-menu-name" placeholder="New menu item, e.g. Sambar Rice">' +
          '<button class="btn btn-primary btn-sm" id="btn-add-menu">Add</button>' +
        '</div>' +
      '</div></div>' +
      '<p style="color:var(--muted); font-size:0.82rem;">Turn an item off to hide it from the order form without losing past order history. Changes here only reach customers once you save.</p>' +
      '<div class="save-bar">' +
        '<span class="save-status" id="menu-save-status">' + (dirty ? '<span class="dot"></span> Unsaved changes' : "Up to date") + '</span>' +
        '<div class="row">' +
          '<button class="btn btn-outline btn-sm" id="btn-discard-menu" ' + (dirty ? "" : "hidden") + '>Discard</button>' +
          '<button class="btn btn-primary" id="btn-save-menu" ' + (dirty ? "" : "disabled") + '>Save &amp; publish</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function markMenuDirty() {
    if (UI.menuDirty) return;
    UI.menuDirty = true;
    var status = document.getElementById("menu-save-status");
    var saveBtn = document.getElementById("btn-save-menu");
    var discardBtn = document.getElementById("btn-discard-menu");
    if (status) status.innerHTML = '<span class="dot"></span> Unsaved changes';
    if (saveBtn) saveBtn.disabled = false;
    if (discardBtn) discardBtn.hidden = false;
  }
  function wireMenuTab() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-toggle]"), function (el) {
      el.addEventListener("change", function () {
        var m = UI.menuDraft.find(function (x) { return x.id === el.getAttribute("data-toggle"); });
        if (m) m.active = el.checked;
        UI.menuDirty = true;
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-name]"), function (el) {
      el.addEventListener("input", function () {
        var m = UI.menuDraft.find(function (x) { return x.id === el.getAttribute("data-name"); });
        if (m) m.name = el.value;
        markMenuDirty();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-price]"), function (el) {
      el.addEventListener("input", function () {
        var m = UI.menuDraft.find(function (x) { return x.id === el.getAttribute("data-price"); });
        if (m) m.price = Math.max(0, parseFloat(el.value) || 0);
        markMenuDirty();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-image]"), function (el) {
      el.addEventListener("input", function () {
        var m = UI.menuDraft.find(function (x) { return x.id === el.getAttribute("data-image"); });
        if (m) m.image = el.value.trim();
        markMenuDirty();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-remove]"), function (el) {
      el.addEventListener("click", function () {
        showConfirm("Remove this menu item? This only takes effect once you save.", "Remove", function () {
          UI.menuDraft = UI.menuDraft.filter(function (m) { return m.id !== el.getAttribute("data-remove"); });
          UI.menuDirty = true;
          render();
        });
      });
    });
    attach("btn-add-menu", "click", function () {
      var input = document.getElementById("new-menu-name");
      if (input.value.trim()) {
        UI.menuDraft.push({ id: uid(), name: input.value.trim(), active: true, price: 0, image: "" });
        UI.menuDirty = true;
        render();
      }
    });
    attach("btn-discard-menu", "click", function () {
      UI.menuDraft = clone(STATE.menu);
      UI.menuDirty = false;
      render();
    });
    attach("btn-save-menu", "click", function () {
      if (!UI.menuDirty) return;
      var newMenu = clone(UI.menuDraft);
      var btn = document.getElementById("btn-save-menu");
      if (btn) btn.disabled = true;
      saveMenu(newMenu).then(function () {
        UI.menuDraft = null;
        UI.menuDirty = false;
        showToast("Menu published to customers");
        render();
      }).catch(function (err) {
        console.error(err);
        showToast("Couldn't save just now — please try again.");
        if (btn) btn.disabled = false;
      });
    });
  }

  function renderHistoryTab(closedRounds) {
    if (!closedRounds.length) return '<div class="empty-state"><h2>No history yet</h2><p>Closed order rounds will show up here.</p></div>';
    closedRounds.forEach(function (r) { fetchHistoryOrders(r.id); });
    return '<div class="stack">' + closedRounds.map(function (r) {
      var orders = HISTORY_ORDERS[r.id];
      if (!orders) {
        return '<div class="ticket"><div class="ticket-inner stack">' +
          '<div class="row between"><h3 style="font-size:1rem;">' + escapeHtml(r.label) + '</h3><span class="pill closed">Closed</span></div>' +
          '<p style="color:var(--muted);">Loading…</p>' +
        '</div></div>';
      }
      var totals = computeTotals(orders, STATE.menu);
      var grand = totals.reduce(function (s, t) { return s + t.qty; }, 0);
      var grandRevenue = totals.reduce(function (s, t) { return s + t.amount; }, 0);
      return '<div class="ticket"><div class="ticket-inner stack">' +
        '<div class="row between"><h3 style="font-size:1rem;">' + escapeHtml(r.label) + '</h3><span class="pill closed">Closed</span></div>' +
        '<span class="tag" style="color:var(--muted); font-size:0.8rem;">' + fmtDate(r.date) + ' · ' + orders.length + ' customers · ' + grand + ' items' + (grandRevenue ? ' · ' + formatMoney(grandRevenue) : '') + '</span>' +
        '<div class="totals-grid">' + totals.map(function (t) { return '<div class="stat-tile"><span class="num">' + t.qty + '</span><span class="label">' + escapeHtml(t.name) + '</span>' + (t.price ? '<span class="label" style="color:var(--muted);">' + formatMoney(t.amount) + '</span>' : '') + '</div>'; }).join("") + '</div>' +
        '<button class="btn btn-outline btn-sm" data-copy-hist="' + r.id + '">Copy summary</button>' +
      '</div></div>';
    }).join("") + '</div>';
  }
  function wireHistoryTab(closedRounds) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-copy-hist]"), function (btn) {
      btn.addEventListener("click", function () {
        var r = closedRounds.find(function (x) { return x.id === btn.getAttribute("data-copy-hist"); });
        var orders = r && HISTORY_ORDERS[r.id];
        if (r && orders) copySummary(r, orders);
      });
    });
  }

  function renderSettingsTab() {
    return '<div class="ticket"><div class="ticket-inner stack">' +
      '<div class="field"><label for="set-name">Kitchen name</label><input type="text" id="set-name" value="' + escapeHtml(STATE.business.name) + '"></div>' +
      '<div class="field"><label for="set-closed">Message shown when ordering is closed</label><input type="text" id="set-closed" value="' + escapeHtml(STATE.business.closedMessage) + '"></div>' +
      '<div class="field" style="margin-bottom:0;"><label for="set-pin">Kitchen PIN</label><input type="text" inputmode="numeric" id="set-pin" value="' + escapeHtml(STATE.business.pin) + '"><span class="hint">Anyone with this PIN can open this Kitchen view. It is a light deterrent, not a real password — don’t use it for sensitive data.</span></div>' +
      '<button class="btn btn-primary" id="btn-save-settings">Save settings</button>' +
    '</div></div>';
  }
  function wireSettingsTab() {
    attach("btn-save-settings", "click", function () {
      var btn = document.getElementById("btn-save-settings");
      if (btn) btn.disabled = true;
      updateBusiness({
        name: document.getElementById("set-name").value.trim() || "Kitchen",
        closedMessage: document.getElementById("set-closed").value.trim() || "Ordering is closed right now.",
        pin: document.getElementById("set-pin").value.trim() || "1234"
      }).then(function () {
        showToast("Settings saved");
      }).catch(function (err) {
        console.error(err);
        showToast("Couldn't save settings — please try again.");
      }).then(function () {
        if (btn) btn.disabled = false;
      });
    });
  }

  function attach(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  window.addEventListener("hashchange", function () {
    UI.view = location.hash === "#kitchen" ? "kitchen" : "order";
    render();
  });

  /* ---------------------------------------------------------------- *
   *  Boot
   * ---------------------------------------------------------------- */
  render(); // shows the "Firebase isn't set up" or "Loading…" screen immediately
  if (!firebaseNotConfigured()) {
    var app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    CONFIG_REF = doc(db, "config", "main");
    subscribeConfig();
  }
})();
