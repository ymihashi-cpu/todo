'use strict';

const STORAGE_KEY = 'todo-app/v1';
const SORT_KEY = 'todo-app/v1/sort';

const FILTERS = {
  all: () => true,
  active: (todo) => !todo.completed,
  completed: (todo) => todo.completed,
};

const FILTER_EMPTY_MESSAGES = {
  active: '未完了のタスクはありません。',
  completed: '完了したタスクはありません。',
};

// manual は保存されている順（ドラッグなどで並べた順）のまま表示する
const SORTS = {
  manual: null,
  due: compareDue,
};

const HINTS = {
  manual: 'ドラッグ（スマホでは左端のつまみ）、または Alt + ↑↓ キーで並び替えできます。',
  due: '期限が近い順に表示しています（期限なしは最後）。並び替えるには並び順を「手動」にしてください。',
};

// 項目の中でフォーカスを受け取る部品
const ITEM_CONTROLS = ['.toggle', '.edit-btn', '.delete-btn'];

const UNDO_TIMEOUT = 8000; // 「元に戻す」を表示しておく時間 (ms)
const DRAG_THRESHOLD = 5; // マウスをこれ以上動かしたらドラッグ開始（クリックと区別する）
const AUTO_SCROLL_EDGE = 48; // ドラッグ中、画面の上下端からこの距離に入ったらスクロールする
const AUTO_SCROLL_SPEED = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const els = {
  form: document.getElementById('new-form'),
  input: document.getElementById('new-title'),
  due: document.getElementById('new-due'),
  main: document.getElementById('main'),
  toggleAll: document.getElementById('toggle-all'),
  sort: document.getElementById('sort'),
  filterLinks: document.querySelectorAll('.filters a'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  clearCompleted: document.getElementById('clear-completed'),
  hint: document.getElementById('hint'),
  empty: document.getElementById('empty'),
  toast: document.getElementById('toast'),
};

const state = {
  todos: load(),
  filter: filterFromHash(),
  sort: loadSort(),
  editingId: null,
  drag: null,
  // 「元に戻す」で戻せる削除。{ entries: [{ todo, index }], timer }
  undo: null,
};

// ---- 永続化 ----

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(data)) return [];
    // 期限 (due) 追加前に保存されたデータも読めるようにする
    return data.filter(isValidTodo).map((todo) => ({ ...todo, due: todo.due ?? null }));
  } catch {
    return [];
  }
}

function loadSort() {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return Object.hasOwn(SORTS, value) ? value : 'manual';
  } catch {
    return 'manual';
  }
}

function save() {
  store(STORAGE_KEY, JSON.stringify(state.todos));
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ストレージが使えない環境（プライベートモード等）ではメモリ上だけで動かす
  }
}

function isValidTodo(todo) {
  return (
    todo !== null &&
    typeof todo === 'object' &&
    typeof todo.id === 'string' &&
    typeof todo.title === 'string' &&
    typeof todo.completed === 'boolean' &&
    (todo.due == null || (typeof todo.due === 'string' && DATE_RE.test(todo.due)))
  );
}

// ローカルタイムでの今日を YYYY-MM-DD で返す（input[type=date] の値と比較できる形）
function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

// 期限が近い順。期限なしは最後にし、同じ期限どうしは手動の並び順を保つ（sort は安定）
function compareDue(a, b) {
  if (a.due === b.due) return 0;
  if (!a.due) return 1;
  if (!b.due) return -1;
  return a.due < b.due ? -1 : 1;
}

