const state = {
  page: "games",
  records: { matches: [], teams: [], cameramen: [], competitions: [] },
  settings: {},
  selectedMatchId: null,
  search: "",
  filter: "all",
  sortAsc: true,
  mobileNav: false,
  clockOffsetMs: 0,
  imageData: "",
  imageField: "",
  toastTimer: null,
};

const app = document.querySelector("#app");
const route = window.location.pathname;
const overlayMatchId = route.startsWith("/overlay/") ? decodeURIComponent(route.slice("/overlay/".length)) : "";
let overlayEventSource;
let clockInterval;
let overlayMatch;

const labels = {
  scheduled: "Não iniciada",
  live: "Em andamento",
  paused: "Pausada",
  halftime: "Intervalo",
  finished: "Encerrada",
};

const titles = {
  games: ["Lista de Jogos", "Configure a partida. Controle cada momento da transmissão."],
  teams: ["Biblioteca de Escudos", "Uma identidade para cada time. Prontos para reutilizar nas partidas."],
  cameramen: ["Cinegrafistas", "Gerencie a equipe de filmagem e os dados de acesso remoto."],
  studio: ["Estúdio do Placar", "Ajuste a identidade visual e confira as cenas antes de transmitir."],
  competitions: ["Artes dos Campeonatos", "Cadastre uma vez. Leve a identidade do campeonato para cada intervalo."],
  console: ["Console de transmissão", "Abra a saída independente de cada partida no OBS Studio."],
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function icon(name) {
  const paths = {
    games: '<path d="M3 4h18M3 10h18M3 16h18M3 22h18"/><path d="M7 4v18"/>',
    teams: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
    camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    studio: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h3m3 0h4M7 16h10"/>',
    art: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    broadcast: '<path d="M2 8a15 15 0 0 1 20 0M5 11a10 10 0 0 1 14 0m-11 3a5 5 0 0 1 8 0"/><circle cx="12" cy="18" r="1"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    plus: '<path d="M12 5v14m-7-7h14"/>',
    edit: '<path d="m16 4 4 4L8 20H4v-4Z"/><path d="m14 6 4 4"/>',
    delete: '<path d="M3 6h18m-2 0-1 14H6L5 6m3 0V4h8v2m-7 4v7m4-7v7"/>',
    play: '<path d="m8 5 12 7-12 7z"/>',
    pause: '<path d="M8 5v14m8-14v14"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    minus: '<path d="M5 12h14"/>',
    plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8m-4-4h8"/>',
    external: '<path d="M14 3h7v7m-1-6-9 9"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
    logout: '<path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M20 16v4H4v-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.help}</svg>`;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method) && path !== "/api/login") {
    headers["X-FAF-Action"] = "1";
  }
  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error || `Erro do servidor (${response.status}).`);
  return result;
}

function notifyUser(message, type = "success") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 3400);
}

function byId(collection, id) {
  return state.records[collection].find((item) => item.id === id);
}

function team(id) {
  return byId("teams", id) || { name: "Time não cadastrado", code: "—", crest: "" };
}

function competition(id) {
  return byId("competitions", id) || null;
}

function selectedMatch() {
  return byId("matches", state.selectedMatchId);
}

function timerSeconds(match, at = Date.now()) {
  const base = Number(match.elapsedSeconds || 0);
  if (match.state === "live" && match.clockStartedAt) {
    return base + Math.max(0, Math.floor((at + state.clockOffsetMs - Number(match.clockStartedAt)) / 1000));
  }
  return base;
}

function formatClock(total) {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function statusPill(status) {
  return `<span class="status status-${escapeHtml(status)}"><i></i>${escapeHtml(labels[status] || status)}</span>`;
}

function crestMarkup(item, size = "") {
  const code = escapeHtml(item?.code || "—");
  if (item?.crest) return `<span class="crest ${size}"><img src="${item.crest}" alt="Escudo ${escapeHtml(item.name)}"></span>`;
  return `<span class="crest ${size} crest-placeholder" aria-label="Escudo provisório de ${escapeHtml(item?.name || "time")}">${code.slice(0, 3)}</span>`;
}

function artworkMarkup(item, className = "") {
  if (item?.artwork) {
    return `<div class="artwork ${className}" style="--art-image:url('${item.artwork}')">
      <div class="artwork-shape artwork-shape-left"></div><div class="artwork-shape artwork-shape-right"></div>
      <div class="artwork-content"><span class="art-cup" aria-hidden="true"><svg viewBox="0 0 72 84" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"><path d="M16 7h40l-6 30-14 10-14-10L16 7Z"/><path d="M23 16h26l-4 16-9 7-9-7-4-16Z"/><path d="M16 13H7v7c0 11 6 17 16 18M56 13h9v7c0 11-6 17-16 18M36 47v18M20 76h32"/></svg></span><strong>${escapeHtml(item.name)}</strong><span class="art-subtitle">FAF · TRANSMISSÃO</span><b>Intervalo</b><small>Voltamos em instantes</small></div>
    </div>`;
  }
  return `<div class="artwork artwork-neutral ${className}">
    <div class="artwork-content"><span class="art-cup" aria-hidden="true"><svg viewBox="0 0 72 84" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"><path d="M16 7h40l-6 30-14 10-14-10L16 7Z"/><path d="M23 16h26l-4 16-9 7-9-7-4-16Z"/><path d="M16 13H7v7c0 11 6 17 16 18M56 13h9v7c0 11-6 17-16 18M36 47v18M20 76h32"/></svg></span><strong>${escapeHtml(item?.name || "Campeonato")}</strong><span class="art-subtitle">ARTE NÃO CADASTRADA</span><b>Intervalo</b><small>Voltamos em instantes</small></div>
  </div>`;
}

function loginScreen(message = "") {
  app.innerHTML = `<main class="login-screen">
    <form id="login-form" class="login-card">
      <div class="brand-mark">FAF</div><p class="eyebrow">CONTROLE DE PLACAR</p>
      <h1>Acesso administrativo</h1><p class="muted">Informe o PIN apresentado ao iniciar o servidor.</p>
      ${message ? `<div class="form-error" role="alert">${escapeHtml(message)}</div>` : ""}
      <label class="field">PIN de acesso<input name="pin" type="password" required autocomplete="current-password" inputmode="text" autofocus></label>
      <button class="button button-primary full-width" type="submit">Entrar ${icon("arrow")}</button>
      <p class="small muted">As saídas do placar são públicas na rede local. O painel administrativo exige PIN.</p>
    </form>
  </main>`;
  app.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const pin = new FormData(event.currentTarget).get("pin");
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    button.textContent = "Verificando…";
    try {
      await api("/api/login", { method: "POST", body: { pin } });
      await loadData();
      renderShell();
      connectAdminEvents();
    } catch (error) {
      loginScreen(error.message);
    }
  });
}

async function loadData() {
  const names = ["matches", "teams", "cameramen", "competitions", "settings"];
  const [entries, time] = await Promise.all([
    Promise.all(names.map(async (name) => [name, await api(`/api/${name}`)])),
    api("/api/time"),
  ]);
  state.clockOffsetMs = Number(time.serverTime) - Date.now();
  for (const [name, values] of entries) {
    if (name === "settings") state.settings = values[0] || {};
    else state.records[name] = values;
  }
  if (!state.selectedMatchId || !byId("matches", state.selectedMatchId)) {
    state.selectedMatchId = state.records.matches[0]?.id || null;
  }
}

let adminEvents;
function connectAdminEvents() {
  adminEvents?.close();
  adminEvents = new EventSource("/api/events?matchId=*");
  adminEvents.addEventListener("update", async () => {
    try {
      await loadData();
      renderShell();
    } catch (error) {
      notifyUser(error.message, "error");
    }
  });
}

