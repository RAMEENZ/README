/**
 * Matrice d'Eisenhower — organiseur de tâches.
 *
 * Fonctionne sans dépendance. Les tâches sont conservées localement
 * (localStorage) ET, si le backend `/api/state` est disponible,
 * synchronisées entre tous les appareils.
 */
(function () {
  "use strict";

  const STATE_KEY = "eisenhower.state.v1"; // { tasks, version }
  const LEGACY_KEY = "eisenhower.tasks.v1"; // ancien format (tableau simple)
  const THEME_KEY = "eisenhower.theme";
  const SORT_KEY = "eisenhower.sort";
  const API = "/api/state";
  const POLL_MS = 7000;
  const PUSH_DEBOUNCE = 600;
  const DRAG_THRESHOLD = 6;

  const QUADRANTS = [
    { id: "q1", action: "Faire", label: "Urgent & Important" },
    { id: "q2", action: "Planifier", label: "Important, pas urgent" },
    { id: "q3", action: "Déléguer", label: "Urgent, pas important" },
    { id: "q4", action: "Éliminer", label: "Ni urgent ni important" },
  ];
  const VALID_QUADRANTS = QUADRANTS.map((q) => q.id);

  // ---------- État ----------
  let tasks = [];
  let version = 0; // dernière version serveur connue
  let dirty = false; // changements locaux non confirmés
  let hasBackend = null; // null = inconnu, true/false ensuite
  let syncMode = "local"; // "local" | "online" | "offline"
  let searchQuery = "";
  let sortMode = localStorage.getItem(SORT_KEY) || "manual";

  let pushTimer = null;
  let pushing = false;
  let pushQueued = false;
  let toastTimer = null;

  // ---------- DOM ----------
  const matrixEl = document.getElementById("matrix");
  const formEl = document.getElementById("add-form");
  const inputEl = document.getElementById("task-input");
  const dueEl = document.getElementById("task-due");
  const quadrantSelectEl = document.getElementById("quadrant-select");
  const statsEl = document.getElementById("stats");
  const syncStatusEl = document.getElementById("sync-status");
  const clearDoneBtn = document.getElementById("clear-done");
  const ghostEl = document.getElementById("drag-ghost");
  const searchEl = document.getElementById("search-input");
  const sortEl = document.getElementById("sort-select");
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-icon");
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFile = document.getElementById("import-file");
  const toastEl = document.getElementById("toast");

  const placeholder = document.createElement("li");
  placeholder.className = "task-placeholder";

  // ---------- Utilitaires ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function todayStr() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function isOverdue(task) {
    return task.dueDate && !task.done && task.dueDate < todayStr();
  }
  function validTask(t) {
    return (
      t &&
      typeof t.id === "string" &&
      typeof t.text === "string" &&
      VALID_QUADRANTS.includes(t.quadrant)
    );
  }
  function normalize(t) {
    return {
      id: t.id,
      text: t.text,
      quadrant: t.quadrant,
      done: !!t.done,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      dueDate: typeof t.dueDate === "string" && t.dueDate ? t.dueDate : null,
    };
  }
  function findTask(id) {
    return tasks.find((t) => t.id === id);
  }

  // ---------- Persistance locale ----------
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        tasks = Array.isArray(s.tasks) ? s.tasks.filter(validTask).map(normalize) : [];
        version = s.version || 0;
        return;
      }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) tasks = arr.filter(validTask).map(normalize);
      }
    } catch (err) {
      console.warn("Chargement local impossible :", err);
    }
  }
  function saveLocal() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ tasks, version }));
    } catch (err) {
      console.warn("Sauvegarde locale impossible :", err);
    }
  }

  /** Point d'entrée après toute modification. */
  function touch() {
    saveLocal();
    render();
    schedulePush();
  }

  // ---------- Synchronisation ----------
  async function pullServer() {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (r.status === 404) {
        hasBackend = false;
        return null;
      }
      if (!r.ok) return null;
      hasBackend = true;
      return await r.json();
    } catch (err) {
      return null;
    }
  }

  function adoptServer(s) {
    tasks = Array.isArray(s.tasks) ? s.tasks.filter(validTask).map(normalize) : [];
    version = s.version || 0;
    dirty = false;
    saveLocal();
  }

  /** Union par id : garde tout, priorité à `winner` en cas de doublon. */
  function unionTasks(base, winner) {
    const byId = new Map();
    base.forEach((t) => byId.set(t.id, t));
    winner.forEach((t) => byId.set(t.id, t));
    return Array.from(byId.values()).filter(validTask).map(normalize);
  }

  function schedulePush() {
    dirty = true;
    renderSyncStatus();
    if (hasBackend === false) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushServer, PUSH_DEBOUNCE);
  }

  async function pushServer() {
    if (hasBackend === false) return;
    if (pushing) {
      pushQueued = true;
      return;
    }
    pushing = true;
    renderSyncStatus();
    try {
      const r = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks, baseVersion: version }),
      });
      if (r.status === 404) {
        hasBackend = false;
        syncMode = "local";
      } else if (r.status === 200) {
        const s = await r.json();
        version = s.version;
        dirty = false;
        hasBackend = true;
        syncMode = "online";
        saveLocal();
      } else if (r.status === 409) {
        // Un autre appareil a écrit entre-temps : on fusionne (nos
        // changements l'emportent sur les doublons) puis on repousse.
        const s = await r.json();
        tasks = unionTasks(s.tasks || [], tasks);
        version = s.version || 0;
        saveLocal();
        render();
        pushQueued = true;
      } else {
        syncMode = "offline";
      }
    } catch (err) {
      syncMode = "offline";
    } finally {
      pushing = false;
      renderSyncStatus();
      if (pushQueued) {
        pushQueued = false;
        pushServer();
      }
    }
  }

  async function initSync() {
    const s = await pullServer();
    if (!s) {
      syncMode = hasBackend === false ? "local" : "offline";
      renderSyncStatus();
      startPolling();
      return;
    }
    syncMode = "online";
    const serverVersion = s.version || 0;
    if (version === 0) {
      if (serverVersion === 0) {
        if (tasks.length) pushServer(); // pousse d'éventuelles tâches locales
      } else if (tasks.length) {
        // Deux sources avec des données : on fusionne sans rien perdre.
        tasks = unionTasks(s.tasks || [], tasks);
        version = serverVersion;
        saveLocal();
        pushServer();
      } else {
        adoptServer(s);
      }
    } else if (serverVersion > version && !dirty) {
      adoptServer(s);
    } else if (dirty) {
      pushServer();
    } else {
      adoptServer(s);
    }
    renderSyncStatus();
    render();
    startPolling();
  }

  function startPolling() {
    setInterval(async () => {
      if (document.hidden || hasBackend === false) return;
      if (dirty || pushing) return;
      const s = await pullServer();
      if (!s) {
        if (hasBackend !== false) syncMode = "offline";
        renderSyncStatus();
        return;
      }
      syncMode = "online";
      if ((s.version || 0) !== version) {
        adoptServer(s);
        render();
      }
      renderSyncStatus();
    }, POLL_MS);
  }

  // ---------- Opérations ----------
  function addTask(text, quadrant, dueDate) {
    const trimmed = text.trim();
    if (!trimmed) return;
    tasks.push(
      normalize({
        id: uid(),
        text: trimmed,
        quadrant: VALID_QUADRANTS.includes(quadrant) ? quadrant : "q1",
        done: false,
        createdAt: Date.now(),
        dueDate: dueDate || null,
      })
    );
    touch();
  }
  function toggleTask(id) {
    const t = findTask(id);
    if (!t) return;
    t.done = !t.done;
    touch();
  }
  function deleteTask(id) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [removed] = tasks.splice(idx, 1);
    touch();
    showUndo(removed, idx);
  }
  function editTask(id, text) {
    const t = findTask(id);
    if (!t) return;
    const trimmed = text.trim();
    if (!trimmed) {
      deleteTask(id);
      return;
    }
    if (t.text === trimmed) return;
    t.text = trimmed;
    saveLocal();
    schedulePush();
  }
  function editDue(id, val) {
    const t = findTask(id);
    if (!t) return;
    t.dueDate = val || null;
    touch();
  }
  function moveTaskTo(id, quadrant, beforeId) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1 || !VALID_QUADRANTS.includes(quadrant)) return;
    const [task] = tasks.splice(idx, 1);
    task.quadrant = quadrant;
    if (beforeId) {
      const bi = tasks.findIndex((t) => t.id === beforeId);
      if (bi === -1) tasks.push(task);
      else tasks.splice(bi, 0, task);
    } else {
      let insertAt = tasks.length;
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].quadrant === quadrant) {
          insertAt = i + 1;
          break;
        }
      }
      tasks.splice(insertAt, 0, task);
    }
    touch();
  }
  function clearDone() {
    if (!tasks.some((t) => t.done)) return;
    tasks = tasks.filter((t) => !t.done);
    touch();
  }

  // ---------- Tri / recherche ----------
  function setSort(mode) {
    sortMode = mode;
    localStorage.setItem(SORT_KEY, mode);
    if (sortEl) sortEl.value = mode;
  }
  function matchesSearch(t) {
    if (!searchQuery) return true;
    return t.text.toLowerCase().includes(searchQuery);
  }
  function sortItems(items) {
    const arr = items.slice();
    if (sortMode === "due") {
      arr.sort((a, b) => {
        const ad = a.dueDate || "",
          bd = b.dueDate || "";
        if (ad && bd) return ad.localeCompare(bd);
        if (ad) return -1;
        if (bd) return 1;
        return a.createdAt - b.createdAt;
      });
    } else if (sortMode === "created") {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else if (sortMode === "alpha") {
      arr.sort((a, b) => a.text.localeCompare(b.text, "fr", { sensitivity: "base" }));
    }
    return arr;
  }
  function bakeCurrentOrder() {
    const next = [];
    QUADRANTS.forEach((q) => {
      sortItems(tasks.filter((t) => t.quadrant === q.id)).forEach((t) => next.push(t));
    });
    tasks = next;
  }

  // ---------- Rendu ----------
  function buildSkeleton() {
    matrixEl.innerHTML = "";
    QUADRANTS.forEach((q) => {
      const section = document.createElement("section");
      section.className = "quadrant";
      section.dataset.q = q.id;
      const header = document.createElement("div");
      header.className = "quadrant__header";
      header.innerHTML =
        '<div class="quadrant__titles">' +
        '<span class="quadrant__action"></span>' +
        '<span class="quadrant__count">0</span>' +
        "</div>" +
        '<p class="quadrant__label"></p>';
      header.querySelector(".quadrant__action").textContent = q.action;
      header.querySelector(".quadrant__label").textContent = q.label;
      const list = document.createElement("ul");
      list.className = "quadrant__list";
      list.dataset.q = q.id;
      section.appendChild(header);
      section.appendChild(list);
      matrixEl.appendChild(section);
    });
  }

  function formatDue(dateStr) {
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }

  function makeTaskElement(task) {
    const li = document.createElement("li");
    li.className = "task" + (task.done ? " is-done" : "") + (isOverdue(task) ? " is-overdue" : "");
    li.dataset.id = task.id;

    const handle = document.createElement("span");
    handle.className = "task__handle";
    handle.textContent = "⠿";
    handle.title = "Glisser pour déplacer / réordonner";
    handle.setAttribute("aria-hidden", "true");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task__check";
    check.checked = task.done;
    check.setAttribute("aria-label", "Marquer comme terminée");

    const body = document.createElement("div");
    body.className = "task__body";

    const text = document.createElement("div");
    text.className = "task__text";
    text.textContent = task.text;
    text.contentEditable = "true";
    text.spellcheck = false;
    text.setAttribute("role", "textbox");
    text.setAttribute("aria-label", "Intitulé de la tâche (modifiable)");

    const due = document.createElement("label");
    due.className = "task__due" + (isOverdue(task) ? " is-overdue" : "");
    const dueIcon = document.createElement("span");
    dueIcon.className = "task__due-icon";
    dueIcon.textContent = "📅";
    dueIcon.setAttribute("aria-hidden", "true");
    const dueText = document.createElement("span");
    dueText.className = "task__due-text";
    dueText.textContent = task.dueDate ? formatDue(task.dueDate) : "Échéance";
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.className = "task__due-input";
    dueInput.value = task.dueDate || "";
    dueInput.setAttribute("aria-label", "Date d'échéance");
    due.appendChild(dueIcon);
    due.appendChild(dueText);
    due.appendChild(dueInput);

    body.appendChild(text);
    body.appendChild(due);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task__delete";
    del.innerHTML = "&times;";
    del.title = "Supprimer";
    del.setAttribute("aria-label", "Supprimer la tâche");

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    return li;
  }

  function render() {
    QUADRANTS.forEach((q) => {
      const list = matrixEl.querySelector('.quadrant__list[data-q="' + q.id + '"]');
      const countEl = matrixEl.querySelector('.quadrant[data-q="' + q.id + '"] .quadrant__count');
      const all = tasks.filter((t) => t.quadrant === q.id);
      const shown = sortItems(all.filter(matchesSearch));
      list.innerHTML = "";
      if (shown.length === 0) {
        const empty = document.createElement("li");
        empty.className = "quadrant__empty";
        empty.textContent = searchQuery ? "Aucun résultat." : "Aucune tâche — glissez-en ici.";
        list.appendChild(empty);
      } else {
        shown.forEach((t) => list.appendChild(makeTaskElement(t)));
      }
      countEl.textContent = String(all.length);
    });
    renderStats();
  }

  function renderStats() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const overdue = tasks.filter(isOverdue).length;
    if (total === 0) {
      statsEl.innerHTML = "Aucune tâche pour l'instant.";
    } else {
      let html =
        "<strong>" +
        total +
        "</strong> tâche" +
        (total > 1 ? "s" : "") +
        " · <strong>" +
        done +
        "</strong> terminée" +
        (done > 1 ? "s" : "");
      if (overdue > 0) {
        html += ' · <strong class="stats__overdue">' + overdue + "</strong> en retard";
      }
      statsEl.innerHTML = html;
    }
    clearDoneBtn.disabled = done === 0;
    clearDoneBtn.style.visibility = done === 0 ? "hidden" : "visible";
  }

  function renderSyncStatus() {
    if (!syncStatusEl) return;
    let txt, cls;
    if (hasBackend === false) {
      txt = "Local";
      cls = "is-local";
    } else if (dirty || pushing) {
      txt = "Synchronisation…";
      cls = "is-syncing";
    } else if (syncMode === "online") {
      txt = "Synchronisé";
      cls = "is-online";
    } else if (syncMode === "offline") {
      txt = "Hors ligne";
      cls = "is-offline";
    } else {
      txt = "Local";
      cls = "is-local";
    }
    syncStatusEl.textContent = "● " + txt;
    syncStatusEl.className = "sync-status " + cls;
  }

  // ---------- Toast / undo ----------
  function hideToast() {
    toastEl.hidden = true;
    toastEl.innerHTML = "";
  }
  function notify(msg) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2500);
  }
  function showUndo(task, idx) {
    toastEl.hidden = false;
    toastEl.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = "Tâche supprimée";
    const btn = document.createElement("button");
    btn.className = "toast__btn";
    btn.type = "button";
    btn.textContent = "Annuler";
    btn.addEventListener("click", () => {
      tasks.splice(Math.min(idx, tasks.length), 0, task);
      touch();
      hideToast();
    });
    toastEl.appendChild(span);
    toastEl.appendChild(btn);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  // ---------- Thème ----------
  function applyTheme() {
    const t = localStorage.getItem(THEME_KEY) || "auto";
    const root = document.documentElement;
    if (t === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    if (themeIcon) themeIcon.textContent = t === "light" ? "☀️" : t === "dark" ? "🌙" : "🌓";
    if (themeToggle)
      themeToggle.title =
        "Thème : " + (t === "auto" ? "automatique" : t === "light" ? "clair" : "sombre");
  }
  function cycleTheme() {
    const order = ["auto", "light", "dark"];
    const cur = localStorage.getItem(THEME_KEY) || "auto";
    localStorage.setItem(THEME_KEY, order[(order.indexOf(cur) + 1) % order.length]);
    applyTheme();
  }

  // ---------- Export / import ----------
  function exportTasks() {
    const blob = new Blob([JSON.stringify({ version, tasks }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "eisenhower-" + todayStr() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importTasks(file) {
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(arr)) throw new Error("format");
      const clean = arr.filter(validTask).map(normalize);
      if (!window.confirm("Importer " + clean.length + " tâche(s) ? Cela remplacera les tâches actuelles.")) return;
      tasks = clean;
      touch();
      notify("Import réussi");
    } catch (err) {
      notify("Fichier invalide");
    }
  }

  // ---------- Glisser-déposer (souris + tactile) ----------
  let drag = null;

  function positionPlaceholder(list, y) {
    const cards = Array.prototype.filter.call(
      list.querySelectorAll(".task"),
      (el) => el !== drag.el && el.getBoundingClientRect().height > 0
    );
    let ref = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        ref = c;
        break;
      }
    }
    if (ref) list.insertBefore(placeholder, ref);
    else list.appendChild(placeholder);
  }

  function onDragMove(x, y) {
    ghostEl.style.transform = "translate(" + (x + 12) + "px, " + (y + 12) + "px)";
    const el = document.elementFromPoint(x, y);
    matrixEl
      .querySelectorAll(".quadrant.is-drop-target")
      .forEach((q) => q.classList.remove("is-drop-target"));
    const quad = el && el.closest(".quadrant");
    const list = el && el.closest(".quadrant__list");
    if (quad) quad.classList.add("is-drop-target");
    if (list) positionPlaceholder(list, y);
    else if (placeholder.parentElement) placeholder.remove();
  }

  function startDrag() {
    drag.active = true;
    drag.el.style.display = "none";
    ghostEl.textContent = (findTask(drag.id) || {}).text || "";
    ghostEl.classList.add("is-active");
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  function onDrop() {
    const list = placeholder.parentElement;
    if (list && list.classList.contains("quadrant__list")) {
      const quadrant = list.dataset.q;
      let beforeId = null;
      let n = placeholder.nextElementSibling;
      while (n) {
        if (n.classList.contains("task") && n !== drag.el) {
          beforeId = n.dataset.id;
          break;
        }
        n = n.nextElementSibling;
      }
      if (sortMode !== "manual") {
        bakeCurrentOrder();
        setSort("manual");
      }
      moveTaskTo(drag.id, quadrant, beforeId);
    } else {
      render();
    }
  }

  function cleanupDrag() {
    ghostEl.classList.remove("is-active");
    ghostEl.style.transform = "translate(-9999px, -9999px)";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (placeholder.parentElement) placeholder.remove();
    matrixEl
      .querySelectorAll(".quadrant.is-drop-target")
      .forEach((q) => q.classList.remove("is-drop-target"));
  }

  matrixEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const handle = e.target.closest(".task__handle");
    if (!handle) return;
    const li = handle.closest(".task");
    if (!li) return;
    e.preventDefault();
    drag = {
      id: li.dataset.id,
      el: li,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      active: false,
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      startDrag();
    }
    e.preventDefault();
    onDragMove(e.clientX, e.clientY);
  });

  window.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasActive = drag.active;
    if (wasActive) onDrop();
    cleanupDrag();
    if (!wasActive) {
      // simple clic sur la poignée : rien à faire
    }
    drag = null;
  });

  window.addEventListener("pointercancel", () => {
    if (drag && drag.active) {
      cleanupDrag();
      render();
    }
    drag = null;
  });

  // ---------- Événements sur les tâches (délégation) ----------
  matrixEl.addEventListener("change", (e) => {
    const check = e.target.closest(".task__check");
    if (check) {
      const li = check.closest(".task");
      if (li) toggleTask(li.dataset.id);
      return;
    }
    const dueInput = e.target.closest(".task__due-input");
    if (dueInput) {
      const li = dueInput.closest(".task");
      if (li) editDue(li.dataset.id, dueInput.value);
    }
  });

  matrixEl.addEventListener("click", (e) => {
    const del = e.target.closest(".task__delete");
    if (!del) return;
    const li = del.closest(".task");
    if (li) deleteTask(li.dataset.id);
  });

  matrixEl.addEventListener("blur", (e) => {
    const text = e.target.closest(".task__text");
    if (!text) return;
    const li = text.closest(".task");
    if (li) editTask(li.dataset.id, text.textContent);
  }, true);

  matrixEl.addEventListener("keydown", (e) => {
    const text = e.target.closest(".task__text");
    if (!text) return;
    if (e.key === "Enter") {
      e.preventDefault();
      text.blur();
    } else if (e.key === "Escape") {
      const li = text.closest(".task");
      const task = li && findTask(li.dataset.id);
      if (task) text.textContent = task.text;
      text.blur();
    }
  });

  // ---------- Formulaire, contrôles, pied de page ----------
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    addTask(inputEl.value, quadrantSelectEl.value, dueEl.value);
    inputEl.value = "";
    dueEl.value = "";
    inputEl.focus();
  });

  clearDoneBtn.addEventListener("click", clearDone);
  themeToggle.addEventListener("click", cycleTheme);
  exportBtn.addEventListener("click", exportTasks);
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    if (importFile.files[0]) importTasks(importFile.files[0]);
    importFile.value = "";
  });

  searchEl.addEventListener("input", () => {
    searchQuery = searchEl.value.trim().toLowerCase();
    render();
  });
  sortEl.addEventListener("change", () => {
    setSort(sortEl.value);
    render();
  });

  // Raccourcis clavier globaux
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return;
    if (e.key === "/") {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      inputEl.focus();
    }
  });

  // Synchronisation entre onglets du même navigateur
  window.addEventListener("storage", (e) => {
    if (e.key === STATE_KEY) {
      loadLocal();
      render();
    }
  });

  // ---------- Service worker (PWA) ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // ---------- Démarrage ----------
  buildSkeleton();
  loadLocal();
  applyTheme();
  setSort(sortMode);
  render();
  initSync();
})();
