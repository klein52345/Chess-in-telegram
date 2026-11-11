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
let selectedTime = { seconds: 180, increment: 0 };
let queueTimer = null;
let queueStartedAt = 0;
let queueRequestPending = false;
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
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Ошибка запроса");
  return body;
}
async function authenticate() {
  tg?.ready(); tg?.expand();
  if (tg?.initData) {
    try {
      const data = await api("/api/auth/telegram", { method: "POST", body: JSON.stringify({ initData: tg.initData }) });
      token = data.token; localStorage.setItem("chesstg_token", token); me = data.player; return;
    } catch (error) {
      if (!String(error.message).toLowerCase().includes("not configured")) throw error;
      toast("Telegram-вход ещё не настроен — пока играешь как гость.");
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
  if (queueTimer && name !== "play") cancelQueue();
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
function gameClock(ms, active) { return timeLabel(ms); }
async function loadGames(target = "home-games") {
  try {
    const rows = await api("/api/games?status=waiting");
    const el = $(target);
    if (!rows.length) { el.innerHTML = '<div class="empty-state">Пока никто не ждёт соперника. Создай первую партию!</div>'; if ($("games-count")) $("games-count").textContent = "0 открытых партий"; return; }
    if ($("games-count")) $("games-count").textContent = rows.length + " открытых партий";
    el.innerHTML = rows.map(g => '<div class="game-row"><div class="game-row-icon">♟</div><div class="game-row-info"><strong>Игрок '+(g.white || g.black || "Guest").slice(0,8)+'</strong><span>'+Math.round(g.initial_ms/60000)+' мин · '+Math.round(g.increment_ms/1000)+' сек добавление</span></div><button class="button secondary" data-join="'+g.id+'">Играть</button></div>').join("");
    el.querySelectorAll("[data-join]").forEach(b => b.addEventListener("click",()=>joinGame(b.dataset.join)));
  } catch (e) { $(target).innerHTML = '<div class="empty-state">Не удалось загрузить партии: '+escapeHtml(e.message)+'</div>'; }
}
async function loadLeaderboard() {
  try {
    const rows = await api("/api/leaderboard");
    $("leaderboard").innerHTML = rows.length ? rows.map((p,i)=>'<div class="leader-row"><div class="leader-rank">#'+(i+1)+'</div><div><div class="leader-name">'+escapeHtml(p.name)+'</div><div class="leader-sub">'+escapeHtml(p.username)+'</div></div><div class="leader-rating">'+p.rating+'</div><div class="leader-sub">'+p.games_played+' игр</div></div>').join("") : '<div class="empty-state">Рейтинг пока пуст — стань первым игроком!</div>';
  } catch (e) { $("leaderboard").innerHTML = '<div class="empty-state">'+escapeHtml(e.message)+'</div>'; }
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
async function createGame() {
  try {
    const g = await api("/api/games", { method:"POST", body:JSON.stringify({initial_seconds:selectedTime.seconds,increment_seconds:selectedTime.increment,color:"random"}) });
    await openGame(g.id);
    if (g.status === "waiting") toast("Комната создана. Отправь ссылку сопернику.");
  } catch(e) { toast(e.message); }
}
async function joinGame(id) {
  try { await api("/api/games/"+id+"/join",{method:"POST"}); await openGame(id); }
  catch(e) { toast(e.message); await loadGames(); }
}
async function openGame(id) {
  try {
    game = await api("/api/games/"+id);
    if (game.status === "waiting" && game.white !== me.id && game.black !== me.id) game = await api("/api/games/"+id+"/join", { method:"POST" });
    chess = new Chess(game.fen === "start" ? undefined : game.fen);
    displayWhiteMs = game.white_ms; displayBlackMs = game.black_ms; clockLastTick = Date.now();
    orientation = game.white === me.id ? "white" : "black";
    selected = null; legalTargets = [];
    showView("game"); renderGame(); connectSocket(id);
    $("game-code").textContent = "GAME / "+id.slice(0,8).toUpperCase();
  } catch(e) { toast(e.message); }
}
function connectSocket(id) {
  if (socket) socket.close();
  const url = API.replace(/^http/,"ws")+"/ws/games/"+id+"?token="+encodeURIComponent(token);
  socket = new WebSocket(url);
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.game) applyGame(msg.game);
    if (msg.type === "matched" && msg.game) { toast("Соперник найден!"); openGame(msg.game.id); }
  };
  socket.onclose = () => {};
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
  renderBoard();
}
function tickClocks() {
  if (!game || game.status !== "active") return;
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
    try { const updated = await api("/api/games/"+game.id+"/moves",{method:"POST",body:JSON.stringify({uci})}); applyGame(updated); }
    catch(e) { toast(e.message); const latest=await api("/api/games/"+game.id); applyGame(latest); }
    return;
  }
  if (piece && piece.color===chess.turn()) {
    selected=square; legalTargets=chess.moves({square,verbose:true}); renderBoard();
  } else { selected=null; legalTargets=[]; renderBoard(); }
}
async function startQueue() {
  if (queueRequestPending || queueTimer) return;
  queueRequestPending = true;
  const button = $("match-button");
  button.disabled = true;
  button.textContent = "Подключаемся…";
  try {
    queueStartedAt = Date.now()/1000;
    const result = await api("/api/matchmaking",{method:"POST",body:JSON.stringify({initial_seconds:selectedTime.seconds,increment_seconds:selectedTime.increment})});
    if (result.status==="matched") { await openGame(result.game.id); return; }
    $("match-title").textContent = "Ищем соперника…";
    $("match-description").textContent = "Не закрывай страницу — сообщим, когда найдём игрока.";
    button.textContent = "Отменить поиск";
    button.classList.remove("primary"); button.classList.add("secondary");
    queueTimer=setInterval(async()=>{
      try {
        const status=await api("/api/matchmaking?since="+queueStartedAt);
        if(status.status==="matched"){stopQueueTimer();toast("Соперник найден!");await openGame(status.game.id);}
      }catch(e){stopQueueTimer();toast(e.message);await cancelQueue(false);}
    },2200);
  } catch(e) {
    toast(e.message);
    $("match-title").textContent = "Готов к партии?";
    $("match-description").textContent = "Нажми кнопку — поиск начнётся сразу.";
    button.innerHTML = 'Найти соперника <span>→</span>';
    button.classList.add("primary"); button.classList.remove("secondary");
  } finally {
    queueRequestPending = false;
    button.disabled = false;
  }
}
function stopQueueTimer() { if(queueTimer){clearInterval(queueTimer);queueTimer=null;} }
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
    $("match-title").textContent="Готов к партии?";
    $("match-description").textContent="Нажми кнопку — поиск начнётся сразу.";
    button.innerHTML='Найти соперника <span>→</span>';
    button.classList.add("primary"); button.classList.remove("secondary");
  }
}
async function drawAction() {
  if(!game)return;
  try {
    const accepted=game.draw_offer_by && game.draw_offer_by!==me.id;
    const updated=await api("/api/games/"+game.id+"/draw",{method:"POST",body:JSON.stringify({accept:!!accepted})});
    applyGame(updated);toast(accepted?"Ничья принята":"Предложение ничьей отправлено");
  }catch(e){toast(e.message);}
}
async function resignAction() {
  if(!game || !confirm("Точно сдаться?"))return;
  try { const updated=await api("/api/games/"+game.id+"/resign",{method:"POST"});applyGame(updated); }
  catch(e){toast(e.message);}
}
function bindEvents() {
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $("hero-quick").onclick=$("mode-random").onclick=()=>showView("play");
  $("hero-create").onclick=$("mode-friend").onclick=()=>createGame();
  $("mode-open").onclick=()=>showView("games");
  $("refresh-games").onclick=()=>loadGames();
  $("games-refresh").onclick=()=>loadGames("games-list");
  document.querySelectorAll(".time-option").forEach(b=>b.addEventListener("click",()=>{
    document.querySelectorAll(".time-option").forEach(x=>x.classList.remove("active"));b.classList.add("active");
    selectedTime={seconds:Number(b.dataset.time),increment:Number(b.dataset.inc)};
  }));
  $("match-button").addEventListener("click",()=>{ if (queueRequestPending) return; if (queueTimer) cancelQueue(); else startQueue(); });
  $("back-lobby").onclick=()=>{if(socket)socket.close();game=null;showView("home");};
  $("draw-button").onclick=drawAction;
  $("resign-button").onclick=resignAction;
  $("copy-link").onclick=async()=>{if(!game)return;const url=game.invite_url || (location.origin+location.pathname+"?game="+game.id);try{await navigator.clipboard.writeText(url);toast("Ссылка скопирована");}catch{toast(url);}};
}
async function boot() {
  renderMiniBoard();bindEvents();setInterval(tickClocks,250);
  try {
    await authenticate();
    updateUser();
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
  } catch(e) { toast("Не удалось подключиться к серверу: "+e.message); $("home-games").innerHTML='<div class="empty-state">Сервер пока запускается. Обнови страницу через несколько секунд.</div>'; }
}
boot();