function newId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function filterFromHash() {
  const name = location.hash.replace(/^#\/?/, '');
  return Object.hasOwn(FILTERS, name) ? name : 'all';
}

// ---- 操作 ----

function commit() {
  save();
  render();
}

function findTodo(id) {
  return state.todos.find((todo) => todo.id === id);
}

function addTodo(title, due) {
  state.todos.push({ id: newId(), title, completed: false, due: due || null });
  commit();
}

// id のタスクを targetId のタスクの前 (before) または後 (after) に移動する
function moveTodo(id, targetId, position) {
  if (id === targetId) return;
  const todo = findTodo(id);
  if (!todo || !findTodo(targetId)) return;
  const rest = state.todos.filter((t) => t.id !== id);
  const index = rest.findIndex((t) => t.id === targetId) + (position === 'after' ? 1 : 0);
  rest.splice(index, 0, todo);
  state.todos = rest;
  commit();
}

function setCompleted(id, completed) {
  const todo = findTodo(id);
  if (!todo) return;
  todo.completed = completed;
  commit();
}

function setAllCompleted(completed) {
  state.todos.forEach((todo) => {
    todo.completed = completed;
  });
  commit();
}

function removeTodo(id) {
  removeTodos((todo) => todo.id === id);
}

function clearCompleted() {
  removeTodos(FILTERS.completed);
}

// 条件に合うタスクを取り除き、「元に戻す」で同じ位置へ戻せるように記録する
function removeTodos(predicate) {
  const removed = [];
  // 後ろから取り除くと、記録した位置があとで取り除くタスクの影響を受けない
  for (let i = state.todos.length - 1; i >= 0; i--) {
    if (predicate(state.todos[i])) {
      removed.push({ todo: state.todos[i], index: i });
      state.todos.splice(i, 1);
    }
  }
  commit();
  if (removed.length === 0) return;
  // 「元に戻す」が出ている間に続けて削除したら、まとめて戻せるようにする
  showUndo([...(state.undo ? state.undo.entries : []), ...removed]);
}

// 戻したタスクの id を返す
function undoRemove() {
  if (!state.undo) return [];
  const { entries } = state.undo;
  hideUndo();
  const restored = [];
  // 取り除いたときと逆の順に差し込むと、それぞれ元の位置に戻る
  for (let i = entries.length - 1; i >= 0; i--) {
    const { todo, index } = entries[i];
    if (findTodo(todo.id)) continue;
    state.todos.splice(Math.min(index, state.todos.length), 0, todo);
    restored.push(todo.id);
  }
  commit();
  return restored;
}

function startEdit(id) {
  state.editingId = id;
  render();
  const input = els.list.querySelector('.edit');
  if (input) {
    input.focus();
    input.select();
  }
}

// 空文字で確定した場合はタスクを削除する
function finishEdit(id, { title, due }, { refocus = false } = {}) {
  // Enter で確定した直後の blur による二重確定を防ぐ
  if (state.editingId !== id) return;
  state.editingId = null;

  const todo = findTodo(id);
  const trimmed = title.trim();
  if (todo && trimmed) {
    todo.title = trimmed;
    todo.due = due || null;
    commit();
  } else {
    removeTodo(id);
  }
  if (refocus) focusItem(id);
}

function cancelEdit(id) {
  if (state.editingId !== id) return;
  state.editingId = null;
  render();
  focusItem(id);
}

function itemElement(id) {
  return els.list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
}

function focusItem(id, selector = '.edit-btn') {
  const el = itemElement(id)?.querySelector(selector);
  (el || els.input).focus();
}

// ---- 描画 ----

function render() {
  const { todos, filter, sort } = state;
  const visible = todos.filter(FILTERS[filter]);
  if (SORTS[sort]) visible.sort(SORTS[sort]);
  const remaining = todos.filter(FILTERS.active).length;
  const focus = captureFocus();

  els.main.hidden = todos.length === 0;
  els.empty.hidden = todos.length !== 0;

  if (visible.length === 0 && todos.length !== 0) {
    const li = document.createElement('li');
    li.className = 'filter-empty';
    li.textContent = FILTER_EMPTY_MESSAGES[filter];
    els.list.replaceChildren(li);
  } else {
    els.list.replaceChildren(...visible.map(renderItem));
  }

  els.count.textContent = `残り ${remaining} 件 / 全 ${todos.length} 件`;
  els.toggleAll.checked = todos.length !== 0 && remaining === 0;
  els.clearCompleted.hidden = remaining === todos.length;
  els.sort.value = sort;
  els.hint.textContent = HINTS[sort];

  els.filterLinks.forEach((link) => {
    if (link.dataset.filter === filter) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  restoreFocus(focus);
}

// 描き直すと項目の要素が作り直されてフォーカスが外れるので、
// どの項目のどの部品にあったかと、その前後の項目を覚えておく
function captureFocus() {
  const el = document.activeElement;
  const li = el && els.list.contains(el) ? el.closest('li.item') : null;
  const selector = li && ITEM_CONTROLS.find((s) => el.matches(s));
  if (!selector) return null;
  const ids = [li, li.nextElementSibling, li.previousElementSibling]
    .filter((item) => item && item.matches('.item'))
    .map((item) => item.dataset.id);
  return { selector, ids };
}

function restoreFocus(saved) {
  if (!saved) return;
  const [id, ...neighbors] = saved.ids;
  const li = itemElement(id);
  if (li) {
    // 編集モードに切り替わった場合などは、呼び出し元がフォーカス先を決める
    li.querySelector(saved.selector)?.focus();
    return;
  }
  // 削除や絞り込みで項目が消えたら、隣の項目の同じ部品へ（なければ入力欄へ）
  const target = neighbors.map((n) => itemElement(n)?.querySelector(saved.selector)).find(Boolean);
  (target || els.input).focus();
}

function renderItem(todo) {
  const li = document.createElement('li');
  li.className = todo.completed ? 'item completed' : 'item';
  li.dataset.id = todo.id;

  if (state.editingId === todo.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit';
    input.value = todo.title;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'タスクを編集（Enter で確定、Esc で取り消し）');

    const due = document.createElement('input');
    due.type = 'date';
    due.className = 'due-input edit-due';
    due.value = todo.due || '';
    due.setAttribute('aria-label', '期限を編集（空欄で期限なし）');

    li.append(input, due);
    return li;
  }

  // 期限順で表示しているときは並び替えできない
  if (state.sort === 'manual') {
    li.classList.add('sortable');
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.title = 'ドラッグで並び替え';
    handle.setAttribute('aria-hidden', 'true');
    li.append(handle);
  }

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'toggle';
  checkbox.checked = todo.completed;
  checkbox.setAttribute('aria-label', `「${todo.title}」を完了にする`);

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = todo.title;
  title.title = 'ダブルクリックで編集';

  li.append(checkbox, title);
  if (todo.due) li.append(dueBadge(todo));
  li.append(
    iconButton('編集', 'edit-btn', `「${todo.title}」を編集`),
    iconButton('削除', 'delete-btn', `「${todo.title}」を削除`),
  );
  return li;
}

function dueBadge(todo) {
  const span = document.createElement('span');
  span.className = 'due';
  const today = todayString();

  // 完了済みのタスクは期限切れ扱いにしない
  if (!todo.completed && todo.due < today) {
    span.classList.add('overdue');
    span.textContent = `期限切れ ${formatDate(todo.due)}`;
  } else if (!todo.completed && todo.due === today) {
    span.classList.add('today');
    span.textContent = '今日まで';
  } else {
    span.textContent = `期限 ${formatDate(todo.due)}`;
  }
  return span;
}

function iconButton(text, className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${className}`;
  button.textContent = text;
  button.setAttribute('aria-label', label);
  return button;
}

// ---- 元に戻す ----

function showUndo(entries) {
  if (state.undo) clearTimeout(state.undo.timer);
  state.undo = { entries, timer: 0 };

  const message = document.createElement('span');
  message.className = 'toast-message';
  message.textContent =
    entries.length === 1
      ? `「${truncate(entries[0].todo.title, 20)}」を削除しました`
      : `${entries.length} 件のタスクを削除しました`;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'undo-btn';
  button.textContent = '元に戻す';
  button.title = 'Ctrl + Z でも元に戻せます';
  button.setAttribute('aria-keyshortcuts', 'Control+Z');

  const card = document.createElement('div');
  card.className = 'toast-card';
  card.append(message, button);
  // #toast は常に置いてある読み上げ領域 (role="status") なので、中身だけ入れ替える
  els.toast.replaceChildren(card);
  scheduleHideUndo();
}

function hideUndo() {
  if (!state.undo) return;
  clearTimeout(state.undo.timer);
  state.undo = null;
  els.toast.replaceChildren();
}

function scheduleHideUndo() {
  if (!state.undo) return;
  clearTimeout(state.undo.timer);
  state.undo.timer = setTimeout(hideUndo, UNDO_TIMEOUT);
}

function pauseHideUndo() {
  if (state.undo) clearTimeout(state.undo.timer);
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

// ---- イベント ----

function itemId(el) {
  return el.closest('li').dataset.id;
}

function editValues(li) {
  return {
    title: li.querySelector('.edit').value,
    due: li.querySelector('.edit-due').value,
  };
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = els.input.value.trim();
  if (!title) return;
  addTodo(title, els.due.value);
  els.input.value = '';
  els.due.value = '';
  els.input.focus();
});

els.list.addEventListener('change', (event) => {
  if (event.target.matches('.toggle')) {
    setCompleted(itemId(event.target), event.target.checked);
  }
});

els.list.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('.delete-btn')) removeTodo(itemId(button));
  else if (button.matches('.edit-btn')) startEdit(itemId(button));
});

els.list.addEventListener('dblclick', (event) => {
  if (event.target.matches('.title')) startEdit(itemId(event.target));
});

els.list.addEventListener('keydown', (event) => {
  if (!event.target.matches('.edit, .edit-due')) return;
  // IME の変換確定で押された Enter は無視する
  if (event.isComposing || event.keyCode === 229) return;
  const li = event.target.closest('li');
  if (event.key === 'Enter') {
    event.preventDefault();
    finishEdit(li.dataset.id, editValues(li), { refocus: true });
  } else if (event.key === 'Escape') {
    cancelEdit(li.dataset.id);
  }
});

els.list.addEventListener('focusout', (event) => {
  if (!event.target.matches('.edit, .edit-due')) return;
  const li = event.target.closest('li');
  // タイトル欄と期限欄の間でフォーカスが移るだけなら確定しない
  if (li.contains(event.relatedTarget)) return;
  finishEdit(li.dataset.id, editValues(li));
});

// Alt + ↑↓ で並び替え（表示中の隣のタスクと入れ替える）
els.list.addEventListener('keydown', (event) => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const li = event.target.closest('li.sortable');
  if (!li) return;
  const up = event.key === 'ArrowUp';
  const sibling = up ? li.previousElementSibling : li.nextElementSibling;
  if (!sibling || !sibling.matches('.item')) return;
  event.preventDefault();
  // フォーカスは render が同じ部品に戻す
  moveTodo(li.dataset.id, sibling.dataset.id, up ? 'before' : 'after');
});

// ---- ドラッグで並び替え ----
// マウスは行のどこをつかんでもよい。タッチは画面のスクロールと区別するため、
// 左端のつまみをつかんだときだけ並び替える

function dropPosition(clientY, li) {
  const rect = li.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

// ポインターの下にある、つかんでいるもの以外のタスク
// （つかんでいる行は pointer-events: none なので elementFromPoint で拾われない）
function dropTarget() {
  const { id, x, y } = state.drag;
  const li = document.elementFromPoint(x, y)?.closest('li.item');
  return li && els.list.contains(li) && li.dataset.id !== id ? li : null;
}

function clearDropMarkers() {
  els.list.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function startDrag() {
  state.drag.active = true;
  itemElement(state.drag.id)?.classList.add('lifted');
  document.body.classList.add('is-dragging');
  state.drag.frame = requestAnimationFrame(autoScroll);
}

// つかんだ行をポインターに付いて動かし、落とす位置に線を出す
function updateDrag() {
  const { id, y, startPageY } = state.drag;
  const li = itemElement(id);
  if (li) li.style.transform = `translateY(${y + window.scrollY - startPageY}px)`;
  clearDropMarkers();
  const target = dropTarget();
  if (target) target.classList.add(`drop-${dropPosition(y, target)}`);
}

// 画面の上下端までドラッグしたら、その方向へスクロールし続ける
function autoScroll() {
  const { y } = state.drag;
  let speed = 0;
  if (y < AUTO_SCROLL_EDGE) speed = -AUTO_SCROLL_SPEED;
  else if (y > window.innerHeight - AUTO_SCROLL_EDGE) speed = AUTO_SCROLL_SPEED;
  if (speed) {
    window.scrollBy(0, speed);
    updateDrag();
  }
  state.drag.frame = requestAnimationFrame(autoScroll);
}

function endDrag(drop) {
  const { id, y, active, frame } = state.drag;
  const target = active && drop ? dropTarget() : null;
  const position = target && dropPosition(y, target);

  cancelAnimationFrame(frame);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  window.removeEventListener('keydown', onDragKeydown);
  state.drag = null;
  document.body.classList.remove('is-dragging');
  clearDropMarkers();
  const li = itemElement(id);
  if (li) {
    li.classList.remove('lifted');
    li.style.transform = '';
  }

  if (target) moveTodo(id, target.dataset.id, position);
}

function onDragMove(event) {
  const { drag } = state;
  if (event.pointerId !== drag.pointerId) return;
  // ウィンドウの外でボタンを離していたら取りやめる
  if (event.pointerType === 'mouse' && event.buttons === 0) {
    endDrag(false);
    return;
  }
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
    startDrag();
  }
  updateDrag();
}

function onDragEnd(event) {
  if (event.pointerId !== state.drag.pointerId) return;
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
  endDrag(event.type === 'pointerup');
}

// Esc でドラッグを取りやめる
function onDragKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  endDrag(false);
}

els.list.addEventListener('pointerdown', (event) => {
  if (state.drag || !event.isPrimary || event.button !== 0) return;
  const li = event.target.closest('li.sortable');
  if (!li) return;
  const isMouse = event.pointerType === 'mouse';
  if (isMouse ? event.target.closest('input, button') : !event.target.closest('.handle')) return;

  state.drag = {
    id: li.dataset.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startPageY: event.clientY + window.scrollY,
    x: event.clientX,
    y: event.clientY,
    active: false,
    frame: 0,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  window.addEventListener('keydown', onDragKeydown);

  // つまみはドラッグ専用なので、タッチでは動かす前からつかんだ状態にする
  if (!isMouse) {
    event.preventDefault();
    startDrag();
    updateDrag();
  }
});

// ---- その他 ----

els.toggleAll.addEventListener('change', () => {
  setAllCompleted(els.toggleAll.checked);
});

els.clearCompleted.addEventListener('click', clearCompleted);

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  store(SORT_KEY, state.sort);
  render();
});

els.toast.addEventListener('click', (event) => {
  const button = event.target.closest('.undo-btn');
  if (!button) return;
  const hadFocus = document.activeElement === button;
  const restored = undoRemove();
  // ボタンが消えてフォーカスを見失わないよう、戻したタスクへ移す
  if (hadFocus && restored.length) focusItem(restored[0], '.delete-btn');
});

// マウスを乗せている間やフォーカスがある間は「元に戻す」を消さない
els.toast.addEventListener('mouseenter', pauseHideUndo);
els.toast.addEventListener('focusin', pauseHideUndo);
els.toast.addEventListener('mouseleave', scheduleHideUndo);
els.toast.addEventListener('focusout', scheduleHideUndo);

// Ctrl + Z（Mac は ⌘ + Z）で直前の削除を元に戻す。文字の入力中は入力欄の取り消しを優先する
document.addEventListener('keydown', (event) => {
  if (!state.undo || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
  if (event.key.toLowerCase() !== 'z') return;
  if (event.target.closest('input:not([type="checkbox"]), textarea, select')) return;
  event.preventDefault();
  undoRemove();
});

window.addEventListener('hashchange', () => {
  state.filter = filterFromHash();
  render();
});

// 別タブでの変更を反映する
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  state.todos = load();
  state.editingId = null;
  render();
});

// 日付をまたいで開きっぱなしでも「今日まで」「期限切れ」の表示を更新する
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.editingId) render();
});

render();