function renderShell() {
  clearInterval(clockInterval);
  const [heading, description] = titles[state.page] || titles.games;
  const navItems = [
    ["games", "Jogos", "games"],
    ["teams", "Escudos / Times", "teams"],
    ["cameramen", "Cinegrafistas", "camera"],
    ["studio", "Estúdio do Placar", "studio"],
    ["competitions", "Artes dos Campeonatos", "art"],
    ["console", "Console de transmissão", "broadcast"],
  ];
  app.innerHTML = `<div class="app-shell ${state.mobileNav ? "nav-open" : ""}">
    <button class="mobile-scrim" data-action="close-nav" aria-label="Fechar navegação"></button>
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">FAF</div><span>CONTROLE DE PLACAR</span></div>
      <nav class="main-nav" aria-label="Navegação principal">
        ${navItems.map(([page, label, symbol]) => `<button class="nav-link ${state.page === page ? "active" : ""}" data-page="${page}">${icon(symbol)}<span>${label}</span></button>`).join("")}
      </nav>
      <div class="sidebar-section"><span class="eyebrow">AMBIENTE</span><p>Console de transmissão</p><span class="mode-badge"><i></i> MODO LOCAL</span></div>
      <div class="sidebar-bottom"><button class="nav-link" data-action="help">${icon("help")}<span>Ajuda e atalhos</span></button><button class="logout-button" data-action="logout">${icon("logout")} Sair do painel</button><span>FAF / OPERAÇÃO</span></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><button class="icon-button mobile-menu" data-action="toggle-nav" aria-label="Abrir menu">${icon("menu")}</button><div class="breadcrumb">TRANSMISSÃO / ${heading.toUpperCase()}</div><div class="topbar-right"><span class="top-chip"><i></i> PRÉVIA LOCAL</span><span>Administrador</span><button class="icon-button top-logout" data-action="logout" aria-label="Sair">${icon("logout")}</button></div></header>
      <div class="page-content">
        <div class="page-heading"><div><p class="eyebrow">FAF / TRANSMISSÃO</p><h1>${heading}</h1><p class="muted">${description}</p></div>${pageAction()}</div>
        <section id="page-view">${renderPage()}</section>
      </div>
      <footer class="app-footer"><span>CONCEITO VISUAL · DADOS LOCAIS</span><span>FAF / CONTROLE DE PLACAR</span></footer>
    </main>
  </div>
  <dialog class="help-dialog" id="help-dialog">
    <div class="dialog-heading"><div><p class="eyebrow">FAF / OPERAÇÃO</p><h2>Ajuda e atalhos</h2></div><button class="icon-button" data-action="close-help" aria-label="Fechar">${icon("close")}</button></div>
    <p>Controle o placar e o cronômetro no painel. Cada partida mantém estado e saída independentes.</p>
    <h3>Saída para OBS</h3><p>Em <b>Console de transmissão</b>, copie o link da partida e adicione-o como fonte de navegador. Use a resolução 1920 × 1080. O navegador do OBS deve estar na mesma máquina ou rede local.</p>
    <h3>Atalhos</h3><p>Todos os controles também são acessíveis por teclado. Use Tab para navegar e Enter/Espaço para ativar.</p>
    <p class="small muted">Não use esta aplicação em rede pública. Chaves de transmissão são guardadas no Keychain do macOS.</p>
  </dialog>`;
  renderTimer();
  clockInterval = setInterval(renderTimer, 1000);
  bindShellEvents();
  bindPageEvents();
}

function pageAction() {
  const actions = {
    games: `<button class="button button-primary" data-action="new-match">${icon("plus")} Nova partida</button>`,
    teams: `<button class="button button-primary" data-action="new-team">${icon("plus")} Cadastrar time</button>`,
    cameramen: `<button class="button button-primary" data-action="new-camera">${icon("plus")} Novo cinegrafista</button>`,
    studio: `<button class="button button-primary" data-action="save-studio">${icon("check")} Salvar aparência</button>`,
    competitions: `<button class="button button-primary" data-action="new-competition">${icon("plus")} Cadastrar campeonato</button>`,
    console: "",
  };
  return actions[state.page] || "";
}

function renderPage() {
  const pages = {
    games: renderGames,
    teams: renderTeams,
    cameramen: renderCameramen,
    studio: renderStudio,
    competitions: renderCompetitions,
    console: renderConsole,
  };
  return (pages[state.page] || renderGames)();
}

function filteredMatches() {
  const query = state.search.trim().toLowerCase();
  return state.records.matches.filter((match) => {
    const home = team(match.homeTeamId);
    const away = team(match.awayTeamId);
    const comp = competition(match.competitionId);
    const matchesQuery = !query || [match.title, home.name, home.code, away.name, away.code, comp?.name]
      .some((value) => String(value || "").toLowerCase().includes(query));
    const matchesStatus = state.filter === "all" || match.state === state.filter;
    return matchesQuery && matchesStatus;
  });
}

function renderGames() {
  const matches = filteredMatches();
  const counts = [
    ["TOTAL DE PARTIDAS", state.records.matches.length, "games"],
    ["EM ANDAMENTO", state.records.matches.filter((item) => item.state === "live").length, "play"],
    ["EM INTERVALO", state.records.matches.filter((item) => item.state === "halftime").length, "pause"],
  ];
  const match = selectedMatch();
  return `<div class="stats-grid">${counts.map(([label, value, symbol]) => `<article class="stat-card"><div><span class="eyebrow">${label}</span><strong>${String(value).padStart(2, "0")}</strong></div>${icon(symbol)}</article>`).join("")}</div>
  <div class="game-toolbar"><label class="searchbox">${icon("search")}<input id="game-search" type="search" placeholder="Buscar partida…" value="${escapeHtml(state.search)}" aria-label="Buscar partidas"></label>
    <label class="select-compact"><span class="sr-only">Filtrar por estado</span><select id="game-filter">
      ${[["all", "Todas"], ["scheduled", "Não iniciadas"], ["live", "Em andamento"], ["paused", "Pausadas"], ["halftime", "Em intervalo"], ["finished", "Encerradas"]].map(([value, label]) => `<option value="${value}" ${state.filter === value ? "selected" : ""}>${label}</option>`).join("")}
    </select></label></div>
  <div class="games-layout">
    <div class="games-column">
      <div class="section-caption"><span>PARTIDAS CADASTRADAS</span><span>${String(matches.length).padStart(2, "0")} PARTIDAS</span></div>
      ${matches.length ? matches.map(renderMatchCard).join("") : `<div class="empty-state"><span>${icon("games")}</span><b>Nenhuma partida encontrada</b><p>Cadastre uma partida ou ajuste os filtros.</p><button class="button" data-action="new-match">${icon("plus")} Nova partida</button></div>`}
      ${match ? renderMatchConsole(match) : ""}
    </div>
    ${renderMatchForm(match)}
  </div>`;
}

function renderMatchCard(match) {
  const home = team(match.homeTeamId);
  const away = team(match.awayTeamId);
  const comp = competition(match.competitionId);
  return `<article class="match-card ${state.selectedMatchId === match.id ? "selected" : ""}" data-select-match="${match.id}">
    <div class="match-card-top"><div><span class="eyebrow">${escapeHtml(comp?.name || "SEM CAMPEONATO")}</span><h3><button class="match-title" data-action="select-match" data-id="${match.id}">${escapeHtml(match.title)}</button></h3></div>${statusPill(match.state)}</div>
    <div class="match-card-score"><div class="team-inline">${crestMarkup(home, "crest-small")}<strong>${escapeHtml(home.code)}</strong></div><b>${match.homeScore} <span>:</span> ${match.awayScore}</b><div class="team-inline"><strong>${escapeHtml(away.code)}</strong>${crestMarkup(away, "crest-small")}</div></div>
    <div class="match-card-bottom"><span>${icon("clock")} ${escapeHtml(match.period)} · <span data-timer="${match.id}">${formatClock(timerSeconds(match))}</span></span><button class="text-button" data-action="copy-overlay" data-id="${match.id}">${icon("external")} Abrir saída</button></div>
  </article>`;
}

