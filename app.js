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
  const LAYOUT_KEY = "eisenhower.layout.v1";
  const API = "/api/state";
  const POLL_MS = 7000;
  const PUSH_DEBOUNCE = 600;
  const DRAG_THRESHOLD = 6;

  const QUADRANTS = [
    { id: "q1", action: "Faire", label: "Urgent & Important", emoji: "🔥" },
    { id: "q2", action: "Planifier", label: "Important, pas urgent", emoji: "📅" },
    { id: "q3", action: "Déléguer", label: "Urgent, pas important", emoji: "🤝" },
    { id: "q4", action: "Éliminer", label: "Ni urgent ni important", emoji: "🗑️" },
  ];
  const VALID_QUADRANTS = QUADRANTS.map((q) => q.id);
  const REPEATS = ["none", "daily", "weekly", "monthly"];
  const REPEAT_LABEL = { none: "", daily: "Quotidien", weekly: "Hebdo", monthly: "Mensuel" };

  // ---------- État ----------
  let tasks = [];
  let version = 0; // dernière version serveur connue
  let dirty = false; // changements locaux non confirmés
  let hasBackend = null; // null = inconnu, true/false ensuite
  let syncMode = "local"; // "local" | "online" | "offline"
  let searchQuery = "";
  let sortMode = localStorage.getItem(SORT_KEY) || "manual";
  let lastAddedId = null; // pour l'animation d'apparition

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
  function normalizeSub(s) {
    return {
      id: typeof s.id === "string" ? s.id : uid(),
      text: String(s.text == null ? "" : s.text),
      done: !!s.done,
    };
  }
  function normalize(t) {
    return {
      id: t.id,
      text: t.text,
      quadrant: t.quadrant,
      done: !!t.done,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      dueDate: typeof t.dueDate === "string" && t.dueDate ? t.dueDate : null,
      repeat: REPEATS.includes(t.repeat) ? t.repeat : "none",
      subtasks: Array.isArray(t.subtasks)
        ? t.subtasks.filter((s) => s && s.text != null).map(normalizeSub)
        : [],
    };
  }

  // Prochaine occurrence (strictement dans le futur) pour une récurrence.
  function advanceDate(iso, repeat) {
    if (repeat === "none") return iso;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let d;
    if (iso) {
      const p = iso.split("-");
      d = new Date(+p[0], +p[1] - 1, +p[2]);
    } else {
      d = new Date(today);
    }
    d.setHours(0, 0, 0, 0);
    do {
      if (repeat === "daily") d.setDate(d.getDate() + 1);
      else if (repeat === "weekly") d.setDate(d.getDate() + 7);
      else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
      else break;
    } while (d <= today);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
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
    } else if (dirty) {
      pushServer();
    } else if (serverVersion > version) {
      adoptServer(s);
    } else if (serverVersion < version) {
      // Le serveur a « régressé » (données réinitialisées ?) : on restaure
      // depuis le local plutôt que de tout perdre.
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
      // On ne se met à jour que « vers l'avant » : jamais adopter une
      // version serveur plus ancienne (protège d'une perte de données).
      if ((s.version || 0) > version) {
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
    const t = normalize({
      id: uid(),
      text: trimmed,
      quadrant: VALID_QUADRANTS.includes(quadrant) ? quadrant : "q1",
      done: false,
      createdAt: Date.now(),
      dueDate: dueDate || null,
    });
    tasks.push(t);
    lastAddedId = t.id;
    touch();
  }
  function toggleTask(id) {
    const t = findTask(id);
    if (!t) return;
    // Compléter une tâche récurrente => on la reprogramme plutôt que de la
    // marquer terminée (les sous-tâches sont réinitialisées).
    if (!t.done && t.repeat && t.repeat !== "none") {
      t.dueDate = advanceDate(t.dueDate, t.repeat);
      t.subtasks.forEach((s) => (s.done = false));
      t.done = false;
      touch();
      notify("🔁 Reprogrammée au " + formatDue(t.dueDate));
      return;
    }
    t.done = !t.done;
    touch();
  }
  function cycleRepeat(id) {
    const t = findTask(id);
    if (!t) return;
    t.repeat = REPEATS[(REPEATS.indexOf(t.repeat) + 1) % REPEATS.length];
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

  // ---------- Sous-tâches ----------
  const expanded = new Set(); // ids des tâches dépliées (état UI, non synchronisé)
  function addSub(taskId, text) {
    const t = findTask(taskId);
    if (!t) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    t.subtasks.push({ id: uid(), text: trimmed, done: false });
    expanded.add(taskId);
    touch();
  }
  function toggleSub(taskId, subId) {
    const t = findTask(taskId);
    if (!t) return;
    const s = t.subtasks.find((x) => x.id === subId);
    if (!s) return;
    s.done = !s.done;
    touch();
  }
  function deleteSub(taskId, subId) {
    const t = findTask(taskId);
    if (!t) return;
    t.subtasks = t.subtasks.filter((x) => x.id !== subId);
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
    // Les tâches terminées descendent toujours en bas (ordre stable).
    return arr.filter((t) => !t.done).concat(arr.filter((t) => t.done));
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
        '<span class="quadrant__icon" aria-hidden="true"></span>' +
        '<div class="quadrant__titles">' +
        '<span class="quadrant__action"></span>' +
        '<span class="quadrant__label"></span>' +
        "</div>" +
        '<span class="quadrant__count">0</span>';
      header.querySelector(".quadrant__icon").textContent = q.emoji;
      header.querySelector(".quadrant__action").textContent = q.action;
      header.querySelector(".quadrant__label").textContent = q.label;
      const list = document.createElement("ul");
      list.className = "quadrant__list";
      list.dataset.q = q.id;
      section.appendChild(header);
      section.appendChild(list);
      matrixEl.appendChild(section);
    });
    ["v", "h"].forEach((axis) => {
      const sp = document.createElement("div");
      sp.className = "matrix__split matrix__split--" + axis;
      sp.title = "Glisser pour redimensionner · double-clic pour réinitialiser";
      matrixEl.appendChild(sp);
    });
  }

  function formatDue(dateStr) {
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return "auj.";
    if (diff === 1) return "demain";
    if (diff === -1) return "hier";
    if (diff > 1 && diff <= 7) return "dans " + diff + " j";
    if (diff < -1 && diff >= -7) return "il y a " + -diff + " j";
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("fr-FR", opts);
  }

  function makeSubPanel(task) {
    const panel = document.createElement("div");
    panel.className = "subtasks";
    const ul = document.createElement("ul");
    ul.className = "subtasks__list";
    task.subtasks.forEach((s) => {
      const li = document.createElement("li");
      li.className = "subtask" + (s.done ? " is-done" : "");
      li.dataset.subId = s.id;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "subtask__check";
      cb.checked = s.done;
      cb.setAttribute("aria-label", "Sous-tâche terminée");
      const txt = document.createElement("span");
      txt.className = "subtask__text";
      txt.textContent = s.text;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "subtask__delete";
      del.innerHTML = "&times;";
      del.title = "Supprimer la sous-tâche";
      del.setAttribute("aria-label", "Supprimer la sous-tâche");
      li.appendChild(cb);
      li.appendChild(txt);
      li.appendChild(del);
      ul.appendChild(li);
    });
    panel.appendChild(ul);
    const add = document.createElement("input");
    add.type = "text";
    add.className = "subtasks__add";
    add.placeholder = "Ajouter une sous-tâche…";
    add.maxLength = 200;
    add.setAttribute("aria-label", "Nouvelle sous-tâche");
    panel.appendChild(add);
    return panel;
  }

  function makeTaskElement(task) {
    const li = document.createElement("li");
    li.className =
      "task" +
      (task.done ? " is-done" : "") +
      (isOverdue(task) ? " is-overdue" : "") +
      (task.id === lastAddedId ? " task--enter" : "");
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
    due.className =
      "task__due" +
      (isOverdue(task) ? " is-overdue" : "") +
      (task.dueDate ? "" : " task__due--empty");
    due.title = task.dueDate ? "Modifier l'échéance" : "Ajouter une échéance";
    const dueIcon = document.createElement("span");
    dueIcon.className = "task__due-icon";
    dueIcon.textContent = "📅";
    dueIcon.setAttribute("aria-hidden", "true");
    const dueText = document.createElement("span");
    dueText.className = "task__due-text";
    dueText.textContent = task.dueDate ? formatDue(task.dueDate) : "";
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.className = "task__due-input";
    dueInput.value = task.dueDate || "";
    dueInput.setAttribute("aria-label", "Date d'échéance");
    due.appendChild(dueIcon);
    due.appendChild(dueText);
    due.appendChild(dueInput);

    body.appendChild(text);

    // Barre méta : échéance + bouton sous-tâches
    const meta = document.createElement("div");
    meta.className = "task__meta";
    meta.appendChild(due);

    const rep = document.createElement("button");
    rep.type = "button";
    rep.className = "task__repeat" + (task.repeat !== "none" ? " is-on" : "");
    rep.dataset.act = "repeat";
    rep.title =
      task.repeat !== "none"
        ? "Récurrence : " + REPEAT_LABEL[task.repeat] + " (cliquer pour changer)"
        : "Rendre récurrente";
    rep.innerHTML =
      '<span class="task__repeat-icon" aria-hidden="true">🔁</span>' +
      '<span class="task__repeat-label">' + REPEAT_LABEL[task.repeat] + "</span>";
    meta.appendChild(rep);

    const total = task.subtasks.length;
    const doneN = task.subtasks.filter((s) => s.done).length;
    const isExpanded = expanded.has(task.id);
    const subToggle = document.createElement("button");
    subToggle.type = "button";
    subToggle.className = "task__subtoggle" + (total ? " has-subs" : "");
    subToggle.dataset.act = "expand";
    subToggle.title = total ? "Sous-tâches" : "Ajouter des sous-tâches";
    subToggle.setAttribute("aria-label", "Sous-tâches");
    subToggle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    subToggle.innerHTML =
      '<span class="task__subtoggle-icon" aria-hidden="true">☑</span>' +
      '<span class="task__subcount">' + (total ? doneN + "/" + total : "") + "</span>" +
      '<span class="task__caret" aria-hidden="true">' + (isExpanded ? "▾" : "▸") + "</span>";
    meta.appendChild(subToggle);
    body.appendChild(meta);

    if (total) {
      const prog = document.createElement("div");
      prog.className = "task__progress";
      const fill = document.createElement("div");
      fill.className = "task__progress-fill";
      fill.style.width = Math.round((doneN / total) * 100) + "%";
      if (doneN === total) fill.classList.add("is-complete");
      prog.appendChild(fill);
      body.appendChild(prog);
    }

    if (isExpanded) body.appendChild(makeSubPanel(task));

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
      countEl.classList.toggle("is-zero", all.length === 0);
    });
    lastAddedId = null; // l'animation ne joue qu'une fois
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

  // ---------- Redimensionnement des quadrants ----------
  let layout = { rx: 0.5, ry: 0.5 };
  let splitDrag = null;
  function loadLayout() {
    try {
      const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
      if (s && typeof s.rx === "number" && typeof s.ry === "number") {
        layout.rx = Math.min(0.8, Math.max(0.2, s.rx));
        layout.ry = Math.min(0.8, Math.max(0.2, s.ry));
      }
    } catch (err) {
      /* défauts */
    }
  }
  function applyLayout() {
    matrixEl.style.setProperty("--rx", layout.rx);
    matrixEl.style.setProperty("--ry", layout.ry);
  }
  function saveLayout() {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }

  matrixEl.addEventListener("pointerdown", (e) => {
    const sp = e.target.closest(".matrix__split");
    if (!sp) return;
    e.preventDefault();
    splitDrag = {
      axis: sp.classList.contains("matrix__split--v") ? "x" : "y",
      pointerId: e.pointerId,
    };
    sp.classList.add("is-active");
    if (sp.setPointerCapture) sp.setPointerCapture(e.pointerId);
  });
  window.addEventListener("pointermove", (e) => {
    if (!splitDrag || e.pointerId !== splitDrag.pointerId) return;
    const r = matrixEl.getBoundingClientRect();
    if (splitDrag.axis === "x") {
      layout.rx = Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width));
    } else {
      layout.ry = Math.min(0.8, Math.max(0.2, (e.clientY - r.top) / r.height));
    }
    applyLayout();
  });
  window.addEventListener("pointerup", (e) => {
    if (!splitDrag || e.pointerId !== splitDrag.pointerId) return;
    splitDrag = null;
    matrixEl.querySelectorAll(".matrix__split.is-active").forEach((s) => s.classList.remove("is-active"));
    saveLayout();
  });
  matrixEl.addEventListener("dblclick", (e) => {
    const sp = e.target.closest(".matrix__split");
    if (!sp) return;
    if (sp.classList.contains("matrix__split--v")) layout.rx = 0.5;
    else layout.ry = 0.5;
    applyLayout();
    saveLayout();
  });

  // ---------- Événements sur les tâches (délégation) ----------
  matrixEl.addEventListener("change", (e) => {
    const subCheck = e.target.closest(".subtask__check");
    if (subCheck) {
      const li = subCheck.closest(".task");
      const sub = subCheck.closest(".subtask");
      if (li && sub) toggleSub(li.dataset.id, sub.dataset.subId);
      return;
    }
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
    const repBtn = e.target.closest(".task__repeat");
    if (repBtn) {
      const li = repBtn.closest(".task");
      if (li) cycleRepeat(li.dataset.id);
      return;
    }
    const expand = e.target.closest(".task__subtoggle");
    if (expand) {
      const li = expand.closest(".task");
      if (li) {
        const id = li.dataset.id;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render();
        if (expanded.has(id)) {
          const add = matrixEl.querySelector(
            '.task[data-id="' + id + '"] .subtasks__add'
          );
          if (add) add.focus();
        }
      }
      return;
    }
    const subDel = e.target.closest(".subtask__delete");
    if (subDel) {
      const li = subDel.closest(".task");
      const sub = subDel.closest(".subtask");
      if (li && sub) deleteSub(li.dataset.id, sub.dataset.subId);
      return;
    }
    const del = e.target.closest(".task__delete");
    if (del) {
      const li = del.closest(".task");
      if (li) deleteTask(li.dataset.id);
    }
  });

  // Ajout d'une sous-tâche (Entrée dans le champ dédié)
  matrixEl.addEventListener("keydown", (e) => {
    const add = e.target.closest(".subtasks__add");
    if (!add) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const li = add.closest(".task");
      if (!li) return;
      const id = li.dataset.id;
      addSub(id, add.value);
      const next = matrixEl.querySelector('.task[data-id="' + id + '"] .subtasks__add');
      if (next) next.focus();
    } else if (e.key === "Escape") {
      add.blur();
    }
  });

  matrixEl.addEventListener("blur", (e) => {
    const text = e.target.closest(".task__text");
    if (!text) return;
    const li = text.closest(".task");
    if (li) editTask(li.dataset.id, text.textContent);
  }, true);

  // Collage en texte brut (évite d'injecter du HTML mis en forme).
  matrixEl.addEventListener("paste", (e) => {
    const text = e.target.closest(".task__text");
    if (!text) return;
    e.preventDefault();
    const plain = ((e.clipboardData || window.clipboardData).getData("text/plain") || "")
      .replace(/\s+/g, " ")
      .trim();
    document.execCommand("insertText", false, plain);
  });

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

  // ---------- Dates en langage naturel ----------
  const WEEKDAYS = {
    dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  };
  const MONTHS = {
    janvier: 0, janv: 0, jan: 0, "février": 1, fevrier: 1, "févr": 1, fevr: 1,
    mars: 2, avril: 3, avr: 3, mai: 4, juin: 5, juillet: 6, juil: 6,
    "août": 7, aout: 7, septembre: 8, sept: 8, sep: 8, octobre: 9, oct: 9,
    novembre: 10, nov: 10, "décembre": 11, decembre: 11, "déc": 11, dec: 11,
  };
  function toIsoDate(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  /** Extrait une date du texte. Renvoie {dueDate, text} (text nettoyé). */
  function parseNaturalDate(text) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let due = null;
    let re = null;

    const rel = [
      [/\baujourd'?hui\b/i, 0],
      [/\bapr[eè]s[-\s]?demain\b/i, 2],
      [/\bdemain\b/i, 1],
    ];
    for (const [rx, off] of rel) {
      if (rx.test(text)) {
        due = new Date(today);
        due.setDate(due.getDate() + off);
        re = rx;
        break;
      }
    }
    if (!due) {
      const m = text.match(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i);
      if (m) {
        const target = WEEKDAYS[m[1].toLowerCase()];
        due = new Date(today);
        let diff = (target - due.getDay() + 7) % 7;
        if (diff === 0) diff = 7; // « lundi » = le prochain lundi
        due.setDate(due.getDate() + diff);
        re = new RegExp("\\b" + m[1] + "\\b", "i");
      }
    }
    if (!due) {
      const m = text.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
      if (m) {
        const day = +m[1];
        const mon = +m[2] - 1;
        let yr = m[3] ? +m[3] : today.getFullYear();
        if (m[3] && m[3].length === 2) yr += 2000;
        let d = new Date(yr, mon, day);
        d.setHours(0, 0, 0, 0);
        if (!m[3] && d < today) d = new Date(yr + 1, mon, day);
        if (d.getMonth() === mon && d.getDate() === day) {
          due = d;
          re = new RegExp(m[0].replace(/[./-]/g, "[\\/.\\-]"));
        }
      }
    }
    if (!due) {
      const m = text.match(/\b(\d{1,2})\s+([a-zà-ÿ]+)\.?\b/i);
      if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
        const day = +m[1];
        const mon = MONTHS[m[2].toLowerCase()];
        let d = new Date(today.getFullYear(), mon, day);
        d.setHours(0, 0, 0, 0);
        if (d < today) d = new Date(today.getFullYear() + 1, mon, day);
        if (d.getDate() === day) {
          due = d;
          re = new RegExp(m[0].replace(/\./g, "\\.?"), "i");
        }
      }
    }
    if (!due) return { dueDate: null, text: text };

    let cleaned = text
      .replace(re, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+(le|pour|avant|d[’']?ici|à)\s*$/i, "")
      .replace(/[,\s]+$/g, "")
      .trim();
    if (!cleaned) cleaned = text.replace(re, " ").replace(/\s{2,}/g, " ").trim();
    return { dueDate: toIsoDate(due), text: cleaned };
  }

  // ---------- Formulaire, contrôles, pied de page ----------
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    let text = inputEl.value;
    let due = dueEl.value;
    // Si aucune date choisie explicitement, on tente de la déduire du texte.
    if (!due) {
      const parsed = parseNaturalDate(text);
      if (parsed.dueDate) {
        due = parsed.dueDate;
        text = parsed.text;
      }
    }
    addTask(text, quadrantSelectEl.value, due);
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
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchEl.value) {
      searchEl.value = "";
      searchQuery = "";
      render();
    }
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
  loadLayout();
  applyLayout();
  loadLocal();
  applyTheme();
  setSort(sortMode);
  render();
  initSync();
})();
