/**
 * Matrice d'Eisenhower — organiseur de tâches.
 * Application autonome, sans dépendance. Les tâches sont conservées
 * dans le localStorage du navigateur.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "eisenhower.tasks.v1";

  /** Métadonnées des quatre quadrants, dans l'ordre d'affichage. */
  const QUADRANTS = [
    {
      id: "q1",
      action: "Faire",
      label: "Urgent & Important",
    },
    {
      id: "q2",
      action: "Planifier",
      label: "Important, pas urgent",
    },
    {
      id: "q3",
      action: "Déléguer",
      label: "Urgent, pas important",
    },
    {
      id: "q4",
      action: "Éliminer",
      label: "Ni urgent ni important",
    },
  ];

  const VALID_QUADRANTS = QUADRANTS.map((q) => q.id);

  /** @type {{id:string, text:string, quadrant:string, done:boolean, createdAt:number}[]} */
  let tasks = [];

  // --- Éléments du DOM ---
  const matrixEl = document.getElementById("matrix");
  const formEl = document.getElementById("add-form");
  const inputEl = document.getElementById("task-input");
  const quadrantSelectEl = document.getElementById("quadrant-select");
  const statsEl = document.getElementById("stats");
  const clearDoneBtn = document.getElementById("clear-done");
  const ghostEl = document.getElementById("drag-ghost");

  // ---------- Persistance ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (t) =>
          t &&
          typeof t.id === "string" &&
          typeof t.text === "string" &&
          VALID_QUADRANTS.includes(t.quadrant)
      );
    } catch (err) {
      console.warn("Impossible de charger les tâches :", err);
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (err) {
      console.warn("Impossible d'enregistrer les tâches :", err);
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Opérations sur les tâches ----------
  function addTask(text, quadrant) {
    const trimmed = text.trim();
    if (!trimmed) return;
    tasks.push({
      id: uid(),
      text: trimmed,
      quadrant: VALID_QUADRANTS.includes(quadrant) ? quadrant : "q1",
      done: false,
      createdAt: Date.now(),
    });
    save();
    render();
  }

  function findTask(id) {
    return tasks.find((t) => t.id === id);
  }

  function toggleTask(id) {
    const task = findTask(id);
    if (!task) return;
    task.done = !task.done;
    save();
    render();
  }

  function deleteTask(id) {
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
  }

  function editTask(id, text) {
    const task = findTask(id);
    if (!task) return;
    const trimmed = text.trim();
    if (!trimmed) {
      deleteTask(id);
      return;
    }
    task.text = trimmed;
    save();
  }

  function moveTask(id, quadrant) {
    const task = findTask(id);
    if (!task || !VALID_QUADRANTS.includes(quadrant)) return;
    if (task.quadrant === quadrant) return;
    task.quadrant = quadrant;
    save();
    render();
  }

  function clearDone() {
    const hadDone = tasks.some((t) => t.done);
    if (!hadDone) return;
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
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

  function makeTaskElement(task) {
    const li = document.createElement("li");
    li.className = "task" + (task.done ? " is-done" : "");
    li.dataset.id = task.id;

    const handle = document.createElement("span");
    handle.className = "task__handle";
    handle.textContent = "⠿";
    handle.title = "Glisser pour déplacer";
    handle.setAttribute("aria-hidden", "true");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task__check";
    check.checked = task.done;
    check.setAttribute("aria-label", "Marquer comme terminée");

    const text = document.createElement("div");
    text.className = "task__text";
    text.textContent = task.text;
    text.contentEditable = "true";
    text.spellcheck = false;
    text.setAttribute("role", "textbox");
    text.setAttribute("aria-label", "Intitulé de la tâche (modifiable)");

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task__delete";
    del.innerHTML = "&times;";
    del.title = "Supprimer";
    del.setAttribute("aria-label", "Supprimer la tâche");

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(del);
    return li;
  }

  function render() {
    QUADRANTS.forEach((q) => {
      const list = matrixEl.querySelector('.quadrant__list[data-q="' + q.id + '"]');
      const countEl = matrixEl.querySelector(
        '.quadrant[data-q="' + q.id + '"] .quadrant__count'
      );
      const items = tasks.filter((t) => t.quadrant === q.id);
      list.innerHTML = "";

      if (items.length === 0) {
        const empty = document.createElement("li");
        empty.className = "quadrant__empty";
        empty.textContent = "Aucune tâche — glissez-en ici.";
        list.appendChild(empty);
      } else {
        items.forEach((task) => list.appendChild(makeTaskElement(task)));
      }
      countEl.textContent = String(items.length);
    });
    renderStats();
  }

  function renderStats() {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    if (total === 0) {
      statsEl.innerHTML = "Aucune tâche pour l'instant.";
    } else {
      statsEl.innerHTML =
        "<strong>" +
        total +
        "</strong> tâche" +
        (total > 1 ? "s" : "") +
        " · <strong>" +
        done +
        "</strong> terminée" +
        (done > 1 ? "s" : "");
    }
    clearDoneBtn.disabled = done === 0;
    clearDoneBtn.style.visibility = done === 0 ? "hidden" : "visible";
  }

  // ---------- Événements sur les tâches (délégation) ----------
  matrixEl.addEventListener("change", (e) => {
    const check = e.target.closest(".task__check");
    if (!check) return;
    const li = check.closest(".task");
    if (li) toggleTask(li.dataset.id);
  });

  matrixEl.addEventListener("click", (e) => {
    const del = e.target.closest(".task__delete");
    if (!del) return;
    const li = del.closest(".task");
    if (li) deleteTask(li.dataset.id);
  });

  // Édition en ligne du texte
  matrixEl.addEventListener("blur", handleTextCommit, true);
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

  function handleTextCommit(e) {
    const text = e.target.closest(".task__text");
    if (!text) return;
    const li = text.closest(".task");
    if (li) editTask(li.dataset.id, text.textContent);
  }

  // ---------- Glisser-déposer (souris + tactile via Pointer Events) ----------
  const DRAG_THRESHOLD = 6; // pixels avant de déclencher un vrai drag
  let drag = null;

  matrixEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Le drag ne démarre que depuis la poignée dédiée, pour laisser
    // le texte librement sélectionnable et éditable.
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
      overQuadrant: null,
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      startDrag(e);
    }

    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    updateDropTarget(e.clientX, e.clientY);
  });

  window.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.active) {
      if (drag.overQuadrant) moveTask(drag.id, drag.overQuadrant);
      endDrag();
    }
    drag = null;
  });

  window.addEventListener("pointercancel", () => {
    if (drag && drag.active) endDrag();
    drag = null;
  });

  function startDrag(e) {
    drag.active = true;
    drag.el.classList.add("is-dragging");
    const task = findTask(drag.id);
    ghostEl.textContent = task ? task.text : "";
    ghostEl.classList.add("is-active");
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  function moveGhost(x, y) {
    ghostEl.style.transform = "translate(" + (x + 12) + "px, " + (y + 12) + "px)";
  }

  function updateDropTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    const quadrant = el && el.closest(".quadrant");
    const newTarget = quadrant ? quadrant.dataset.q : null;
    if (newTarget === drag.overQuadrant) return;

    matrixEl
      .querySelectorAll(".quadrant.is-drop-target")
      .forEach((q) => q.classList.remove("is-drop-target"));
    drag.overQuadrant = newTarget;
    if (quadrant) quadrant.classList.add("is-drop-target");
  }

  function endDrag() {
    drag.el.classList.remove("is-dragging");
    ghostEl.classList.remove("is-active");
    ghostEl.style.transform = "translate(-9999px, -9999px)";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    matrixEl
      .querySelectorAll(".quadrant.is-drop-target")
      .forEach((q) => q.classList.remove("is-drop-target"));
  }

  // ---------- Formulaire & pied de page ----------
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    addTask(inputEl.value, quadrantSelectEl.value);
    inputEl.value = "";
    inputEl.focus();
  });

  clearDoneBtn.addEventListener("click", clearDone);

  // Synchronisation entre onglets
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      tasks = load();
      render();
    }
  });

  // ---------- Démarrage ----------
  buildSkeleton();
  tasks = load();
  render();
})();