function renderMatchConsole(match) {
  const home = team(match.homeTeamId);
  const away = team(match.awayTeamId);
  const comp = competition(match.competitionId);
  const running = match.state === "live";
  return `<article class="panel match-console">
    <div class="panel-heading"><div><p class="eyebrow">PARTIDA SELECIONADA</p><h2>${escapeHtml(comp?.name || "Sem campeonato")}</h2></div>${statusPill(match.state)}</div>
    <div class="video-preview">
      <div class="preview-label"><span>${icon("broadcast")} PRÉVIA DA TRANSMISSÃO</span><span class="top-chip"><i></i> LOCAL</span></div>
      <div class="preview-scene">
        <div class="preview-football">FAF <span>TRANSMISSÃO · PRÉVIA LOCAL</span></div>
      </div>
      <div class="preview-meta"><span>${escapeHtml(home.code)} × ${escapeHtml(away.code)} · ${escapeHtml(comp?.name || "Sem arte vinculada")}</span><button class="mini-button" data-action="copy-overlay" data-id="${match.id}">${icon("external")} Saída</button></div>
    </div>
    <div class="selected-caption"><span class="eyebrow">PLACAR SELECIONADO</span><span class="mini-chip">${match.state === "halftime" ? "TELA DE INTERVALO" : "SCOREBUG"}</span></div>
    <div class="scoreboard">
      <div class="score-team">${crestMarkup(home, "crest-large")}<strong>${escapeHtml(home.name)}</strong><span>${escapeHtml(home.code)}</span></div>
      <div class="score-center"><div class="score-number">${match.homeScore}<span>:</span>${match.awayScore}</div><div class="period-clock">${escapeHtml(match.period)} / <span data-timer="${match.id}">${formatClock(timerSeconds(match))}</span></div></div>
      <div class="score-team">${crestMarkup(away, "crest-large")}<strong>${escapeHtml(away.name)}</strong><span>${escapeHtml(away.code)}</span></div>
    </div>
    <div class="score-controls">
      <div class="score-control"><button class="icon-button" data-action="goal" data-side="home" data-delta="-1" aria-label="Diminuir gol do ${escapeHtml(home.name)}">${icon("minus")}</button><span>GOLS · ${escapeHtml(home.code)}</span><button class="icon-button" data-action="goal" data-side="home" data-delta="1" aria-label="Adicionar gol ao ${escapeHtml(home.name)}">${icon("plusCircle")}</button></div>
      <div class="score-control"><button class="icon-button" data-action="goal" data-side="away" data-delta="-1" aria-label="Diminuir gol do ${escapeHtml(away.name)}">${icon("minus")}</button><span>GOLS · ${escapeHtml(away.code)}</span><button class="icon-button" data-action="goal" data-side="away" data-delta="1" aria-label="Adicionar gol ao ${escapeHtml(away.name)}">${icon("plusCircle")}</button></div>
    </div>
    <div class="timer-panel">
      <div class="timer-display"><span class="eyebrow">CRONÔMETRO ${running ? "EM ANDAMENTO" : "PAUSADO"}</span><strong data-timer="${match.id}">${formatClock(timerSeconds(match))}</strong></div>
      <div class="timer-buttons">
        ${match.state === "live" ? `<button class="button" data-action="match-pause" data-id="${match.id}">${icon("pause")} Pausar</button>` : ""}
        ${["scheduled", "paused"].includes(match.state) ? `<button class="button" data-action="match-start" data-id="${match.id}">${icon("play")} ${match.state === "paused" ? "Retomar" : "Iniciar"}</button>` : ""}
        ${match.state === "halftime" ? `<button class="button button-primary" data-action="match-resume" data-id="${match.id}">${icon("play")} Voltar ao jogo</button>` : ""}
        ${match.state !== "finished" ? `<button class="button button-danger-quiet" data-action="match-finish" data-id="${match.id}">${icon("check")} Encerrar</button>` : ""}
        <button class="button button-quiet" data-action="match-reset" data-id="${match.id}">${icon("reset")} Zerar</button>
      </div>
    </div>
    <div class="period-row"><label class="field"><span>PERÍODO</span><select data-match-field="period" data-id="${match.id}" ${match.state === "finished" ? "disabled" : ""}><option value="1T" ${match.period === "1T" ? "selected" : ""} ${match.state === "halftime" ? "disabled" : ""}>1º tempo</option><option value="2T" ${match.period === "2T" ? "selected" : ""}>2º tempo</option><option value="INT" ${match.period === "INT" ? "selected" : ""} ${match.state === "scheduled" ? "disabled" : ""}>Intervalo</option><option value="FT" ${match.period === "FT" ? "selected" : ""} ${match.state === "scheduled" ? "disabled" : ""}>Encerrado</option></select></label><label class="field"><span>ACRÉSCIMOS (MIN)</span><input type="number" min="0" max="30" value="${match.addedMinutes || 0}" data-match-field="addedMinutes" data-id="${match.id}"></label>
      <button class="button ${match.state === "halftime" ? "button-primary" : ""}" data-action="${match.state === "halftime" ? "match-resume" : "match-break"}" data-id="${match.id}">${match.state === "halftime" ? icon("play") + " Voltar ao jogo" : "Entrar em intervalo"}</button></div>
    <div class="console-bottom"><span class="small muted">O cronômetro é calculado pelo horário do servidor e continua independente em cada partida.</span><button class="button button-quiet" data-action="copy-overlay" data-id="${match.id}">${icon("external")} Abrir saída</button></div>
  </article>`;
}

