import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";

const API = (window.CHESSTG_CONFIG?.apiBase || "https://cocktail-mixer.onrender.com").replace(/\/$/, "");
const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("chesstg_token");
let me = null;
let game = null;
let chess = new Chess();
let selected = null;
let legalTargets = [];
let orientation = "white";
let socket = null;
let socketGeneration = 0;
let socketRetryDelay = 1000;
let selectedTime = { seconds: 180, increment: 0 };
let friendSelectedTime = { seconds: 180, increment: 0 };
let queueTimer = null;
let queueStartedAt = 0;
let queueRequestPending = false;
let queueCancelRequested = false;
let queuePollPending = false;
let displayWhiteMs = 300000;
let displayBlackMs = 300000;
let clockLastTick = Date.now();
let toastTimer = null;
let pointerDragFrom = null;
let suppressClicksUntil = 0;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
const loadingOperations = new Map();
let loadingSequence = 0;
function beginLoading(message) {
  const id = ++loadingSequence;
  loadingOperations.set(id, message);
  const dialog = $("loading-dialog");
  if (dialog && !dialog.open) dialog.showModal();
  updateLoadingDialog();
  return {
    update(nextMessage) {
      if (!loadingOperations.has(id)) return;
      loadingOperations.set(id, nextMessage);
      updateLoadingDialog();
    },
    close() {
      loadingOperations.delete(id);
      updateLoadingDialog();
    }
  };
}
function updateLoadingDialog() {
  const dialog = $("loading-dialog");
  if (!dialog) return;
  const messages = [...loadingOperations.values()];
  if (!messages.length) {
    if (dialog.open) dialog.close();
    return;
  }
  $("loading-message").textContent = messages[messages.length - 1];
  if (!dialog.open) dialog.showModal();
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(options.headers || {}) }
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Сервер не ответил за 25 секунд. Попробуй ещё раз.");
    }
    throw new Error("Не удалось связаться с сервером. Проверь интернет и попробуй ещё раз.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : body.message;
    throw new Error(detail || `Ошибка сервера: HTTP ${response.status}`);
  }
  return body;
}
async function authenticate() {
  tg?.ready(); tg?.expand();
  if (tg?.initData) {
    try {
      const data = await api("/api/auth/telegram", { method: "POST", body: JSON.stringify({ initData: tg.initData }) });
      token = data.token; localStorage.setItem("chesstg_token", token); me = data.player; return;
    } catch (error) {
      // A Telegram signature/configuration problem must not block guest play.
      toast("Не удалось войти через Telegram. Продолжаем как гость.");
    }
  }
  if (token) {
    try { me = await api("/api/me"); return; } catch { localStorage.removeItem("chesstg_token"); token = null; }
  }
  const guestName = "Guest " + Math.floor(1000 + Math.random() * 9000);
  const data = await api("/api/auth/guest", { method: "POST", body: JSON.stringify({ name: guestName }) });
  token = data.token; localStorage.setItem("chesstg_token", token); me = data.player;
}
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const target = $(name + "-view"); if (target) target.classList.add("active");
  document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "games") loadGames();
  if (name === "rating") loadLeaderboard();
  if (name === "profile") loadProfile();
  if (name !== "play" && (queueTimer || queueRequestPending)) {
    if (queueRequestPending) queueCancelRequested = true;
    else cancelQueue();
  }
}
function updateUser() {
  $("username").textContent = me?.name || "Гость";
  $("avatar").textContent = (me?.name || "G").slice(0,1).toUpperCase();
  $("rating").textContent = me?.rating ?? 1200;
}
function renderMiniBoard() {
  const pieces = ["♜","♞","♝","♛","♚","♝","♞","♜","♟","♟","♟","♟","♟","♟","♟","♟","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","♙","♙","♙","♙","♙","♙","♙","♙","♖","♘","♗","♕","♔","♗","♘","♖"];
  $("mini-board").innerHTML = pieces.map((p,i)=>'<div class="mini-square '+(((Math.floor(i/8)+i%8)%2)?"dark":"light")+'">'+p+'</div>').join("");
}
function timeLabel(ms) { const sec = Math.max(0, Math.ceil(ms/1000)); return String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0"); }
function gameClock(ms, active) { return game?.initial_ms === 0 ? "Без времени" : timeLabel(ms); }
function timeControlLabel(initialMs, incrementMs) {
  if (initialMs <= 0) return "Без времени";
  return `${Math.floor(initialMs / 60000)} + ${Math.floor(incrementMs / 1000)} сек`;
}
function lockTimeOptions(locked) {
  document.querySelectorAll(".time-option").forEach(option => {
    option.disabled = locked;
    option.setAttribute("aria-disabled", String(locked));
  });
  document.querySelectorAll(".time-options").forEach(options => options.classList.toggle("locked", locked));
}
async function loadGames(target = "home-games") {
  const el = $(target);
  if (el) el.innerHTML = '<div class="loading-inline"><span class="loading-spinner" aria-hidden="true"></span><span>Загружаем открытые партии…</span></div>';
  try {
    const rows = await api("/api/games?status=waiting");
    if (!rows.length) { el.innerHTML = '<div class="empty-state">Пока никто не ждёт соперника. Создай первую партию!</div>'; if ($("games-count")) $("games-count").textContent = "0 открытых партий"; return; }
    if ($("games-count")) $("games-count").textContent = rows.length + " открытых партий";
    el.innerHTML = rows.map(g => {
      const creator = escapeHtml((g.white || g.black || "Guest").slice(0, 8));
      return `<div class="game-row"><div class="game-row-icon">♟</div><div class="game-row-info"><strong>Игрок ${creator}</strong><span>${escapeHtml(timeControlLabel(g.initial_ms, g.increment_ms))}</span></div><button class="button secondary" data-join="${escapeHtml(g.id)}">Играть</button></div>`;
    }).join("");
    el.querySelectorAll("[data-join]").forEach(b => b.addEventListener("click",()=>joinGame(b.dataset.join)));
  } catch (e) { $(target).innerHTML = '<div class="empty-state">Не удалось загрузить партии: '+escapeHtml(e.message)+'</div>'; }
}
async function loadLeaderboard() {
  $("leaderboard").innerHTML = '<div class="loading-inline"><span class="loading-spinner" aria-hidden="true"></span><span>Загружаем рейтинг…</span></div>';
  try {
    const rows = await api("/api/leaderboard");
    $("leaderboard").innerHTML = rows.length ? rows.map((p,i)=>'<div class="leader-row"><div class="leader-rank">#'+(i+1)+'</div><div><div class="leader-name">'+escapeHtml(p.name)+'</div><div class="leader-sub">'+escapeHtml(p.username)+'</div></div><div class="leader-rating">'+p.rating+'</div><div class="leader-sub">'+p.games_played+' игр</div></div>').join("") : '<div class="empty-state">Рейтинг пока пуст — стань первым игроком!</div>';
  } catch (e) { $("leaderboard").innerHTML = '<div class="empty-state">'+escapeHtml(e.message)+'</div>'; }
}
async function loadProfile() {
  const history = $("profile-history");
  history.innerHTML = '<div class="empty-state">Загружаем историю…</div>';
  try {
    const [profile, games] = await Promise.all([
      api("/api/me"),
      api("/api/games/history?limit=30")
    ]);
    me = profile;
    updateUser();
    $("profile-rating").textContent = profile.rating;
    $("profile-games").textContent = profile.games_played;
    if (!games.length) {
      history.innerHTML = '<div class="empty-state">Здесь появятся завершённые партии.</div>';
      return;
    }
    history.innerHTML = games.map(g => {
      const opponent = g.white === me.id ? g.black : g.white;
      const won = (g.result === "1-0" && g.white === me.id) || (g.result === "0-1" && g.black === me.id);
      const draw = g.result === "1/2-1/2";
      const outcome = draw ? "Ничья" : won ? "Победа" : "Поражение";
      const date = g.created_at ? new Date(g.created_at * 1000).toLocaleDateString("ru-RU") : "";
      const opponentLabel = g.opponent_name || (opponent ? "Игрок " + opponent.slice(0, 8) : "Соперник");
      return '<div class="history-row"><div class="history-main"><strong>'+escapeHtml(opponentLabel)+'</strong><span>'+escapeHtml(timeControlLabel(g.initial_ms, g.increment_ms))+' · '+escapeHtml(date)+'</span></div><span class="history-result '+(draw?"draw":won?"win":"loss")+'">'+outcome+'</span><button class="button secondary history-open" data-history-game="'+escapeHtml(g.id)+'">Открыть</button></div>';
    }).join("");
    history.querySelectorAll("[data-history-game]").forEach(button => {
      button.addEventListener("click", () => openGame(button.dataset.historyGame));
    });
  } catch (error) {
    history.innerHTML = '<div class="empty-state">Не удалось загрузить профиль: '+escapeHtml(error.message)+'</div>';
  }
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
async function createGame() {
  const button = $("friend-create");
  const status = $("friend-create-status");
  const loading = beginLoading("Создаём партию…");
  button.disabled = true;
  button.textContent = "Создаём…";
  status.textContent = "Отправляем запрос серверу. Это может занять несколько секунд.";

  try {
    const g = await api("/api/games", {
      method: "POST",
      body: JSON.stringify({
        initial_seconds: friendSelectedTime.seconds,
        increment_seconds: friendSelectedTime.increment,
        color: "random"
      })
    });
    status.textContent = "Партия создана. Загружаем шахматную доску…";
    loading.update("Партия создана. Загружаем доску…");
    const opened = await openGame(g.id, { showLoading: false });
    if (opened) {
      $("friend-dialog").close();
      toast("Партия создана. Скопируй ссылку и отправь другу.");
    } else {
      status.textContent = "Партия создана, но доска не открылась. Обновляем список открытых партий…";
      await loadGames();
      toast("Партия создана, но не удалось открыть доску. Она добавлена в открытые партии.");
    }
  } catch (error) {
    status.textContent = "Не удалось создать партию: " + error.message;
    toast("Ошибка создания партии: " + error.message);
  } finally {
    loading.close();
    button.disabled = false;
    button.textContent = "Создать партию →";
  }
}
async function joinGame(id) {
  const loading = beginLoading("Присоединяемся к партии…");
  try {
    await api("/api/games/"+id+"/join",{method:"POST"});
    loading.update("Загружаем шахматную доску…");
    await openGame(id, { showLoading: false });
  } catch(e) {
    toast("Не удалось присоединиться: " + e.message);
    await loadGames();
  } finally {
    loading.close();
  }
}
async function openGame(id, options = {}) {
  const loading = options.showLoading === false ? null : beginLoading("Загружаем партию…");
  try {
    let openedGame = await api("/api/games/" + id);
    if (openedGame.status === "waiting" && openedGame.white !== me.id && openedGame.black !== me.id) {
      openedGame = await api("/api/games/" + id + "/join", { method: "POST" });
    }
    game = openedGame;
    chess = new Chess(game.fen === "start" ? undefined : game.fen);
    displayWhiteMs = game.white_ms;
    displayBlackMs = game.black_ms;
    clockLastTick = Date.now();
    orientation = game.white === me.id ? "white" : "black";
    selected = null;
    legalTargets = [];
    showView("game");
    renderGame();
    connectSocket(id);
    $("game-code").textContent = "GAME / " + id.slice(0, 8).toUpperCase();
    return true;
  } catch (error) {
    console.error("Failed to open ChessTG game", { gameId: id, error });
    toast("Не удалось открыть партию: " + error.message);
    return false;
  } finally {
    loading?.close();
  }
}
function connectSocket(id) {
  const generation = ++socketGeneration;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  const url = API.replace(/^http/,"ws")+"/ws/games/"+id;
  const connection = new WebSocket(url);
  socket = connection;
  connection.onopen = () => {
    if (generation !== socketGeneration) return;
    socketRetryDelay = 1000;
    connection.send(token);
  };
  connection.onmessage = event => {
    if (generation !== socketGeneration) return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.game) applyGame(msg.game);
      if (msg.type === "matched" && msg.game) { toast("Соперник найден!"); openGame(msg.game.id); }
    } catch (error) {
      console.error("Invalid ChessTG WebSocket message", error);
    }
  };
  connection.onclose = () => {
    if (generation !== socketGeneration || !game || game.id !== id || game.status !== "active") return;
    const delay = socketRetryDelay;
    socketRetryDelay = Math.min(socketRetryDelay * 2, 15000);
    window.setTimeout(() => {
      if (generation === socketGeneration && game?.id === id && game.status === "active") connectSocket(id);
    }, delay);
  };
}
function applyGame(g) {
  game = g;
  chess = new Chess(g.fen === "start" ? undefined : g.fen);
  displayWhiteMs = g.white_ms; displayBlackMs = g.black_ms; clockLastTick = Date.now();
  selected = null; legalTargets = []; renderGame();
}
function renderGame() {
  if (!game) return;
  const isWhite = game.white === me.id;
  const opponent = isWhite ? game.black : game.white;
  $("self-name").textContent = me.name || "Ты";
  $("self-rating").textContent = me.rating || 1200;
  $("opponent-name").textContent = opponent ? "Игрок "+opponent.slice(0,8) : "Ожидание соперника";
  $("opponent-rating").textContent = opponent ? "Соперник" : "Пригласи друга по ссылке";
  $("self-clock").textContent = gameClock(isWhite ? displayWhiteMs : displayBlackMs);
  $("opponent-clock").textContent = gameClock(isWhite ? displayBlackMs : displayWhiteMs);
  $("game-status").textContent = game.status === "waiting" ? "Ожидание соперника" : game.status === "finished" ? "Партия завершена · "+(game.result || "") : chess.isCheck() ? "Шах!" : chess.turn() === (isWhite ? "w" : "b") ? "Твой ход" : "Ход соперника";
  $("game-hint").textContent = game.status === "waiting" ? "Отправь ссылку другу или подожди, пока кто-нибудь присоединится." : game.status === "finished" ? "Результат: "+game.result : chess.turn() === (isWhite ? "w" : "b") ? "Выбери фигуру и клетку назначения." : "Сейчас ход соперника.";
  $("move-count").textContent = game.moves.length;
  const moveList = $("move-list");
  moveList.innerHTML = game.moves.length ? game.moves.map((m,i)=>'<div class="move-cell"><span class="move-number">'+(Math.floor(i/2)+1)+(i%2?".":"…")+'</span>'+escapeHtml(m.san)+'</div>').join("") : '<div class="move-empty">Ходы появятся здесь</div>';
  const active = game.status === "active";
  $("draw-button").disabled = !active || game.draw_offer_by === me.id;
  $("draw-button").textContent = game.draw_offer_by && game.draw_offer_by !== me.id
    ? "Принять ничью"
    : game.draw_offer_by === me.id ? "Ожидаем ответ на ничью" : "Предложить ничью";
  $("claim-draw-button").disabled = !active || !game.can_claim_draw;
  $("claim-draw-button").title = game.can_claim_draw
    ? "Заявить ничью по правилу троекратного повторения или 50 ходов"
    : "Сейчас нет основания для заявления ничьей";
  $("resign-button").disabled = !active;
  renderBoard();
}
function tickClocks() {
  if (!game || game.status !== "active" || game.initial_ms === 0) return;
  const now = Date.now();
  const elapsed = now - clockLastTick;
  clockLastTick = now;
  if (chess.turn() === "w") displayWhiteMs = Math.max(0, displayWhiteMs - elapsed);
  else displayBlackMs = Math.max(0, displayBlackMs - elapsed);
  const whiteMe = game.white === me.id;
  $("self-clock").textContent = timeLabel(whiteMe ? displayWhiteMs : displayBlackMs);
  $("opponent-clock").textContent = timeLabel(whiteMe ? displayBlackMs : displayWhiteMs);
}
function renderBoard() {
  const board = $("chessboard"); if (!board) return;
  const matrix = chess.board();
  const rows = orientation === "white" ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const cols = orientation === "white" ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
  const last = game?.moves?.at(-1)?.uci || "";
  const checked = chess.isCheck() ? chess.turn() : null;
  let html = "";
  rows.forEach(r=>cols.forEach(c=>{
    const square = "abcdefgh"[c]+(r+1);
    const piece = matrix[r][c];
    const isLight = (r+c)%2===1;
    const classes = ["square",isLight?"light":"dark"];
    if (selected===square) classes.push("selected");
    if (legalTargets.some(m=>m.to===square)) classes.push(piece?"capture":"legal");
    if (last.slice(0,2)===square || last.slice(2,4)===square) classes.push("last");
    if (checked && piece?.color===checked && piece.type==="k") classes.push("check");
    html += '<button class="'+classes.join(" ")+'" data-square="'+square+'" role="gridcell" aria-label="'+square+'">'+(piece?'<span class="piece">'+pieceGlyph(piece)+'</span>':"")+'</button>';
  }));
  board.innerHTML = html;
  board.querySelectorAll("[data-square]").forEach(b=>b.addEventListener("click",()=>{
    if (Date.now() < suppressClicksUntil) return;
    squareClick(b.dataset.square);
  }));
  board.onpointerdown = (event) => {
    const cell = event.target.closest("[data-square]");
    if (!cell || !game || game.status !== "active") return;
    const piece = chess.get(cell.dataset.square);
    const myTurn = (chess.turn() === "w" && game.white === me.id) || (chess.turn() === "b" && game.black === me.id);
    if (piece && piece.color === chess.turn() && myTurn) pointerDragFrom = cell.dataset.square;
  };
  board.onpointerup = async (event) => {
    const from = pointerDragFrom;
    pointerDragFrom = null;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-square]");
    if (!from || !target || target.dataset.square === from) return;
    suppressClicksUntil = Date.now() + 500;
    await squareClick(from);
    await squareClick(target.dataset.square);
  };
  const files = orientation==="white"?"abcdefgh":"hgfedcba";
  const ranks = orientation==="white"?"87654321":"12345678";
  $("game-view").querySelector(".top-files").textContent = files.split("").join("   ");
  $("game-view").querySelector(".bottom-files").textContent = files.split("").join("   ");
  $("game-view").querySelector(".left-ranks").textContent = ranks.split("").join(" ");
  $("game-view").querySelector(".right-ranks").textContent = ranks.split("").join(" ");
}
function pieceGlyph(p) {
  const white={k:"♔",q:"♕",r:"♖",b:"♗",n:"♘",p:"♙"}, black={k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
  return (p.color==="w"?white:black)[p.type];
}
async function squareClick(square) {
  if (!game || game.status!=="active" || game.white!==me.id && game.black!==me.id) return;
  const myTurn = (chess.turn()==="w" && game.white===me.id)||(chess.turn()==="b"&&game.black===me.id);
  if (!myTurn) return;
  const piece = chess.get(square);
  if (selected && legalTargets.some(m=>m.to===square)) {
    let promotion = "q";
    const movePreview = legalTargets.find(m=>m.to===square);
    if (movePreview.promotion) promotion = (window.prompt("Превращение: q — ферзь, r — ладья, b — слон, n — конь","q")||"q").toLowerCase();
    const uci = selected+square+(movePreview.promotion?promotion:"");
    const loading = beginLoading("Отправляем ход…");
    try {
      const updated = await api("/api/games/"+game.id+"/moves",{method:"POST",body:JSON.stringify({uci})});
      applyGame(updated);
    } catch(e) {
      toast("Не удалось сделать ход: " + e.message);
      try { const latest=await api("/api/games/"+game.id); applyGame(latest); }
      catch(refreshError) { toast("Не удалось обновить партию: " + refreshError.message); }
    } finally {
      loading.close();
    }
    return;
  }
  if (piece && piece.color===chess.turn()) {
    selected=square; legalTargets=chess.moves({square,verbose:true}); renderBoard();
  } else { selected=null; legalTargets=[]; renderBoard(); }
}
async function startQueue() {
  if (queueRequestPending || queueTimer) return;
  queueRequestPending = true;
  queueCancelRequested = false;
  lockTimeOptions(true);
  const button = $("match-button");
  const loading = beginLoading("Подключаемся к поиску соперника…");
  button.disabled = true;
  button.textContent = "Подключаемся…";
  try {
    queueStartedAt = Date.now()/1000;
    const result = await api("/api/matchmaking",{method:"POST",body:JSON.stringify({initial_seconds:selectedTime.seconds,increment_seconds:selectedTime.increment})});
    if (result.status==="matched") {
      loading.update("Соперник найден. Загружаем партию…");
      loading.close();
      await openGame(result.game.id);
      return;
    }
    if (queueCancelRequested) {
      loading.update("Отменяем поиск…");
      await api("/api/matchmaking", {method:"DELETE"});
      resetQueueUi();
      return;
    }
    $("match-title").textContent = "Ищем соперника…";
    $("match-description").textContent = "Контроль времени зафиксирован на время поиска. Отмени поиск, чтобы изменить его.";
    button.textContent = "Отменить поиск";
    button.classList.remove("primary"); button.classList.add("secondary");
    queueTimer=setInterval(async()=>{
      if (queuePollPending) return;
      queuePollPending = true;
      try {
        const status=await api("/api/matchmaking?since="+queueStartedAt);
        if(status.status==="matched"){stopQueueTimer();toast("Соперник найден!");await openGame(status.game.id);}
      }catch(e){stopQueueTimer();toast(e.message);await cancelQueue(false);}
      finally { queuePollPending = false; }
    },2200);
  } catch(e) {
    toast(e.message);
    $("match-title").textContent = "Готов к партии?";
    $("match-description").textContent = "Нажми кнопку — поиск начнётся сразу.";
    button.innerHTML = 'Найти соперника <span>→</span>';
    button.classList.add("primary"); button.classList.remove("secondary");
  } finally {
    loading.close();
    queueRequestPending = false;
    button.disabled = false;
    lockTimeOptions(Boolean(queueTimer));
  }
}
function stopQueueTimer() { if(queueTimer){clearInterval(queueTimer);queueTimer=null;} }
function resetQueueUi() {
  stopQueueTimer();
  queueCancelRequested = false;
  lockTimeOptions(false);
  $("match-title").textContent="Готов к партии?";
  $("match-description").textContent="Нажми кнопку — поиск начнётся сразу.";
  const button = $("match-button");
  button.disabled = false;
  button.innerHTML='Найти соперника <span>→</span>';
  button.classList.add("primary");
  button.classList.remove("secondary");
}
async function cancelQueue(showError = true) {
  if (queueRequestPending) return;
  queueRequestPending = true;
  const button = $("match-button");
  button.disabled = true;
  stopQueueTimer();
  try { await api("/api/matchmaking",{method:"DELETE"}); }
  catch (e) { if (showError) toast(e.message); }
  finally {
    queueRequestPending = false;
    button.disabled = false;
    resetQueueUi();
  }
}
async function drawAction() {
  if(!game)return;
  const loading = beginLoading("Отправляем предложение ничьей…");
  try {
    const accepted=game.draw_offer_by && game.draw_offer_by!==me.id;
    const updated=await api("/api/games/"+game.id+"/draw",{method:"POST",body:JSON.stringify({accept:!!accepted})});
    applyGame(updated);toast(accepted?"Ничья принята":"Предложение ничьей отправлено");
  }catch(e){toast(e.message);}
  finally { loading.close(); }
}
async function claimDrawAction() {
  if (!game || game.status !== "active") return;
  const loading = beginLoading("Проверяем возможность ничьей…");
  try {
    const updated = await api("/api/games/"+game.id+"/claim-draw", {method:"POST"});
    applyGame(updated);
    toast("Ничья заявлена по правилам");
  } catch (e) {
    toast(e.message);
  } finally { loading.close(); }
}
async function resignAction() {
  if(!game || game.status !== "active" || !confirm("Точно сдаться?"))return;
  const loading = beginLoading("Завершаем партию…");
  try { const updated=await api("/api/games/"+game.id+"/resign",{method:"POST"});applyGame(updated); }
  catch(e){toast(e.message);}
  finally { loading.close(); }
}
function bindEvents() {
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $("hero-quick").onclick=$("mode-random").onclick=()=>showView("play");
  const openFriendDialog = () => { const dialog=$("friend-dialog"); if(dialog?.showModal) dialog.showModal(); else toast("Открой страницу игры и создай комнату."); };
  $("hero-create").onclick=openFriendDialog;
  $("mode-friend").onclick=openFriendDialog;
  $("friend-close").onclick=()=> { if (!$("friend-create").disabled) $("friend-dialog").close(); };
  $("friend-dialog").addEventListener("cancel", event => {
    if ($("friend-create").disabled) event.preventDefault();
  });
  $("friend-create").onclick = () => {
    if (!$("friend-create").disabled) createGame();
  };
  $("friend-dialog").addEventListener("click",event=>{
    if(event.target===$("friend-dialog") && !$("friend-create").disabled) $("friend-dialog").close();
  });
  $("mode-open").onclick=()=>showView("games");
  $("refresh-games").onclick=()=>loadGames();
  $("games-refresh").onclick=()=>loadGames("games-list");
  document.querySelectorAll(".time-options").forEach(group => {
    group.querySelectorAll(".time-option").forEach(button => button.addEventListener("click", () => {
      group.querySelectorAll(".time-option").forEach(option => {
        option.classList.remove("active");
        option.setAttribute("aria-pressed", "false");
      });
      button.classList.add("active");
      button.setAttribute("aria-pressed", "true");
      const control = {
        seconds: Number(button.dataset.time),
        increment: Number(button.dataset.inc)
      };
      if (group.classList.contains("friend-time-options")) friendSelectedTime = control;
      else selectedTime = control;
    }));
  });
  $("match-button").addEventListener("click",()=>{ if (queueRequestPending) return; if (queueTimer) cancelQueue(); else startQueue(); });
  lockTimeOptions(false);
  $("back-lobby").onclick=()=>{
    socketGeneration += 1;
    if(socket){socket.onclose=null;socket.close();socket=null;}
    game=null;
    showView("home");
  };
  $("draw-button").onclick=drawAction;
  $("claim-draw-button").onclick=claimDrawAction;
  $("resign-button").onclick=resignAction;
  $("copy-link").onclick=async()=>{if(!game)return;const url=game.invite_url || (location.origin+location.pathname+"?game="+game.id);try{await navigator.clipboard.writeText(url);toast("Ссылка скопирована");}catch{toast(url);}};
}
async function boot() {
  renderMiniBoard();bindEvents();setInterval(tickClocks,250);
  const loading = beginLoading("Подключаемся к ChessTG…");
  try {
    loading.update("Проверяем вход и загружаем профиль…");
    await authenticate();
    updateUser();
    loading.update("Загружаем открытые партии…");
    await loadGames();
    const params = new URLSearchParams(location.search);
    const startParam = tg?.initDataUnsafe?.start_param || "";
    const roomFromStart = startParam.startsWith("game_") ? startParam.slice(5) : "";
    const roomId = roomFromStart || params.get("game");
    if (roomId) {
      await openGame(roomId);
    } else {
      const action = params.get("action");
      if (action === "find") showView("play");
      else if (action === "create") await createGame();
      else if (action === "rooms") showView("games");
      else if (action === "rating") showView("rating");
    }
  } catch(e) {
    toast("Не удалось подключиться к серверу: "+e.message);
    $("home-games").innerHTML='<div class="empty-state">Не удалось подключиться: '+escapeHtml(e.message)+' <button class="button secondary" id="retry-boot" type="button">Повторить</button></div>';
    $("retry-boot")?.addEventListener("click", () => window.location.reload());
  } finally {
    loading.close();
  }
}
boot();