function renderMatchForm(match) {
  const draft = match || {
    id: "",
    homeTeamId: state.records.teams[0]?.id || "",
    awayTeamId: state.records.teams[1]?.id || "",
    competitionId: state.records.competitions[0]?.id || "",
    cameramanId: "",
    title: "",
    transmissionTitle: "",
    addedMinutes: 0,
    state: "scheduled",
  };
  return `<aside class="panel config-panel">
    <div class="panel-heading"><div><p class="eyebrow">${draft.id ? "EDIÇÃO" : "NOVA PARTIDA"}</p><h2>Configuração da partida</h2></div></div>
    ${!state.records.teams.length ? `<div class="form-error">Cadastre pelo menos dois times antes de criar uma partida.</div>` : ""}
    <form id="match-form" data-id="${escapeHtml(draft.id)}">
      <div class="form-grid two">
        <label class="field"><span>MANDANTE</span><select name="homeTeamId" required>${teamOptions(draft.homeTeamId)}</select></label>
        <label class="field"><span>VISITANTE</span><select name="awayTeamId" required>${teamOptions(draft.awayTeamId)}</select></label>
      </div>
      <label class="field"><span>CAMPEONATO / ARTE DO INTERVALO</span><select name="competitionId"><option value="">Sem campeonato associado</option>${state.records.competitions.map((item) => `<option value="${item.id}" ${draft.competitionId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
      ${artworkMarkup(competition(draft.competitionId), "artwork-preview")}
      ${state.records.competitions.length ? `<a class="mini-link" href="#" data-page="competitions">${icon("art")} Escolher na biblioteca</a>` : `<p class="small muted">Nenhuma arte cadastrada. A saída usará uma tela neutra.</p>`}
      <label class="field"><span>CINEGRAFISTA</span><select name="cameramanId"><option value="">Sem cinegrafista</option>${state.records.cameramen.map((item) => `<option value="${item.id}" ${draft.cameramanId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
      <label class="field"><span>TÍTULO DA TRANSMISSÃO</span><input name="transmissionTitle" value="${escapeHtml(draft.transmissionTitle || "")}" placeholder="Ex.: CSE x CSA"></label>
      <label class="field"><span>IDENTIFICAÇÃO DA PARTIDA</span><input name="title" value="${escapeHtml(draft.title || "")}" placeholder="Gerado pelos times se deixado vazio"></label>
      ${draft.id ? `<div class="form-footer"><button class="button button-quiet" type="button" data-action="cancel-edit">Cancelar</button><button class="button button-primary" type="submit">${icon("check")} Salvar alterações</button></div>
      <button class="button button-danger-quiet full-width" type="button" data-action="delete-match" data-id="${draft.id}">${icon("delete")} Excluir partida</button>` : `<button class="button button-primary full-width" type="submit">${icon("check")} Cadastrar partida</button>`}
    </form>
  </aside>`;
}

function teamOptions(selected) {
  return `<option value="">Selecione</option>${state.records.teams.map((item) => `<option value="${item.id}" ${selected === item.id ? "selected" : ""}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join("")}`;
}

function renderTeams() {
  const query = state.search.toLowerCase();
  const teams = state.records.teams.filter((item) => `${item.name} ${item.code}`.toLowerCase().includes(query))
    .sort((a, b) => state.sortAsc ? a.name.localeCompare(b.name, "pt-BR") : b.name.localeCompare(a.name, "pt-BR"));
  const editing = state.editingTeamId ? byId("teams", state.editingTeamId) : null;
  const draft = editing || { name: "", code: "", crest: "" };
  return `<div class="library-toolbar"><label class="searchbox">${icon("search")}<input id="library-search" type="search" placeholder="Buscar times…" value="${escapeHtml(state.search)}" aria-label="Buscar equipes"></label><button class="button button-quiet" data-action="sort">${state.sortAsc ? "A–Z ↑" : "Z–A ↓"}</button><span class="small muted">${teams.length} TIMES CADASTRADOS</span></div>
  <div class="library-layout"><div>
    <div class="section-caption"><span>ESCUDOS CONECTADOS EM TEMPO REAL</span><span>${String(teams.length).padStart(2, "0")} REGISTROS</span></div>
    ${teams.length ? `<div class="team-grid">${teams.map((item) => `<article class="team-card"><div class="team-card-crest">${crestMarkup(item)}</div><div class="team-card-content"><div><h3>${escapeHtml(item.name)}</h3><span class="eyebrow">${escapeHtml(item.code)}</span></div><div class="card-actions"><button class="text-button" data-action="edit-team" data-id="${item.id}">${icon("edit")} Editar</button><button class="icon-button compact danger" data-action="delete-team" data-id="${item.id}" aria-label="Excluir ${escapeHtml(item.name)}">${icon("delete")}</button></div></div></article>`).join("")}</div>` : `<div class="empty-state">Nenhum time cadastrado.</div>`}
  </div>
  <aside class="panel form-panel"><div class="panel-heading"><div><p class="eyebrow">${editing ? "TIME SELECIONADO" : "CADASTRO INTEGRADO"}</p><h2>${editing ? "Editar time" : "Cadastrar time"}</h2></div></div>
    <form id="team-form" data-id="${editing?.id || ""}">
      ${editing ? `<span class="mini-chip">${escapeHtml(draft.code)} SELECIONADO</span>` : ""}
      <label class="field"><span>NOME DO TIME</span><input name="name" required value="${escapeHtml(draft.name)}" placeholder="Nome completo do time"></label>
      <label class="field"><span>SIGLA NO PLACAR</span><input name="code" required maxlength="5" minlength="2" value="${escapeHtml(draft.code)}" placeholder="ABC"></label>
      <label class="field"><span>ESCUDO</span><span class="upload-box">${icon("upload")}<strong>Enviar / substituir escudo</strong><small>PNG, JPG ou WebP · até 3 MB</small><input type="file" name="crest" accept="image/png,image/jpeg,image/webp"></span></label>
      ${state.imageField === "team" && state.imageData ? `<img class="image-preview crest-upload-preview" src="${state.imageData}" alt="Prévia do escudo selecionado">` : (draft.crest ? `<img class="image-preview crest-upload-preview" src="${draft.crest}" alt="Escudo atual">` : `<div class="logo-preview">${crestMarkup(draft, "crest-large")}<span>${escapeHtml(draft.code || "SIGLA")}</span></div>`)}
      <div class="form-footer"><button class="button button-quiet" type="button" data-action="cancel-team">${editing ? "Cancelar" : "Limpar"}</button><button class="button button-primary" type="submit">${icon("check")} Salvar time</button></div>
      ${editing ? `<button class="button button-danger-quiet full-width" type="button" data-action="delete-team" data-id="${editing.id}">${icon("delete")} Excluir time</button>` : ""}
    </form></aside></div>`;
}

function renderCameramen() {
  const query = state.search.toLowerCase();
  const cameras = state.records.cameramen.filter((item) => `${item.name} ${item.phone || ""}`.toLowerCase().includes(query));
  const editing = state.editingCameraId ? byId("cameramen", state.editingCameraId) : null;
  const draft = editing || { name: "", phone: "", notes: "", hasStreamKey: false };
  return `<div class="library-toolbar"><label class="searchbox">${icon("search")}<input id="library-search" type="search" placeholder="Buscar cinegrafista…" value="${escapeHtml(state.search)}" aria-label="Buscar cinegrafista"></label><span class="small muted">${String(cameras.length).padStart(2, "0")} CINEGRAFISTAS</span><span class="mini-chip">${icon("eye")} CHAVES PROTEGIDAS</span></div>
  <div class="library-layout"><div>
    <div class="section-caption"><span>EQUIPE DE FILMAGEM</span><span>${String(cameras.length).padStart(2, "0")} REGISTROS</span></div>
    ${cameras.length ? `<div class="camera-grid">${cameras.map((item) => `<article class="camera-card"><div class="camera-card-head"><span class="camera-icon">${icon("camera")}</span><span class="mini-chip">${item.hasStreamKey ? "CHAVE GUARDADA" : "SEM CHAVE"}</span></div><h3>${escapeHtml(item.name)}</h3><p class="small muted">${item.phone ? `Telefone · ${escapeHtml(item.phone)}` : "Telefone não informado"}</p><p class="small muted">${escapeHtml(item.notes || "Sem observações")}</p><div class="key-display"><span>CHAVE DE TRANSMISSÃO</span><code>${item.hasStreamKey ? "••••••••••••••••" : "Não cadastrada"}</code>${item.hasStreamKey ? icon("eye") : ""}</div><div class="card-actions"><button class="text-button" data-action="edit-camera" data-id="${item.id}">${icon("edit")} Editar</button><button class="icon-button compact danger" data-action="delete-camera" data-id="${item.id}" aria-label="Excluir ${escapeHtml(item.name)}">${icon("delete")}</button></div></article>`).join("")}</div>` : `<div class="empty-state">Nenhum cinegrafista cadastrado.</div>`}
  </div>
  <aside class="panel form-panel"><div class="panel-heading"><div><p class="eyebrow">CADASTRO / EDIÇÃO</p><h2>Dados do cinegrafista</h2></div></div>
    <form id="camera-form" data-id="${editing?.id || ""}">
      ${editing ? `<span class="mini-chip">${escapeHtml(draft.name.toUpperCase())} SELECIONADO</span>` : ""}
      <label class="field"><span>NOME</span><input name="name" required value="${escapeHtml(draft.name)}"></label>
      <label class="field"><span>TELEFONE</span><input name="phone" type="tel" autocomplete="tel" value="${escapeHtml(draft.phone || "")}" placeholder="(00) 00000-0000"></label>
      <label class="field"><span>OBSERVAÇÕES</span><textarea name="notes" rows="2" placeholder="Anotações internas">${escapeHtml(draft.notes || "")}</textarea></label>
      <div class="field-note"><b>ACESSO REMOTO</b><p>Cada cinegrafista pode ter uma chave de transmissão. O valor é guardado no Keychain do macOS e não aparece em listas nem na saída do placar.</p></div>
      <label class="field"><span>CHAVE DE TRANSMISSÃO DO YOUTUBE</span><span class="password-input"><input id="camera-secret" name="streamKey" type="password" autocomplete="new-password" placeholder="${draft.hasStreamKey ? "Chave já guardada · deixe vazio para manter" : "Deixe vazio se não for usar"}"><button type="button" class="icon-button" data-action="toggle-secret" aria-label="Mostrar chave">${icon("eye")}</button></span></label>
      ${editing?.hasStreamKey ? `<button type="button" class="text-button danger-text" data-action="remove-camera-secret" data-id="${editing.id}">${icon("delete")} Remover chave guardada</button>` : ""}
      <p class="small muted">A chave não inicia transmissão e não é usada na integração nesta versão. Só será consultada após solicitação explícita no formulário.</p>
      <div class="form-footer"><button class="button button-quiet" type="button" data-action="cancel-camera">Cancelar</button><button class="button button-primary" type="submit">${icon("check")} Salvar cinegrafista</button></div>
      ${editing ? `<button class="button button-danger-quiet full-width" type="button" data-action="delete-camera" data-id="${editing.id}">${icon("delete")} Excluir cadastro</button>` : ""}
    </form></aside></div>`;
}

function renderCompetitions() {
  const query = state.search.toLowerCase();
  const items = state.records.competitions.filter((item) => item.name.toLowerCase().includes(query));
  const editing = state.editingCompetitionId ? byId("competitions", state.editingCompetitionId) : null;
  const draft = editing || { name: "", artwork: "" };
  return `<div class="library-toolbar"><label class="searchbox">${icon("search")}<input id="library-search" type="search" placeholder="Buscar campeonatos ou artes…" value="${escapeHtml(state.search)}" aria-label="Buscar campeonatos"></label><button class="button button-quiet" data-action="sort">${state.sortAsc ? "A–Z ↑" : "Z–A ↓"}</button><span class="small muted">${items.length} CAMPEONATO(S) / ARTE(S)</span></div>
  <div class="library-layout competition-layout"><div>
    <div class="section-caption"><span>CAMPEONATO / ARTE</span><span>SELEÇÃO ATIVA</span></div>
    ${items.length ? items.map((item) => `<article class="competition-card ${state.editingCompetitionId === item.id ? "selected" : ""}">${artworkMarkup(item, "competition-art")}<div class="competition-card-info"><div><h3>${escapeHtml(item.name)}</h3><p class="small muted">${item.artwork ? "Arte cadastrada · disponível nas partidas" : "Arte não cadastrada · tela neutra no intervalo"}</p></div><div class="card-actions"><button class="text-button" data-action="edit-competition" data-id="${item.id}">${icon("edit")} Editar</button><button class="icon-button compact danger" data-action="delete-competition" data-id="${item.id}" aria-label="Excluir ${escapeHtml(item.name)}">${icon("delete")}</button></div></div></article>`).join("") : `<div class="empty-state">Nenhum campeonato cadastrado.</div>`}
    <article class="panel linked-art"><p class="eyebrow">ARTE VINCULADA</p><h3>Reutilização na transmissão</h3><p class="muted">${state.records.matches.length} partida(s) cadastrada(s)</p><p class="small muted">A arte escolhida permanece associada à partida. Excluir um campeonato utilizado é bloqueado para evitar perder configurações.</p><button class="button button-quiet" data-page="games">${icon("arrow")} Ir para configuração da partida</button></article>
  </div>
  <aside class="panel form-panel"><div class="panel-heading"><div><p class="eyebrow">FORMULÁRIO INTEGRADO</p><h2>${editing ? "Editar campeonato" : "Cadastrar / editar campeonato"}</h2></div></div>
    <form id="competition-form" data-id="${editing?.id || ""}">
      <label class="field"><span>NOME DO CAMPEONATO</span><input name="name" required value="${escapeHtml(draft.name)}" placeholder="Ex.: Copa Alagoas Sub-20 2026"></label>
      <label class="field"><span>LOGO / ARTE</span><span class="upload-box">${icon("upload")}<strong>Enviar logo / arte</strong><small>PNG, JPG ou WebP · até 3 MB</small><input type="file" name="artwork" accept="image/png,image/jpeg,image/webp"></span></label>
      ${state.imageField === "competition" && state.imageData ? `<img class="image-preview artwork-form-preview" src="${state.imageData}" alt="Prévia da arte selecionada">` : (draft.artwork ? `<img class="image-preview artwork-form-preview" src="${draft.artwork}" alt="Arte atual do campeonato">` : artworkMarkup(draft, "artwork-form-preview"))}
      <label class="field"><span>USO DA ARTE</span><select disabled><option>Tela de descanso / intervalo</option></select></label>
      <p class="small muted">A arte será exibida como fundo no intervalo. Prefira uma composição sem placar estático; o placar atualizado é sobreposto. Use materiais autorizados.</p>
      <div class="form-footer"><button class="button button-quiet" type="button" data-action="cancel-competition">Cancelar</button><button class="button button-primary" type="submit">${icon("check")} Salvar campeonato</button></div>
      ${editing ? `<button class="button button-danger-quiet full-width" type="button" data-action="delete-competition" data-id="${editing.id}">${icon("delete")} Excluir campeonato</button>` : ""}
    </form></aside></div>`;
}

function renderStudio() {
  const settings = {
    scoreBackground: state.settings.scoreBackground || "#f3f3f3",
    scoreText: state.settings.scoreText || "#111111",
    teamBackground: state.settings.teamBackground || "#101010",
    teamText: state.settings.teamText || "#f3f3f3",
    fontFamily: state.settings.fontFamily || "Inter",
  };
  const match = selectedMatch();
  const item = competition(match?.competitionId);
  const home = team(match?.homeTeamId);
  const away = team(match?.awayTeamId);
  return `<div class="studio-layout">
    <aside class="panel form-panel studio-settings">
      <div class="panel-heading"><div><p class="eyebrow">IDENTIDADE DA TRANSMISSÃO</p><h2>Cores e fontes globais</h2></div></div>
      <p class="small muted">Uma paleta exclusivamente neutra para todas as partidas e cenas.</p>
      <div class="color-grid">
        ${colorField("Fundo do placar", "scoreBackground", settings.scoreBackground)}
        ${colorField("Fonte do placar", "scoreText", settings.scoreText)}
        ${colorField("Fundo dos times", "teamBackground", settings.teamBackground)}
        ${colorField("Fonte dos times", "teamText", settings.teamText)}
      </div>
      <label class="field"><span>FAMÍLIA TIPOGRÁFICA</span><select name="fontFamily" form="studio-form"><option ${settings.fontFamily === "Inter" ? "selected" : ""}>Inter</option><option ${settings.fontFamily === "Arial" ? "selected" : ""}>Arial</option><option ${settings.fontFamily === "Roboto Mono" ? "selected" : ""}>Roboto Mono</option></select></label>
      <div class="field-note"><b>SAÍDA TRANSPARENTE</b><p>As cores de fundo da página da saída são transparentes. As cores configuradas se aplicam apenas ao placar.</p></div>
      <form id="studio-form"><button class="button button-quiet full-width" type="reset">${icon("reset")} Restaurar valores do formulário</button></form>
    </aside>
    <div class="studio-previews"><div class="section-caption"><span>${escapeHtml(home.code)} × ${escapeHtml(away.code)} / DEMONSTRAÇÃO</span><button class="button button-quiet" data-action="copy-overlay" data-id="${match?.id || ""}">${icon("external")} Abrir saída</button></div>
      <article class="panel scene-card"><div class="scene-header"><span>CENA 01 / PLACAR</span><span class="mini-chip">PRÉVIA</span></div><div class="scorebug-preview" style="--score-bg:${escapeHtml(settings.scoreBackground)};--score-fg:${escapeHtml(settings.scoreText)};--team-bg:${escapeHtml(settings.teamBackground)};--team-fg:${escapeHtml(settings.teamText)};--score-font:${escapeHtml(settings.fontFamily)}"><span class="scorebug-team">${crestMarkup(home, "crest-small")}${escapeHtml(home.code)}</span><strong>${match?.homeScore ?? 0}<i>:</i>${match?.awayScore ?? 0}</strong><span class="scorebug-team">${escapeHtml(away.code)}${crestMarkup(away, "crest-small")}</span><small>${escapeHtml(match?.period || "1T")} · ${match ? formatClock(timerSeconds(match)) : "00:00"}</small></div><p class="small muted">Sobreposição do placar · fundo da prévia não transmitido</p></article>
      <article class="panel scene-card break-scene"><div class="scene-header"><span>CENA 02 / DESCANSO</span>${match?.state === "halftime" ? `<span class="mini-chip">EM EXIBIÇÃO</span>` : ""}</div>${artworkMarkup(item, "studio-art-preview")}<div class="scene-header"><span>CENA ATUAL</span><b>${escapeHtml(match?.state === "halftime" ? "Intervalo" : "Placar")} · ${match?.state === "live" ? "cronômetro em andamento" : "cronômetro pausado"}</b></div></article>
    </div>
  </div>`;
}

function colorField(label, name, value) {
  return `<label class="field color-field"><span>${label.toUpperCase()}</span><span><input type="color" name="${name}" form="studio-form" value="${escapeHtml(value)}"><input type="text" value="${escapeHtml(value)}" data-color-text="${name}" aria-label="${label} hexadecimal"></span></label>`;
}

function renderConsole() {
  return `<div class="panel console-page"><div class="panel-heading"><div><p class="eyebrow">SAÍDAS INDEPENDENTES</p><h2>Placar por partida</h2></div><span class="mini-chip">${state.records.matches.length} SAÍDA(S)</span></div>
    <p class="muted">Cada URL identifica uma partida. As alterações são enviadas em tempo real; entrar em intervalo em um jogo não altera as demais saídas.</p>
    <div class="output-list">${state.records.matches.map((match) => {
      const home = team(match.homeTeamId);
      const away = team(match.awayTeamId);
      const comp = competition(match.competitionId);
      const url = `${window.location.origin}/overlay/${encodeURIComponent(match.id)}`;
      return `<article class="output-card"><div class="output-match">${crestMarkup(home, "crest-small")}<div><strong>${escapeHtml(home.code)} ${match.homeScore} : ${match.awayScore} ${escapeHtml(away.code)}</strong><span>${escapeHtml(comp?.name || match.title)} · ${escapeHtml(match.period)} · ${statusPill(match.state)}</span></div>${crestMarkup(away, "crest-small")}</div><label class="field"><span>URL DA SAÍDA</span><input readonly value="${escapeHtml(url)}"></label><div class="card-actions"><button class="button button-primary" data-action="open-overlay" data-id="${match.id}">${icon("external")} Abrir saída</button><button class="button button-quiet" data-action="copy-overlay" data-id="${match.id}">${icon("copy")} Copiar link</button><button class="button button-quiet" data-action="select-match" data-id="${match.id}">${icon("edit")} Controlar partida</button></div></article>`;
    }).join("") || `<div class="empty-state">Cadastre partidas para gerar saídas independentes.</div>`}</div>
    <div class="field-note"><b>CONFIGURAÇÃO DO OBS STUDIO</b><p>Adicione uma fonte “Navegador”, cole a URL exclusiva da partida e defina 1920 × 1080. A composição tem fundo transparente no placar normal; no intervalo, a arte ocupa toda a tela. O OBS e o servidor precisam estar na mesma máquina/rede local.</p></div>
  </div>`;
}

function renderTimer() {
  document.querySelectorAll("[data-timer]").forEach((element) => {
    const match = byId("matches", element.dataset.timer);
    if (match) element.textContent = formatClock(timerSeconds(match));
  });
}

function bindShellEvents() {
  app.querySelectorAll("[data-page]").forEach((element) => element.addEventListener("click", (event) => {
    event.preventDefault();
    state.page = element.dataset.page;
    state.search = "";
    state.mobileNav = false;
    state.imageData = "";
    renderShell();
  }));
  app.querySelectorAll("[data-action='toggle-nav']").forEach((element) => element.addEventListener("click", () => {
    state.mobileNav = !state.mobileNav;
    renderShell();
  }));
  app.querySelectorAll("[data-action='close-nav']").forEach((element) => element.addEventListener("click", () => {
    state.mobileNav = false;
    renderShell();
  }));
  app.querySelectorAll("[data-action='logout']").forEach((element) => element.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: {} });
      adminEvents?.close();
      loginScreen();
    } catch (error) {
      notifyUser(error.message, "error");
    }
  }));
  app.querySelectorAll("[data-action='help']").forEach((element) => element.addEventListener("click", () => document.querySelector("#help-dialog").showModal()));
  app.querySelectorAll("[data-action='close-help']").forEach((element) => element.addEventListener("click", () => document.querySelector("#help-dialog").close()));
  app.querySelectorAll("[data-action='new-match']").forEach((element) => element.addEventListener("click", () => {
    if (state.records.teams.length < 2) {
      notifyUser("Cadastre pelo menos dois times antes de criar uma partida.", "error");
      state.page = "teams";
    } else {
      state.selectedMatchId = null;
    }
    renderShell();
  }));
  app.querySelectorAll("[data-action='new-team']").forEach((element) => element.addEventListener("click", () => {
    state.editingTeamId = null; state.imageData = ""; renderShell();
  }));
  app.querySelectorAll("[data-action='new-camera']").forEach((element) => element.addEventListener("click", () => {
    state.editingCameraId = null; renderShell();
  }));
  app.querySelectorAll("[data-action='new-competition']").forEach((element) => element.addEventListener("click", () => {
    state.editingCompetitionId = null; state.imageData = ""; renderShell();
  }));
}

function bindPageEvents() {
  app.querySelectorAll("#game-search, #library-search").forEach((element) => element.addEventListener("input", (event) => {
    state.search = event.currentTarget.value;
    const position = event.currentTarget.selectionStart;
    renderShell();
    const replacement = app.querySelector(`#${event.currentTarget.id}`);
    if (replacement) {
      replacement.focus();
      replacement.setSelectionRange(position, position);
    }
  }));
  app.querySelector("#game-filter")?.addEventListener("change", (event) => {
    state.filter = event.currentTarget.value;
    renderShell();
  });
  app.querySelectorAll("[data-action='sort']").forEach((element) => element.addEventListener("click", () => {
    state.sortAsc = !state.sortAsc; renderShell();
  }));
  app.querySelectorAll("[data-select-match]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      state.selectedMatchId = element.dataset.selectMatch;
      renderShell();
    });
  });
  app.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", handleAction));
  app.querySelectorAll("[data-match-field]").forEach((element) => element.addEventListener("change", saveMatchField));
  app.querySelectorAll("form#match-form, form#team-form, form#camera-form, form#competition-form").forEach((form) => form.addEventListener("submit", saveForm));
  app.querySelectorAll("input[type='file']").forEach((input) => input.addEventListener("change", chooseImage));
  app.querySelectorAll("[data-color-text]").forEach((input) => input.addEventListener("input", () => {
    const color = app.querySelector(`input[name="${input.dataset.colorText}"]`);
    if (/^#[0-9a-f]{6}$/i.test(input.value)) color.value = input.value;
    updateStudioPreview();
  }));
  app.querySelectorAll("input[type='color']").forEach((input) => input.addEventListener("input", () => {
    const text = app.querySelector(`[data-color-text="${input.name}"]`);
    if (text) text.value = input.value;
    updateStudioPreview();
  }));
  app.querySelector("select[name='fontFamily']")?.addEventListener("change", updateStudioPreview);
  app.querySelector("#studio-form")?.addEventListener("reset", () => setTimeout(updateStudioPreview));
}

async function handleAction(event) {
  const button = event.currentTarget;
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    if (action === "edit-team") { state.editingTeamId = id; state.imageData = ""; renderShell(); }
    else if (action === "edit-camera") { state.editingCameraId = id; renderShell(); }
    else if (action === "edit-competition") { state.editingCompetitionId = id; state.imageData = ""; renderShell(); }
    else if (action === "cancel-edit") { state.selectedMatchId = state.records.matches[0]?.id || null; renderShell(); }
    else if (action === "cancel-team") { state.editingTeamId = null; state.imageData = ""; renderShell(); }
    else if (action === "cancel-camera") { state.editingCameraId = null; renderShell(); }
    else if (action === "cancel-competition") { state.editingCompetitionId = null; state.imageData = ""; renderShell(); }
    else if (action === "goal") await matchAction(state.selectedMatchId, { action: "goal", side: button.dataset.side, delta: Number(button.dataset.delta) });
    else if (action === "match-start") await matchAction(id, { action: "start" });
    else if (action === "match-pause") await matchAction(id, { action: "pause" });
    else if (action === "match-break") await matchAction(id, { action: "break" });
    else if (action === "match-resume") await matchAction(id, { action: "resume" });
    else if (action === "match-finish") {
      if (window.confirm("Encerrar esta partida? A saída exibirá o placar final.")) await matchAction(id, { action: "finish" });
    } else if (action === "match-reset") {
      if (window.confirm("Zerar o cronômetro e retornar ao início do 1º tempo? O placar será preservado.")) await matchAction(id, { action: "reset" });
    } else if (action === "delete-match") {
      if (window.confirm("Excluir esta partida? Essa ação não pode ser desfeita.")) {
        await api(`/api/matches/${id}`, { method: "DELETE" });
        state.selectedMatchId = state.records.matches.find((item) => item.id !== id)?.id || null;
        await refreshAndRender("Partida excluída.");
      }
    } else if (action === "delete-team") await deleteRecord("teams", id, "Excluir este time?");
    else if (action === "delete-camera") await deleteRecord("cameramen", id, "Excluir este cinegrafista?");
    else if (action === "delete-competition") await deleteRecord("competitions", id, "Excluir este campeonato?");
    else if (action === "copy-overlay") await copyOverlay(id);
    else if (action === "open-overlay") window.open(`/overlay/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
    else if (action === "select-match") {
      state.page = "games"; state.selectedMatchId = id; renderShell();
    } else if (action === "toggle-secret") await toggleSecret(button);
    else if (action === "remove-camera-secret") {
      if (window.confirm("Remover a chave armazenada no Keychain?")) {
        await api(`/api/cameramen/${id}/secret`, { method: "DELETE" });
        await refreshAndRender("Chave removida.");
      }
    } else if (action === "save-studio") await saveStudio();
  } catch (error) {
    notifyUser(error.message, "error");
  }
}

async function matchAction(id, body) {
  if (!id) throw new Error("Selecione uma partida.");
  await api(`/api/matches/${encodeURIComponent(id)}/actions`, { method: "POST", body });
  await refreshAndRender("Partida atualizada.");
}

async function saveMatchField(event) {
  const field = event.currentTarget;
  const match = byId("matches", field.dataset.id);
  if (!match) return;
  const value = field.dataset.matchField === "addedMinutes" ? Number(field.value) : field.value;
  try {
    if (field.dataset.matchField === "period" && value === "INT") {
      await matchAction(match.id, { action: "break" });
      return;
    }
    if (field.dataset.matchField === "period" && value === "FT") {
      await matchAction(match.id, { action: "finish" });
      return;
    }
    if (field.dataset.matchField === "period" && match.state === "halftime" && value === "2T") {
      await matchAction(match.id, { action: "resume" });
      return;
    }
    await api(`/api/matches/${match.id}`, { method: "PUT", body: { [field.dataset.matchField]: value } });
    await refreshAndRender("Configuração atualizada.");
  } catch (error) {
    notifyUser(error.message, "error");
  }
}

async function saveForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const id = form.dataset.id;
  try {
    if (form.id === "match-form") {
      const existing = id ? byId("matches", id) : {};
      const payload = {
        ...(existing || {}),
        title: data.title,
        homeTeamId: data.homeTeamId,
        awayTeamId: data.awayTeamId,
        competitionId: data.competitionId,
        cameramanId: data.cameramanId,
        transmissionTitle: data.transmissionTitle,
        addedMinutes: existing?.addedMinutes ?? 0,
        homeScore: existing?.homeScore ?? 0,
        awayScore: existing?.awayScore ?? 0,
        state: existing?.state ?? "scheduled",
        period: existing?.period ?? "1T",
        elapsedSeconds: existing?.elapsedSeconds ?? 0,
        clockStartedAt: existing?.clockStartedAt ?? null,
      };
      const saved = id
        ? await api(`/api/matches/${id}`, { method: "PUT", body: payload })
        : await api("/api/matches", { method: "POST", body: payload });
      state.selectedMatchId = saved.id;
      await refreshAndRender(id ? "Partida atualizada." : "Partida cadastrada.");
    } else if (form.id === "team-form") {
      const payload = { name: data.name, code: data.code, crest: state.imageData || byId("teams", id)?.crest || "" };
      await api(id ? `/api/teams/${id}` : "/api/teams", { method: id ? "PUT" : "POST", body: payload });
      state.editingTeamId = null; state.imageData = ""; state.imageField = "";
      await refreshAndRender(id ? "Time atualizado." : "Time cadastrado.");
    } else if (form.id === "camera-form") {
      const payload = { name: data.name, phone: data.phone, notes: data.notes };
      const saved = await api(id ? `/api/cameramen/${id}` : "/api/cameramen", {
        method: id ? "PUT" : "POST",
        body: { ...payload, ...(data.streamKey ? { streamKey: data.streamKey } : {}) },
      });
      state.editingCameraId = saved.id;
      await refreshAndRender(id ? "Cinegrafista atualizado." : "Cinegrafista cadastrado.");
    } else if (form.id === "competition-form") {
      const payload = { name: data.name, artwork: state.imageData || byId("competitions", id)?.artwork || "" };
      await api(id ? `/api/competitions/${id}` : "/api/competitions", { method: id ? "PUT" : "POST", body: payload });
      state.editingCompetitionId = null; state.imageData = ""; state.imageField = "";
      await refreshAndRender(id ? "Campeonato atualizado." : "Campeonato cadastrado.");
    }
  } catch (error) {
    notifyUser(error.message, "error");
  }
}

async function chooseImage(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    notifyUser("Selecione um arquivo PNG, JPG ou WebP.", "error"); event.currentTarget.value = ""; return;
  }
  if (file.size > 3 * 1024 * 1024) {
    notifyUser("A imagem não pode exceder 3 MB.", "error"); event.currentTarget.value = ""; return;
  }
  try {
    const fieldName = event.currentTarget.name;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
      reader.readAsDataURL(file);
    });
    state.imageData = data;
    state.imageField = fieldName === "crest" ? "team" : "competition";
    renderShell();
  } catch (error) {
    notifyUser(error.message, "error");
  }
}

async function deleteRecord(collection, id, prompt) {
  if (!id || !window.confirm(prompt + " Essa ação não pode ser desfeita.")) return;
  await api(`/api/${collection}/${id}`, { method: "DELETE" });
  if (collection === "teams") state.editingTeamId = null;
  if (collection === "cameramen") state.editingCameraId = null;
  if (collection === "competitions") state.editingCompetitionId = null;
  await refreshAndRender("Registro excluído.");
}

async function toggleSecret(button) {
  const input = document.querySelector("#camera-secret");
  if (!input) return;
  if (input.type === "password") {
    const id = document.querySelector("#camera-form").dataset.id;
    if (id && !input.value) {
      const result = await api(`/api/cameramen/${id}/secret`);
      input.value = result.secret;
    }
    input.type = "text";
    button.setAttribute("aria-label", "Ocultar chave");
  } else {
    input.type = "password";
    button.setAttribute("aria-label", "Mostrar chave");
  }
}

async function saveStudio() {
  const form = document.querySelector("#studio-form");
  if (!form) return;
  const payload = {};
  for (const name of ["scoreBackground", "scoreText", "teamBackground", "teamText"]) {
    const input = app.querySelector(`input[name="${name}"]`);
    payload[name] = input?.value || "#101010";
  }
  payload.fontFamily = app.querySelector("select[name='fontFamily']")?.value || "Inter";
  try {
    await api("/api/settings/studio", { method: "PUT", body: payload });
    await refreshAndRender("Aparência salva.");
  } catch (error) {
    notifyUser(error.message, "error");
  }
}

function updateStudioPreview() {
  const preview = app.querySelector(".scorebug-preview");
  if (!preview) return;
  const value = (name, fallback) => app.querySelector(`input[name="${name}"]`)?.value || fallback;
  preview.style.setProperty("--score-bg", value("scoreBackground", "#f3f3f3"));
  preview.style.setProperty("--score-fg", value("scoreText", "#111111"));
  preview.style.setProperty("--team-bg", value("teamBackground", "#101010"));
  preview.style.setProperty("--team-fg", value("teamText", "#f3f3f3"));
  preview.style.setProperty("--score-font", app.querySelector("select[name='fontFamily']")?.value || "Inter");
}

async function copyOverlay(id) {
  if (!id) throw new Error("Cadastre ou selecione uma partida para gerar a saída.");
  const url = `${window.location.origin}/overlay/${encodeURIComponent(id)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = document.createElement("textarea");
    input.value = url;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Não foi possível copiar o link neste navegador.");
  }
  notifyUser("Link da saída copiado.");
}

async function refreshAndRender(message = "") {
  await loadData();
  renderShell();
  if (message) notifyUser(message);
}

async function renderOverlay() {
  app.innerHTML = `<main class="overlay-loading"><span class="spinner"></span><p>Conectando à saída da partida…</p></main>`;
  try {
    await updateOverlay();
    overlayEventSource = new EventSource(`/api/events?matchId=${encodeURIComponent(overlayMatchId)}`);
    overlayEventSource.addEventListener("update", () => {
      updateOverlay().catch((error) => showOverlayError(error));
    });
    setInterval(tickOverlayClock, 1000);
  } catch (error) {
    app.innerHTML = `<main class="overlay-error"><p class="eyebrow">SAÍDA DE TRANSMISSÃO</p><h1>Não foi possível abrir esta partida</h1><p>${escapeHtml(error.message)}</p><a href="/">Voltar ao painel</a></main>`;
  }
}

function showOverlayError(error) {
  app.innerHTML = `<main class="overlay-error"><p class="eyebrow">SAÍDA DE TRANSMISSÃO</p><h1>Conexão temporariamente indisponível</h1><p>${escapeHtml(error.message)}</p></main>`;
}

async function updateOverlay() {
  const match = await api(`/api/public/matches/${encodeURIComponent(overlayMatchId)}`);
  if (!match) throw new Error("Partida não encontrada.");
  state.clockOffsetMs = Number(match.serverNow) - Date.now();
  overlayMatch = match;
  if (match.state === "halftime") {
    const backdrop = match.competition?.artwork
      ? `<img class="broadcast-full-art" src="${match.competition.artwork}" alt="Arte de intervalo: ${escapeHtml(match.competition.name)}">`
      : artworkMarkup(match.competition, "broadcast-art");
    app.innerHTML = `<main class="broadcast-break">${backdrop}<div class="broadcast-score"><span class="broadcast-score-team"><b>${escapeHtml(match.homeTeam?.code || "—")}</b><small>${escapeHtml(match.homeTeam?.name || "Mandante")}</small></span><b>${match.homeScore}</b><i>:</i><b>${match.awayScore}</b><span class="broadcast-score-team"><b>${escapeHtml(match.awayTeam?.code || "—")}</b><small>${escapeHtml(match.awayTeam?.name || "Visitante")}</small></span></div><span class="broadcast-label">${escapeHtml(match.transmissionTitle || "FAF · TRANSMISSÃO")}</span></main>`;
    return;
  }
  const home = match.homeTeam || { code: "—", name: "Mandante" };
  const away = match.awayTeam || { code: "—", name: "Visitante" };
  const studio = match.studio || {};
  const scoreStyle = `--score-bg:${escapeHtml(studio.scoreBackground || "#f3f3f3")};--score-fg:${escapeHtml(studio.scoreText || "#111111")};--team-bg:${escapeHtml(studio.teamBackground || "#101010")};--team-fg:${escapeHtml(studio.teamText || "#f3f3f3")};--score-font:${escapeHtml(studio.fontFamily || "Inter")}`;
  app.innerHTML = `<main class="broadcast-live">
    ${match.transmissionTitle && match.state === "live" ? `<span class="broadcast-title">${escapeHtml(match.transmissionTitle)}</span>` : ""}
    <div class="broadcast-scorebug" style="${scoreStyle}">
      <div class="broadcast-side">${crestMarkup(home, "broadcast-crest")}<span class="broadcast-team-name"><strong>${escapeHtml(home.code)}</strong><small>${escapeHtml(home.name)}</small></span></div>
      <b class="broadcast-goal">${match.homeScore}</b><span class="broadcast-separator">:</span><b class="broadcast-goal">${match.awayScore}</b>
      <div class="broadcast-side"><span class="broadcast-team-name"><strong>${escapeHtml(away.code)}</strong><small>${escapeHtml(away.name)}</small></span>${crestMarkup(away, "broadcast-crest")}</div>
      <div class="broadcast-period"><strong>${escapeHtml(match.period)}</strong><span data-overlay-clock>00:00</span>${match.addedMinutes ? `<small>+${match.addedMinutes}</small>` : ""}</div>
    </div>
    ${match.state === "paused" ? `<span class="broadcast-paused">PAUSADO</span>` : ""}
    ${match.state === "finished" ? `<span class="broadcast-paused">FIM DE JOGO</span>` : ""}
  </main>`;
  tickOverlayClock();
}

function tickOverlayClock() {
  const timer = app.querySelector("[data-overlay-clock]");
  if (timer && overlayMatch) timer.textContent = formatClock(timerSeconds(overlayMatch));
}

(async function initialize() {
  if (overlayMatchId) {
    document.documentElement.classList.add("overlay-mode");
    await renderOverlay();
    return;
  }
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      loginScreen();
      return;
    }
    await loadData();
    renderShell();
    connectAdminEvents();
  } catch (error) {
    app.innerHTML = `<main class="login-screen"><div class="login-card"><h1>Servidor indisponível</h1><p class="muted">${escapeHtml(error.message)}</p><button class="button button-primary" onclick="location.reload()">Tentar novamente</button></div></main>`;
  }
})();
