const API_URL = "";
const TOKEN_KEY = "sms-ponto-token";
const USER_KEY = "sms-ponto-user";

let currentProfilePhotoUrl = null;


function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function renderAvatarElement(element, imageUrl = null) {
  if (!element || !state.user) return;

  if (imageUrl) {
    element.innerHTML = `<img src="${imageUrl}" alt="Foto de perfil de ${escapeHtml(state.user.user)}">`;
    element.classList.add("avatar--photo");
  } else {
    element.textContent = state.user.initials;
    element.classList.remove("avatar--photo");
  }
}

function renderCurrentUserAvatars() {
  renderAvatarElement($("#sidebarAvatar"), currentProfilePhotoUrl);
  renderAvatarElement($("#topAvatar"), currentProfilePhotoUrl);
  renderAvatarElement($("#profileAvatarLarge"), currentProfilePhotoUrl);
}

async function refreshCurrentProfilePhoto() {
  if (!state.user?.id) return;

  try {
    const token = getToken();
    const response = await fetchProtegido(
      `${API_URL}/usuarios/${state.user.id}/foto?t=${Date.now()}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }
    );

    if (response.status === 404) {
      if (currentProfilePhotoUrl) {
        URL.revokeObjectURL(currentProfilePhotoUrl);
        currentProfilePhotoUrl = null;
      }
      renderCurrentUserAvatars();
      return;
    }

    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status}`);
    }

    const blob = await response.blob();

    if (currentProfilePhotoUrl) {
      URL.revokeObjectURL(currentProfilePhotoUrl);
    }

    currentProfilePhotoUrl = URL.createObjectURL(blob);
    renderCurrentUserAvatars();

  } catch (error) {
    console.warn("Não foi possível carregar a foto de perfil:", error);
    renderCurrentUserAvatars();
  }
}

function debounce(fn, wait = 180) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();

  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers
  });

  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  let data = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await response.json();
  }

  if (!response.ok) {
    throw new Error(data?.detail || `Erro HTTP ${response.status}`);
  }

  return data;
}

function initials(name) {
  return String(name || "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase())
    .join("");
}

function roleTemplate(perfil, userData) {
  const base = roles[perfil];
  return {
    ...base,
    user: userData.name,
    initials: initials(userData.name),
    id: userData.id,
    email: userData.email,
    unit_id: userData.unit_id,
    status: userData.status
  };
}

function mapUser(u) {
  const unit = state.units.find(x => x.id === u.unit_id);
  return {
    id: u.id,
    nome: u.name,
    email: u.email,
    perfil: u.perfil === "admin" ? "Administrador" : u.perfil === "rh" ? "RH" : "Coordenador",
    perfilRaw: u.perfil,
    unit_id: u.unit_id,
    unidade: unit?.name || (u.perfil === "coordinator" ? "Sem unidade vinculada" : "Secretaria Municipal de Saúde"),
    status: u.status ? "Ativo" : "Inativo"
  };
}

function mapFechamento(f, unit) {
  return {
    id: unit.id,
    fechamentoId: f.id,
    name: unit.name,
    coordinator: unit.coordinator || "—",
    status: f.status,
    competence: f.competence,
    document: f.document ? {
      id: f.document.id,
      name: f.document.filename,
      size: f.document.size_bytes
    } : null,
    signatureMethod: f.signature_method || "",
    submittedAt: f.submitted_at ? new Date(f.submitted_at).toLocaleString("pt-BR") : "",
    rhNote: f.rh_note || "",
    rhDecisionAt: f.rh_decision_at ? new Date(f.rh_decision_at).toLocaleString("pt-BR") : "",
    rows: f.rows || [],
    editRequest: unit.editRequest || null
  };
}

async function carregarDados() {
  const unidadesApi = await api("/units");

  state.units = unidadesApi.map(u => ({
    id: u.id,
    name: u.name,
    coordinator: "—",
    status: "nao_enviado",
    competence: "—",
    document: null,
    signatureMethod: "",
    submittedAt: "",
    rhNote: "",
    rhDecisionAt: "",
    rows: [],
    fechamentoId: null
  }));

  // A partir daqui, nenhuma chamada depende do resultado das outras —
  // disparamos todas de uma vez em vez de esperar uma por vez.
  const tasks = {};

  if (state.role === "admin" || state.role === "rh") {
    tasks.usuarios = api("/usuarios");
    tasks.aprovacoes = api("/aprovacoes");
  }

  if (state.role === "rh") {
    tasks.rhDashboard = api("/dashboard/rh");
    tasks.editRequests = api("/solicitacoes-edicao?status=pendente");
  }

  if (state.role === "coordinator" && state.user?.unit_id) {
    tasks.fechamentoAtual = api(`/unidades/${state.user.unit_id}/fechamento-atual`);
  }

  // O backend agora pagina /historico (padrão: 300). Pedimos o teto máximo
  // permitido para manter o comportamento atual (tudo carregado de uma vez);
  // se o histórico crescer além disso, o próximo passo é paginar na tela.
  tasks.historico = api("/historico?limit=1000");

  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(keys.map(k => tasks[k]));
  const out = {};
  keys.forEach((k, i) => { out[k] = results[i]; });

  if (out.usuarios) {
    if (out.usuarios.status === "fulfilled") {
      state.users = out.usuarios.value.map(mapUser);
      state.units.forEach(unit => {
        const coord = state.users.find(u => u.perfilRaw === "coordinator" && u.unit_id === unit.id);
        if (coord) unit.coordinator = coord.nome;
      });
    } else {
      console.warn("Não foi possível carregar usuários:", out.usuarios.reason);
    }
  }

  if (out.aprovacoes) {
    if (out.aprovacoes.status === "fulfilled") {
      out.aprovacoes.value.forEach(f => {
        const unitIndex = state.units.findIndex(u => u.id === f.unit_id);
        if (unitIndex >= 0) {
          state.units[unitIndex] = mapFechamento(f, state.units[unitIndex]);
        }
      });
    } else {
      console.warn("Não foi possível carregar aprovações:", out.aprovacoes.reason);
    }
  }

  if (out.rhDashboard) {
    state.rhDashboard = out.rhDashboard.status === "fulfilled" ? out.rhDashboard.value : null;
    if (out.rhDashboard.status === "rejected") {
      console.warn("Não foi possível carregar o dashboard do RH:", out.rhDashboard.reason);
    }
  }

  if (out.editRequests) {
    state.editRequests = out.editRequests.status === "fulfilled" ? out.editRequests.value : [];
    if (out.editRequests.status === "rejected") {
      console.warn("Não foi possível carregar solicitações de edição:", out.editRequests.reason);
    }
  }

  if (out.fechamentoAtual && out.fechamentoAtual.status === "fulfilled") {
    const f = out.fechamentoAtual.value;
    const unitIndex = state.units.findIndex(u => u.id === state.user.unit_id);
    if (unitIndex >= 0) {
      state.units[unitIndex].coordinator = state.user.user;
      state.units[unitIndex] = mapFechamento(f, state.units[unitIndex]);

      try {
        state.units[unitIndex].editRequest = await api(`/fechamentos/${f.id}/solicitacao-edicao`);
      } catch (e) {
        console.warn("Solicitação de edição não carregada:", e);
        state.units[unitIndex].editRequest = null;
      }
    }
  }

  if (out.historico) {
    if (out.historico.status === "fulfilled") {
      state.historyLog = out.historico.value.map(h => ({
        date: new Date(h.timestamp).toLocaleString("pt-BR"),
        user: `Usuário #${h.user_id}`,
        action: h.action,
        unit: state.units.find(u => u.id === h.unit_id)?.name || "—",
        competence: state.units.find(u => u.id === h.unit_id)?.competence || "—",
        status: h.status_snapshot || "info"
      }));
    } else {
      console.warn("Histórico não carregado:", out.historico.reason);
    }
  }
}

async function fazerLogin(email, senha) {
  const form = new URLSearchParams();
  form.set("username", email);
  form.set("password", senha);

  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || "E-mail ou senha incorretos.");
  }

  localStorage.setItem(TOKEN_KEY, data.access_token);

  // O backend retorna os dados do usuário junto do token.
  const userData = data.user;
  if (!userData) {
    throw new Error("Não foi possível carregar os dados do usuário autenticado.");
  }

  localStorage.setItem(USER_KEY, JSON.stringify(userData));
  return userData;
}


const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function seedRow(matricula, nome, cargo, periodo, dt, obs) {
  return { matricula, nome, cargo, periodo, dt, bh: "0", he: "0", an: "0", gr: "0", ins: "0", at: "0", faltas: "0", observacao: obs || "Sem observação" };
}

const state = {
  role: null,
  user: null,
  currentPage: "dashboard",
  uploadedFile: null,
  signatureMethod: "",
  rhDashboard: null,
  editRequests: [],
  units: [
    {
      id: 1, name: "USF Nova Três Lagoas", coordinator: "Coord. Nova Três Lagoas", status: "rascunho", competence: "SETEMBRO/2026",
      document: null, signatureMethod: "", submittedAt: "", rhNote: "", rhDecisionAt: "",
      rows: [
        seedRow("000001", "Servidor Exemplo 01", "Técnico de Enfermagem", "Integral", "30"),
        seedRow("000002", "Servidor Exemplo 02", "Agente Comunitário de Saúde", "Integral", "30"),
        seedRow("000003", "Servidor Exemplo 03", "Enfermeiro(a)", "Integral", "24", "Férias de 14/09 a 28/09/2026"),
      ],
    },
    {
      id: 2, name: "USF Jupiá", coordinator: "Coord. Jupiá", status: "pendente", competence: "SETEMBRO/2026",
      document: { name: "fechamento_usf_jupia_assinado.pdf", size: 184320 }, signatureMethod: "govbr",
      submittedAt: "09/09/2026 16:42", rhNote: "", rhDecisionAt: "",
      rows: [
        seedRow("34220001", "Maria Luiza Aguilera Tarelho", "Técnico Administrativo", "Integral", "40", "Inserida na unidade em 09/06/2026"),
        seedRow("18389001", "Danielli Corsatto", "Agente Comunitária de Saúde", "Integral", "40"),
        seedRow("17838001", "Devair Queiroz de Paila", "Agente Comunitária de Saúde", "Integral", "40", "Férias 06/07 a 20/07/2026"),
        seedRow("24335001", "Anderson Fernando Braiani de Andrea", "Médico", "Integral", "40"),
      ],
    },
    {
      id: 3, name: "USF Vila Piloto", coordinator: "Coord. Vila Piloto", status: "aprovado", competence: "SETEMBRO/2026",
      document: { name: "fechamento_usf_vila_piloto_assinado.pdf", size: 152400 }, signatureMethod: "govbr",
      submittedAt: "08/09/2026 15:18", rhNote: "", rhDecisionAt: "08/09/2026 15:40",
      rows: [
        seedRow("21882001", "Mariela Carolina Portugal Campos", "Enfermeira", "Integral", "40"),
        seedRow("10001", "Roberta Lima Alves", "Técnico de Enfermagem", "Integral", "30"),
        seedRow("10002", "Carlos Eduardo Nunes", "Agente Comunitário de Saúde", "Integral", "30"),
      ],
    },
    {
      id: 4, name: "UBS Interlagos", coordinator: "Coord. Interlagos", status: "correcao", competence: "SETEMBRO/2026",
      document: { name: "fechamento_ubs_interlagos_assinado.pdf", size: 121000 }, signatureMethod: "certificado",
      submittedAt: "08/09/2026 10:02", rhNote: "A matrícula 000019 está com o campo DT em branco. Corrija e reenvie.", rhDecisionAt: "08/09/2026 10:25",
      rows: [
        seedRow("000018", "Servidor Interlagos 01", "Técnico de Enfermagem", "Integral", "30"),
        seedRow("000019", "Servidor Interlagos 02", "Agente Comunitário de Saúde", "Integral", ""),
      ],
    },
    {
      id: 5, name: "UBS Santa Rita", coordinator: "Coord. Santa Rita", status: "nao_enviado", competence: "SETEMBRO/2026",
      document: null, signatureMethod: "", submittedAt: "", rhNote: "", rhDecisionAt: "",
      rows: [
        seedRow("000030", "Servidor Santa Rita 01", "Enfermeiro(a)", "Integral", ""),
      ],
    },
  ],
  pointRows: [],
  historyLog: [
    { date: "09/09/2026 16:42", user: "Coord. Jupiá", action: "Submeteu fechamento", unit: "USF Jupiá", competence: "SETEMBRO/2026", status: "pendente" },
    { date: "08/09/2026 15:40", user: "Responsável RH", action: "Aprovou fechamento", unit: "USF Vila Piloto", competence: "SETEMBRO/2026", status: "aprovado" },
    { date: "08/09/2026 10:25", user: "Responsável RH", action: "Solicitou correção", unit: "UBS Interlagos", competence: "SETEMBRO/2026", status: "correcao" },
    { date: "06/09/2026 09:03", user: "Administrador do Sistema", action: "Atualizou vínculo de coordenador", unit: "USF Jupiá", competence: "—", status: "info" },
  ],
  users: [
    { nome: "Responsável RH", email: "rh@saude.gov.br", perfil: "RH", unidade: "Secretaria Municipal de Saúde", status: "Ativo" },
    { nome: "Coord. Nova Três Lagoas", email: "coord.novaltreslagoas@saude.gov.br", perfil: "Coordenador", unidade: "USF Nova Três Lagoas", status: "Ativo" },
    { nome: "Coord. Jupiá", email: "coord.jupia@saude.gov.br", perfil: "Coordenador", unidade: "USF Jupiá", status: "Ativo" },
    { nome: "Administrador do Sistema", email: "admin@saude.gov.br", perfil: "Administrador", unidade: "Secretaria Municipal de Saúde", status: "Ativo" }
  ]
};

const STORAGE_KEY = "sms-ponto-app-state-v1";

function persist() {
  // Dados permanentes agora são salvos no backend.
}

function loadPersisted() {
  // Mantido por compatibilidade; o carregamento real vem da API.
}

function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY);
  toast("Os dados do sistema permanecem armazenados com segurança.", "success");
}

function myUnit() {
  return state.units.find(u => u.id === state.user?.unit_id) || null;
}

function logHistory(action, unit, status) {
  state.historyLog.unshift({
    date: new Date().toLocaleString("pt-BR"),
    user: state.user?.user || "Sistema",
    action,
    unit: unit?.name || "—",
    competence: unit?.competence || "—",
    status
  });
}

const roles = {
  coordinator: {
    name: "Coordenador da Unidade",
    short: "Coordenador",
    user: "Coord. Nova Três Lagoas",
    initials: "CN",
    nav: [
      ["dashboard", "⌂", "Painel"],
      ["point", "▦", "Fechamento de ponto"],
      ["messages", "✉", "Mensagens"],
      ["history", "↺", "Histórico"],
      ["profile", "○", "Meu perfil"]
    ]
  },
  rh: {
    name: "Responsável do RH",
    short: "RH",
    user: "Responsável RH",
    initials: "RH",
    nav: [
      ["dashboard", "⌂", "Painel"],
      ["approvals", "✓", "Aprovações"],
      ["messages", "✉", "Mensagens"],
      ["units", "⌘", "Unidades"],
      ["users", "♙", "Coordenadores"],
      ["history", "↺", "Histórico"],
      ["patterns", "◈", "Padrões inteligentes"],
      ["profile", "○", "Meu perfil"]
    ]
  },
  admin: {
    name: "Administrador do Sistema",
    short: "Administrador",
    user: "Administrador do Sistema",
    initials: "AD",
    nav: [
      ["dashboard", "⌂", "Painel"],
      ["users", "♙", "Usuários e hierarquia"],
      ["units", "⌘", "Unidades"],
      ["history", "↺", "Auditoria"],
      ["patterns", "◈", "Padrões inteligentes"],
      ["profile", "○", "Meu perfil"]
    ]
  }
};

const statusMeta = {
  rascunho: ["Rascunho", "muted"],
  pendente: ["Aguardando RH", "warning"],
  aprovado: ["Aprovado", "success"],
  correcao: ["Correção solicitada", "warning"],
  rejeitado: ["Rejeitado", "danger"],
  nao_enviado: ["Não enviado", "muted"]
};

function badge(status) {
  const [label, type] = statusMeta[status] || [status, "muted"];
  return `<span class="badge badge--${type}">${label}</span>`;
}

/* =====================================================================
   PRAZO — cálculo de vencimento a partir da competência
   ===================================================================== */

const MESES_PT = ["JANEIRO","FEVEREIRO","MARÇO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];

// O período de apuração vai do dia 11 do mês anterior ao dia 10 do mês da
// própria competência (ex.: competência SETEMBRO/2026 = 11/08 a 10/09), então
// o prazo interno de envio é o dia 10 do mês da competência.
function competenceDeadline(competence) {
  const [mesNome, anoStr] = String(competence || "").split("/");
  const mesIndex = MESES_PT.indexOf(String(mesNome || "").trim().toUpperCase());
  const ano = Number(anoStr);
  if (mesIndex === -1 || !ano) return null;
  return new Date(ano, mesIndex, 10, 23, 59, 59);
}

function daysUntil(date) {
  if (!date) return null;
  const now = new Date();
  return Math.ceil((date.setHours ? date : new Date(date)) - now) / 86400000;
}

function deadlineStatusFor(unit) {
  if (!["rascunho", "nao_enviado", "correcao"].includes(unit.status)) return null;
  const deadline = competenceDeadline(unit.competence);
  if (!deadline) return null;
  const days = Math.ceil((deadline - new Date()) / 86400000);
  if (days > 5) return null;
  return { unit, deadline, days };
}

/* =====================================================================
   BANNER DE PRAZO
   ===================================================================== */

function deadlineBannerHtml() {
  let relevant = [];

  if (state.role === "coordinator") {
    const unit = myUnit();
    if (unit) {
      const info = deadlineStatusFor(unit);
      if (info) relevant = [info];
    }
  } else {
    relevant = state.units.map(deadlineStatusFor).filter(Boolean);
  }

  if (!relevant.length) return "";

  const worst = relevant.reduce((a, b) => (a.days < b.days ? a : b));
  const tone = worst.days < 0 ? "danger" : worst.days <= 2 ? "danger" : "warning";
  const icon = worst.days < 0 ? "!" : "◷";

  if (state.role === "coordinator") {
    const msg = worst.days < 0
      ? `O prazo para envio do fechamento de ${worst.unit.competence} venceu há ${Math.abs(Math.round(worst.days))} dia(s).`
      : worst.days < 1
        ? `O prazo para envio do fechamento de ${worst.unit.competence} termina hoje.`
        : `Faltam ${Math.ceil(worst.days)} dia(s) para o prazo do fechamento de ${worst.unit.competence}.`;

    return `
      <div class="deadline-banner deadline-banner--${tone}">
        <div class="deadline-banner__icon">${icon}</div>
        <div class="deadline-banner__body">
          <strong>${worst.days < 0 ? "Prazo vencido" : "Lembrete de prazo"}</strong>
          <p>${msg} Envie o fechamento o quanto antes para evitar atraso.</p>
        </div>
        <button class="btn btn--outline" data-go="point">Abrir fechamento</button>
      </div>
    `;
  }

  const overdue = relevant.filter(r => r.days < 0);
  const soon = relevant.filter(r => r.days >= 0);

  return `
    <div class="deadline-banner deadline-banner--${tone}">
      <div class="deadline-banner__icon">${icon}</div>
      <div class="deadline-banner__body">
        <strong>${relevant.length} unidade(s) perto do prazo ou atrasada(s)</strong>
        <ul>
          ${overdue.slice(0, 4).map(r => `<li>${escapeHtml(r.unit.name)} — atrasada há ${Math.abs(Math.round(r.days))} dia(s)</li>`).join("")}
          ${soon.slice(0, 4).map(r => `<li>${escapeHtml(r.unit.name)} — ${Math.ceil(r.days)} dia(s) restante(s)</li>`).join("")}
        </ul>
      </div>
    </div>
  `;
}

/* =====================================================================
   NOTIFICAÇÕES
   ===================================================================== */

state.notifPanelOpen = false;

function notifStorageKey() {
  return `sms-ponto-notif-lidas-${state.user?.id || "anon"}`;
}

function getReadNotifIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(notifStorageKey()) || "[]"));
  } catch {
    return new Set();
  }
}

function markNotifRead(id) {
  const ids = getReadNotifIds();
  ids.add(id);
  localStorage.setItem(notifStorageKey(), JSON.stringify([...ids]));
}

function markAllNotifRead(notifications) {
  const ids = getReadNotifIds();
  notifications.forEach(n => ids.add(n.id));
  localStorage.setItem(notifStorageKey(), JSON.stringify([...ids]));
}

function computeNotifications() {
  const items = [];

  if (state.role === "coordinator") {
    const unit = myUnit();
    if (unit) {
      if (unit.status === "aprovado" && unit.rhDecisionAt) {
        items.push({
          id: `aprovado-${unit.id}-${unit.rhDecisionAt}`,
          icon: "✓", tone: "success",
          title: "Fechamento aprovado",
          message: `O fechamento de ${unit.competence} foi aprovado pelo RH.`,
          date: unit.rhDecisionAt, page: "point"
        });
      }
      if (unit.status === "correcao" && unit.rhDecisionAt) {
        items.push({
          id: `correcao-${unit.id}-${unit.rhDecisionAt}`,
          icon: "△", tone: "warning",
          title: "Correção solicitada",
          message: unit.rhNote || `O RH pediu uma correção no fechamento de ${unit.competence}.`,
          date: unit.rhDecisionAt, page: "point"
        });
      }
      if (unit.status === "rejeitado" && unit.rhDecisionAt) {
        items.push({
          id: `rejeitado-${unit.id}-${unit.rhDecisionAt}`,
          icon: "✕", tone: "danger",
          title: "Fechamento rejeitado",
          message: unit.rhNote || `O fechamento de ${unit.competence} foi rejeitado pelo RH.`,
          date: unit.rhDecisionAt, page: "point"
        });
      }
      const info = deadlineStatusFor(unit);
      if (info) {
        items.push({
          id: `prazo-${unit.id}-${unit.competence}`,
          icon: "◷", tone: info.days < 0 ? "danger" : "warning",
          title: info.days < 0 ? "Prazo vencido" : "Prazo se aproximando",
          message: info.days < 0
            ? `O prazo do fechamento de ${unit.competence} venceu há ${Math.abs(Math.round(info.days))} dia(s).`
            : `Faltam ${Math.ceil(info.days)} dia(s) para o prazo do fechamento de ${unit.competence}.`,
          date: new Date().toISOString(), page: "point"
        });
      }
    }
  }

  if (state.role === "rh" || state.role === "admin") {
    state.units.filter(u => u.status === "pendente").forEach(unit => {
      items.push({
        id: `pendente-${unit.id}-${unit.submittedAt}`,
        icon: "◷", tone: "info",
        title: "Fechamento aguardando análise",
        message: `${unit.name} enviou o fechamento de ${unit.competence}.`,
        date: unit.submittedAt, page: "review", params: { unitId: unit.id }
      });
    });

    (state.editRequests || []).forEach(r => {
      items.push({
        id: `edicao-${r.id}`,
        icon: "✎", tone: "info",
        title: "Solicitação de edição pendente",
        message: `${r.requested_by_name || "Coordenador"} (${r.unit_name}) pediu para reabrir o fechamento.`,
        date: r.created_at, page: "approvals"
      });
    });

    state.units.map(deadlineStatusFor).filter(Boolean).forEach(info => {
      items.push({
        id: `prazo-${info.unit.id}-${info.unit.competence}`,
        icon: "◷", tone: info.days < 0 ? "danger" : "warning",
        title: info.days < 0 ? "Unidade com prazo vencido" : "Unidade perto do prazo",
        message: info.days < 0
          ? `${info.unit.name} está atrasada há ${Math.abs(Math.round(info.days))} dia(s).`
          : `${info.unit.name} tem ${Math.ceil(info.days)} dia(s) até o prazo.`,
        date: new Date().toISOString(), page: "units"
      });
    });
  }

  (state.chatSummary?.conversations || [])
    .filter(c => c.unread > 0 && c.last_message)
    .forEach(c => {
      const last = c.last_message;
      const preview = last.body.length > 90 ? `${last.body.slice(0, 90)}…` : last.body;
      items.push({
        id: `msg-${c.unit_id}-${last.id}`,
        icon: "✉", tone: "info",
        title: state.role === "rh" ? `Mensagem de ${c.unit_name}` : "Mensagem do RH",
        message: `${last.sender_name}: ${preview}`,
        date: last.created_at, page: "messages", params: { unitId: c.unit_id }
      });
    });

  return items
    .map(n => ({ ...n, dateObj: n.date ? new Date(n.date) : new Date(0) }))
    .sort((a, b) => b.dateObj - a.dateObj);
}

function renderNotifications() {
  const badge = $("#notifBadge");
  const list = $("#notifList");
  if (!badge || !list) return;

  const notifications = computeNotifications();
  const read = getReadNotifIds();
  const unread = notifications.filter(n => !read.has(n.id));

  badge.textContent = unread.length > 9 ? "9+" : String(unread.length);
  badge.classList.toggle("hidden", unread.length === 0);

  if (!notifications.length) {
    list.innerHTML = `<div class="notif-empty">Nenhuma notificação por aqui.</div>`;
    return;
  }

  list.innerHTML = notifications.map(n => `
    <button type="button" class="notif-item ${!read.has(n.id) ? "notif-item--unread" : ""}" data-notif-id="${n.id}" data-notif-page="${n.page || ""}" data-notif-unit="${n.params?.unitId ?? ""}">
      <div class="notif-item__icon notif-item__icon--${n.tone}">${n.icon}</div>
      <div class="notif-item__body">
        <strong>${escapeHtml(n.title)}</strong>
        <p>${escapeHtml(n.message)}</p>
        <span>${n.dateObj && n.dateObj.getTime() ? n.dateObj.toLocaleString("pt-BR") : ""}</span>
      </div>
      ${!read.has(n.id) ? `<div class="notif-item__dot"></div>` : ""}
    </button>
  `).join("");
}

function toggleNotifPanel(force) {
  const panel = $("#notifPanel");
  const btn = $("#notifBtn");
  if (!panel || !btn) return;
  state.notifPanelOpen = typeof force === "boolean" ? force : !state.notifPanelOpen;
  panel.classList.toggle("hidden", !state.notifPanelOpen);
  btn.setAttribute("aria-expanded", String(state.notifPanelOpen));
  if (state.notifPanelOpen) renderNotifications();
}

function bindNotifications() {
  $("#notifBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifPanel();
  });

  $("#notifMarkAllBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    markAllNotifRead(computeNotifications());
    renderNotifications();
  });

  $("#notifList")?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-notif-id]");
    if (!item) return;
    markNotifRead(item.dataset.notifId);
    toggleNotifPanel(false);
    const page = item.dataset.notifPage;
    const unitId = item.dataset.notifUnit;
    if (page) navigate(page, unitId ? { unitId } : {});
    renderNotifications();
  });

  document.addEventListener("click", (e) => {
    if (state.notifPanelOpen && !e.target.closest("#notifWrap")) toggleNotifPanel(false);
  });

  setInterval(renderNotifications, 60000);
}

/* =====================================================================
   MENSAGENS (chat coordenador <-> RH, uma conversa por unidade)
   ===================================================================== */

state.chat = { unitId: null, messages: [], lastId: 0, threadTimer: null };
state.chatSummary = null;

let chatSummaryTimer = null;
const CHAT_THREAD_POLL_MS = 5000;
const CHAT_SUMMARY_POLL_MS = 20000;

function chatEnabled() {
  return !!state.user && (state.role === "coordinator" || state.role === "rh");
}

/* ---------- resumo (lista de conversas, não lidas, sino) ---------- */

async function refreshChatSummary() {
  if (!chatEnabled()) return;
  try {
    state.chatSummary = await api("/mensagens/resumo");
    updateChatNavBadge();
    renderNotifications();
    if (state.currentPage === "messages") renderChatConversations();
  } catch (e) {
    console.warn("Não foi possível atualizar as mensagens:", e);
  }
}

function startChatSummaryPolling() {
  stopChatSummaryPolling();
  if (!chatEnabled()) return;
  refreshChatSummary();
  chatSummaryTimer = setInterval(() => {
    if (!document.hidden) refreshChatSummary();
  }, CHAT_SUMMARY_POLL_MS);
}

function stopChatSummaryPolling() {
  clearInterval(chatSummaryTimer);
  chatSummaryTimer = null;
}

function updateChatNavBadge() {
  const el = $("#navMsgBadge");
  if (!el) return;
  const n = state.chatSummary?.unread_total || 0;
  el.textContent = n > 9 ? "9+" : String(n);
  el.classList.toggle("hidden", n === 0);
}

/* ---------- tela ---------- */

function messagesView() {
  const isRh = state.role === "rh";
  return `
    <div class="chat ${isRh ? "chat--split" : ""}">
      ${isRh ? `
        <aside class="chat-list">
          <div class="chat-list__search">
            <input id="chatSearch" type="search" placeholder="Buscar unidade..." autocomplete="off" />
          </div>
          <div class="chat-list__items" id="chatConvList"></div>
        </aside>
      ` : ""}
      <section class="chat-thread">
        <header class="chat-thread__head" id="chatHead"></header>
        <div class="chat-thread__msgs" id="chatMsgs" aria-live="polite"></div>
        <form class="chat-composer" id="chatForm" novalidate>
          <textarea id="chatInput" rows="1" maxlength="2000" placeholder="Escreva uma mensagem… (Enter envia, Shift+Enter quebra a linha)" disabled></textarea>
          <button class="btn btn--primary" id="chatSendBtn" type="submit" disabled>Enviar</button>
        </form>
      </section>
    </div>
  `;
}

function chatConversationsSorted() {
  const time = c => (c.last_message ? new Date(c.last_message.created_at).getTime() : 0);
  return [...(state.chatSummary?.conversations || [])].sort((a, b) => {
    const diff = time(b) - time(a);
    return diff !== 0 ? diff : a.unit_name.localeCompare(b.unit_name, "pt-BR");
  });
}

function renderChatConversations() {
  const box = $("#chatConvList");
  if (!box) return;

  const q = ($("#chatSearch")?.value || "").trim().toLowerCase();
  let list = chatConversationsSorted();
  if (q) list = list.filter(c => c.unit_name.toLowerCase().includes(q));

  if (!list.length) {
    box.innerHTML = `<div class="chat-empty">Nenhuma unidade encontrada.</div>`;
    return;
  }

  box.innerHTML = list.map(c => {
    const last = c.last_message;
    const preview = last
      ? `${last.sender_id === state.user.id ? "Você: " : ""}${last.body}`
      : "Nenhuma mensagem ainda";
    return `
      <button type="button" class="chat-conv ${c.unit_id === state.chat.unitId ? "chat-conv--active" : ""}" data-chat-unit="${c.unit_id}">
        <div class="chat-conv__mark">${escapeHtml(initials(c.unit_name))}</div>
        <div class="chat-conv__body">
          <strong>${escapeHtml(c.unit_name)}</strong>
          <span>${escapeHtml(preview)}</span>
        </div>
        ${c.unread ? `<em class="chat-conv__badge">${c.unread > 9 ? "9+" : c.unread}</em>` : ""}
      </button>
    `;
  }).join("");
}

function renderChatHead() {
  const head = $("#chatHead");
  if (!head) return;

  const unitId = state.chat.unitId;
  const conv = (state.chatSummary?.conversations || []).find(c => c.unit_id === unitId);
  const unitName = conv?.unit_name || myUnit()?.name || "";

  if (state.role === "rh") {
    head.innerHTML = `<strong>${escapeHtml(unitName || "Selecione uma unidade")}</strong><span>Conversa com a coordenação da unidade</span>`;
  } else {
    head.innerHTML = `<strong>RH — Secretaria Municipal de Saúde</strong><span>${escapeHtml(unitName)}</span>`;
  }
}

function setChatComposerEnabled(enabled) {
  const input = $("#chatInput");
  const btn = $("#chatSendBtn");
  if (input) input.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

function chatDayLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return "Hoje";
  if (same(date, yesterday)) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function renderChatMessages({ forceBottom = false } = {}) {
  const box = $("#chatMsgs");
  if (!box) return;

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  if (!state.chat.messages.length) {
    box.innerHTML = `<div class="chat-empty">Nenhuma mensagem ainda. Comece a conversa!</div>`;
    return;
  }

  let lastDay = "";
  box.innerHTML = state.chat.messages.map(m => {
    const date = new Date(m.created_at);
    const dayKey = date.toDateString();
    const separator = dayKey !== lastDay ? `<div class="chat-day"><span>${chatDayLabel(date)}</span></div>` : "";
    lastDay = dayKey;

    const mine = m.sender_id === state.user.id;
    const role = m.sender_perfil === "rh" ? "RH" : "Coordenação";
    return `
      ${separator}
      <div class="chat-msg ${mine ? "chat-msg--mine" : "chat-msg--theirs"}">
        <div class="chat-msg__bubble">
          ${mine ? "" : `<span class="chat-msg__author">${escapeHtml(m.sender_name)} · ${role}</span>`}
          <p>${escapeHtml(m.body)}</p>
          <time>${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
      </div>
    `;
  }).join("");

  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- conversa aberta ---------- */

async function openChatThread(unitId) {
  stopChatThreadPolling();
  state.chat.unitId = unitId;
  state.chat.messages = [];
  state.chat.lastId = 0;

  renderChatHead();
  renderChatConversations();
  setChatComposerEnabled(false);

  const box = $("#chatMsgs");
  if (box) box.innerHTML = `<div class="chat-empty">Carregando…</div>`;

  try {
    const msgs = await api(`/unidades/${unitId}/mensagens`);
    if (state.chat.unitId !== unitId || state.currentPage !== "messages") return;

    state.chat.messages = msgs;
    state.chat.lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
    renderChatMessages({ forceBottom: true });
    setChatComposerEnabled(true);
    $("#chatInput")?.focus();

    markChatRead(unitId);
    startChatThreadPolling();
  } catch (e) {
    console.error(e);
    if (box) box.innerHTML = `<div class="chat-empty">Não foi possível carregar a conversa.</div>`;
    toast(e.message || "Erro ao carregar mensagens.", "error");
  }
}

async function markChatRead(unitId) {
  try {
    await api(`/unidades/${unitId}/mensagens/lidas`, { method: "POST" });
  } catch (e) {
    console.warn("Não foi possível marcar como lidas:", e);
  }
  refreshChatSummary();
}

async function pollChatThread() {
  const unitId = state.chat.unitId;
  if (!unitId || document.hidden || state.currentPage !== "messages") return;

  try {
    const novas = await api(`/unidades/${unitId}/mensagens?after_id=${state.chat.lastId}`);
    if (state.chat.unitId !== unitId || !novas.length) return;

    const known = new Set(state.chat.messages.map(m => m.id));
    const fresh = novas.filter(m => !known.has(m.id));
    if (!fresh.length) return;

    state.chat.messages.push(...fresh);
    state.chat.lastId = fresh[fresh.length - 1].id;
    renderChatMessages();

    if (fresh.some(m => m.sender_id !== state.user.id)) markChatRead(unitId);
  } catch (e) {
    console.warn("Falha ao buscar novas mensagens:", e);
  }
}

function startChatThreadPolling() {
  stopChatThreadPolling();
  state.chat.threadTimer = setInterval(pollChatThread, CHAT_THREAD_POLL_MS);
}

function stopChatThreadPolling() {
  clearInterval(state.chat.threadTimer);
  state.chat.threadTimer = null;
}

async function sendChatMessage() {
  const unitId = state.chat.unitId;
  const input = $("#chatInput");
  if (!unitId || !input) return;

  const body = input.value.trim();
  if (!body) return;

  setChatComposerEnabled(false);
  try {
    await api(`/unidades/${unitId}/mensagens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    input.value = "";
    input.style.height = "auto";

    // Busca tudo que ficou pendente (inclusive a mensagem que acabamos de enviar),
    // sem risco de pular uma mensagem do outro lado que chegou no meio.
    await pollChatThread();
    $("#chatMsgs").scrollTop = $("#chatMsgs").scrollHeight;
    refreshChatSummary();
  } catch (e) {
    toast(e.message || "Não foi possível enviar a mensagem.", "error");
  } finally {
    setChatComposerEnabled(true);
    input.focus();
  }
}

async function initMessagesPage(requestedUnitId) {
  const input = $("#chatInput");

  $("#chatForm")?.addEventListener("submit", e => {
    e.preventDefault();
    sendChatMessage();
  });

  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  $("#chatSearch")?.addEventListener("input", debounce(renderChatConversations, 120));

  $("#chatConvList")?.addEventListener("click", e => {
    const item = e.target.closest("[data-chat-unit]");
    if (!item) return;
    const unitId = Number(item.dataset.chatUnit);
    if (unitId !== state.chat.unitId) openChatThread(unitId);
  });

  if (state.role === "coordinator") {
    if (!state.user.unit_id) {
      renderChatHead();
      $("#chatMsgs").innerHTML = `<div class="chat-empty">Você ainda não está vinculado a uma unidade. Peça ao RH ou ao administrador para fazer o vínculo.</div>`;
      return;
    }
    await refreshChatSummary();
    if (state.currentPage !== "messages") return;
    openChatThread(state.user.unit_id);
    return;
  }

  // RH
  $("#chatConvList").innerHTML = `<div class="chat-empty">Carregando…</div>`;
  await refreshChatSummary();
  if (state.currentPage !== "messages") return;

  const sorted = chatConversationsSorted();
  if (!sorted.length) {
    $("#chatConvList").innerHTML = `<div class="chat-empty">Nenhuma unidade ativa.</div>`;
    $("#chatMsgs").innerHTML = `<div class="chat-empty">Não há unidades para conversar.</div>`;
    return;
  }

  const wanted = Number(requestedUnitId) || state.chat.unitId;
  const pick = sorted.find(c => c.unit_id === wanted)
    || sorted.find(c => c.unread > 0)
    || sorted[0];
  openChatThread(pick.unit_id);
}

function toast(message, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.className = "toast", 3000);
}

function openModal({ title, content, actions = "" }) {
  $("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-head">
          <h3>${title}</h3>
          <button class="close-btn" data-modal-close>×</button>
        </div>
        <div class="modal-body">${content}</div>
        ${actions ? `<div class="modal-foot">${actions}</div>` : ""}
      </div>
    </div>
  `;
  $$("[data-modal-close]").forEach(el => el.addEventListener("click", e => {
    if (e.target === el) closeModal();
  }));
}

function closeModal() {
  $("#modalRoot").innerHTML = "";
}

async function setLoginFromUser(userData) {
  state.role = userData.perfil;
  state.user = roleTemplate(userData.perfil, userData);

  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  $("#sidebarUser").textContent = state.user.user;
  $("#sidebarRole").textContent = state.user.name;
  renderCurrentUserAvatars();

  renderNav();
  await refreshCurrentProfilePhoto();

  const content = $("#content");
  if (content) {
    content.innerHTML = `
      <div class="skeleton-v5">
        <div class="skeleton-v5__bar skeleton-v5__bar--title"></div>
        <div class="skeleton-v5__row">
          <div class="skeleton-v5__card"></div>
          <div class="skeleton-v5__card"></div>
          <div class="skeleton-v5__card"></div>
        </div>
        <div class="skeleton-v5__bar"></div>
        <div class="skeleton-v5__bar" style="width:70%"></div>
        <div class="skeleton-v5__bar" style="width:85%"></div>
      </div>
    `;
  }

  try {
    await carregarDados();
    navigate("dashboard");
    renderNotifications();
    startChatSummaryPolling();
  } catch (e) {
    console.error(e);
    toast(e.message || "Erro ao carregar dados do sistema.", "error");
  }
}

function logout() {
  stopChatSummaryPolling();
  stopChatThreadPolling();
  state.chatSummary = null;
  state.chat.unitId = null;
  state.chat.messages = [];
  state.chat.lastId = 0;

  if (currentProfilePhotoUrl) {
    URL.revokeObjectURL(currentProfilePhotoUrl);
    currentProfilePhotoUrl = null;
  }

  state.role = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#loginPassword").value = "";
  $("#sidebar").classList.remove("open");
}

function renderNav() {
  $("#mainNav").innerHTML = state.user.nav.map(([page, icon, label]) => `
    <button data-page="${page}">
      <span class="nav-icon">${icon}</span>
      <span>${label}</span>
      ${page === "messages" ? `<span class="nav-badge hidden" id="navMsgBadge">0</span>` : ""}
    </button>
  `).join("");

  $$("#mainNav button").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.page)));
  updateChatNavBadge();
}

function navigate(page, params = {}) {
  stopChatThreadPolling();
  state.currentPage = page;
  $$("#mainNav button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  $("#sidebar").classList.remove("open");

  const titles = {
    dashboard: ["Visão geral", "Painel"],
    point: ["Fechamento", "Fechamento de ponto"],
    approvals: ["Fluxo de aprovação", "Aprovações"],
    units: ["Estrutura", "Unidades"],
    history: ["Registros", state.role === "admin" ? "Auditoria" : "Histórico"],
    patterns: ["Inteligência", "Padrões inteligentes"],
    users: ["Administração", "Usuários e hierarquia"],
    profile: ["Conta", "Meu perfil"],
    messages: ["Comunicação", "Mensagens"],
    review: ["Aprovações", "Analisar fechamento"]
  };

  $("#breadcrumb").textContent = titles[page]?.[0] || "Sistema";
  $("#pageTitle").textContent = titles[page]?.[1] || "Controle de Ponto";

  if (page === "point" && state.role === "coordinator") {
    const unit = myUnit();
    state.pointRows = unit?.rows || [];
    state.uploadedFile = unit?.document || null;
    state.signatureMethod = unit?.signatureMethod || "";
  }

  const content = $("#content");
  if (page === "dashboard") content.innerHTML = dashboardView();
  if (page === "point") content.innerHTML = pointView();
  if (page === "approvals") content.innerHTML = approvalsView();
  if (page === "units") content.innerHTML = unitsView();
  if (page === "history") content.innerHTML = historyView();
  if (page === "patterns") content.innerHTML = patternsView();
  if (page === "users") content.innerHTML = usersView();
  if (page === "profile") content.innerHTML = profileView();
  if (page === "messages") content.innerHTML = messagesView();
  if (page === "review") content.innerHTML = reviewView(params.unitId || 2);

  bindCurrentPage();
  if (page === "messages") initMessagesPage(params.unitId);
}

function coordinatorDashboard() {
  const unit = myUnit();

  if (!unit) {
    return `
      <div class="page-intro">
        <div>
          <h1>Olá, ${escapeHtml(state.user?.user || "Coordenador")}</h1>
          <p>Seu usuário está ativo, mas não está vinculado a uma unidade de saúde.</p>
        </div>
      </div>
      <div class="notice notice--warning">
        Solicite ao RH ou ao Administrador que vincule seu usuário a uma unidade antes de realizar um fechamento.
      </div>
    `;
  }

  const percent = completionPercent(unit.rows);
  const step1Done = true;
  const step2Done = ["pendente", "aprovado"].includes(unit.status);
  const step3Done = unit.status === "aprovado";
  const step2Current = !step2Done;
  const step3Current = step2Done && !step3Done;

  return `
    <div class="page-intro">
      <div>
        <h1>Bom dia, ${state.user.user}</h1>
        <p>Confira a situação do fechamento da sua unidade e complete as pendências antes do envio ao RH.</p>
      </div>
      <div class="actions">
        <button class="btn btn--primary" data-go="point">Abrir fechamento</button>
      </div>
    </div>

    <div class="grid grid--4">
      <div class="card metric">
        <div class="metric-top"><span>Competência</span><span class="metric-icon">◷</span></div>
        <strong>${unit.competence}</strong>
        <small>11/08 a 10/09</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Servidores</span><span class="metric-icon">♙</span></div>
        <strong>${unit.rows.length}</strong>
        <small>na unidade selecionada</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Preenchimento</span><span class="metric-icon">✓</span></div>
        <strong>${percent}%</strong>
        <small>campos obrigatórios</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Situação</span><span class="metric-icon">!</span></div>
        <strong style="font-size:18px">${statusMeta[unit.status]?.[0] || unit.status}</strong>
        <small>${unit.status === "correcao" || unit.status === "rejeitado" ? "revise e reenvie" : "aguardando documento assinado"}</small>
      </div>
    </div>

    ${unit.rhNote && (unit.status === "correcao" || unit.status === "rejeitado") ? `
      <div class="notice notice--danger" style="margin-top:16px">
        <strong>O RH devolveu este fechamento:</strong> ${escapeHtml(unit.rhNote)}
      </div>
    ` : ""}

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card">
        <div class="section-head">
          <div>
            <h3>Fechamento atual</h3>
            <p>${unit.name}</p>
          </div>
          ${badge(unit.status)}
        </div>
        <div class="card-pad">
          <div class="notice notice--warning">
            Antes de submeter ao RH, todos os campos devem estar preenchidos e o PDF assinado deve ser anexado.
          </div>
          <div class="progress"><div style="width:${percent}%"></div></div>
          <div class="separator"></div>
          <div class="timeline">
            <div class="timeline-item ${step1Done ? "done" : ""}">
              <div class="timeline-dot">✓</div>
              <div class="timeline-content">
                <strong>Fechamento iniciado</strong>
                <p>Rascunho criado para a competência ${unit.competence}.</p>
              </div>
            </div>
            <div class="timeline-item ${step2Done ? "done" : step2Current ? "current" : ""}">
              <div class="timeline-dot">${step2Done ? "✓" : "2"}</div>
              <div class="timeline-content">
                <strong>Preenchimento e assinatura</strong>
                <p>Revise os dados, exporte/assine o documento e faça o upload do PDF.</p>
              </div>
            </div>
            <div class="timeline-item ${step3Done ? "done" : step3Current ? "current" : ""}">
              <div class="timeline-dot">${step3Done ? "✓" : "3"}</div>
              <div class="timeline-content">
                <strong>Análise do RH</strong>
                <p>O fechamento ficará bloqueado para edição após o envio.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <h3>Resumo da unidade</h3>
            <p>Dados vinculados ao perfil do coordenador</p>
          </div>
        </div>
        <div class="card-pad">
          <div class="kv">
            <span>Unidade</span><strong>${myUnit().name}</strong>
            <span>Coordenador</span><strong>${state.user.user}</strong>
            <span>Competência</span><strong>${myUnit().competence}</strong>
            <span>Prazo interno</span><strong>10/09/2026</strong>
            <span>Responsável pela aprovação</span><strong>RH / SMS</strong>
          </div>
        </div>
      </div>
    </div>
  `;
}

function rhDashboard() {
  const d = state.rhDashboard;

  if (!d) {
    return `
      <div class="page-intro">
        <div>
          <h1>Dashboard do RH</h1>
          <p>Não foi possível carregar os indicadores consolidados.</p>
        </div>
      </div>
      <div class="notice notice--warning">Verifique se a rota <strong>/dashboard/rh</strong> foi adicionada ao backend.</div>
    `;
  }

  const t = d.totals || {};
  const units = d.units || [];
  const maxFaltas = Math.max(1, ...units.map(u => Number(u.faltas || 0)));
  const fmt = value => Number(value || 0).toLocaleString("pt-BR");

  const chart = units.length
    ? units.slice(0, 10).map(u => {
        const value = Number(u.faltas || 0);
        const width = value === 0 ? 0 : Math.max(4, Math.round((value / maxFaltas) * 100));
        return `
          <div class="rh-chart-row">
            <span class="rh-chart-name" title="${escapeHtml(u.unit_name)}">${escapeHtml(u.unit_name)}</span>
            <div class="rh-chart-track"><div class="rh-chart-bar" style="width:${width}%"></div></div>
            <strong class="rh-chart-value">${fmt(value)}</strong>
          </div>
        `;
      }).join("")
    : `<div class="empty">Nenhum dado encontrado para os filtros selecionados.</div>`;

  const rows = units.length
    ? units.map(u => `
        <tr>
          <td><strong>${escapeHtml(u.unit_name)}</strong></td>
          <td>${fmt(u.employees)}</td>
          <td>${fmt(u.dt)}</td>
          <td><strong>${fmt(u.faltas)}</strong></td>
          <td>${fmt(u.at)}</td>
          <td>${fmt(u.bh)}</td>
          <td>${fmt(u.he)}</td>
          <td>${fmt(u.an)}</td>
          <td>${fmt(u.gr)}</td>
          <td>${fmt(u.ins)}</td>
          <td>${badge(u.status)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="11" class="empty">Nenhum dado encontrado.</td></tr>`;

  return `
    <div class="page-intro">
      <div>
        <h1>Dashboard do RH</h1>
        <p>Visão consolidada dos dados de ponto por competência e por unidade.</p>
      </div>
      <div class="rh-dashboard-filters">
        <label class="field">
          <span>Competência</span>
          <select id="rhCompetenceFilter">
            ${(d.competences || []).map(c => `<option value="${escapeHtml(c)}" ${c === d.competence ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Unidade</span>
          <select id="rhUnitFilter">
            <option value="">Todas as unidades</option>
            ${(d.available_units || []).map(u => `<option value="${u.id}" ${Number(d.selected_unit_id) === Number(u.id) ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>

    <div class="grid rh-metrics">
      <div class="card metric">
        <div class="metric-top"><span>Servidores</span><span class="metric-icon">♙</span></div>
        <strong>${fmt(t.employees)}</strong>
        <small>registros na competência</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Faltas</span><span class="metric-icon">!</span></div>
        <strong>${fmt(t.absences)}</strong>
        <small>total informado</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Atestados</span><span class="metric-icon">+</span></div>
        <strong>${fmt(t.medical_certificates)}</strong>
        <small>total informado</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Horas extras</span><span class="metric-icon">◷</span></div>
        <strong>${fmt(t.overtime)}</strong>
        <small>HE acumulada</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Banco de horas</span><span class="metric-icon">↺</span></div>
        <strong>${fmt(t.time_bank)}</strong>
        <small>BH acumulado</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Pendentes</span><span class="metric-icon">✓</span></div>
        <strong>${fmt(t.pending)}</strong>
        <small>aguardando análise do RH</small>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card">
        <div class="section-head">
          <div>
            <h3>Faltas por unidade</h3>
            <p>Ranking da competência ${escapeHtml(d.competence)}</p>
          </div>
        </div>
        <div class="card-pad rh-chart-list">${chart}</div>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <h3>Situação dos fechamentos</h3>
            <p>Acompanhamento da competência selecionada</p>
          </div>
        </div>
        <div class="card-pad">
          <div class="rh-status-summary">
            <div class="rh-status-item"><strong>${fmt(t.pending)}</strong><span>Aguardando RH</span></div>
            <div class="rh-status-item"><strong>${fmt(t.approved)}</strong><span>Aprovados</span></div>
            <div class="rh-status-item"><strong>${fmt(t.correction)}</strong><span>Em correção</span></div>
            <div class="rh-status-item"><strong>${fmt(t.rejected)}</strong><span>Rejeitados</span></div>
            <div class="rh-status-item"><strong>${fmt(t.not_sent)}</strong><span>Não enviados</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-head">
        <div>
          <h3>Resumo por unidade</h3>
          <p>DT = dias trabalhados · BH = banco de horas · HE = hora extra · AN = adicional noturno · GR = gratificação · INS = insalubridade · AT = atestado</p>
        </div>
      </div>
      <div class="table-wrap">
        <table style="min-width:1180px">
          <thead>
            <tr>
              <th>Unidade</th><th>Servidores</th><th>DT</th><th>Faltas</th><th>AT</th><th>BH</th><th>HE</th><th>AN</th><th>GR</th><th>INS</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function adminDashboard() {
  return `
    <div class="page-intro">
      <div>
        <h1>Administração do sistema</h1>
      </div>
      <div class="actions">
        <button class="btn btn--primary" data-go="users">Gerenciar usuários</button>
      </div>
    </div>

    <div class="grid grid--4">
      <div class="card metric">
        <div class="metric-top"><span>Usuários ativos</span><span class="metric-icon">♙</span></div>
        <strong>${state.users.length}</strong>
        <small>todos os perfis</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Coordenadores</span><span class="metric-icon">⌘</span></div>
        <strong>${state.users.filter(u => u.perfil === "Coordenador").length}</strong>
        <small>com vínculo de unidade</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Unidades</span><span class="metric-icon">▦</span></div>
        <strong>${state.units.length}</strong>
        <small>cadastradas</small>
      </div>
      <div class="card metric">
        <div class="metric-top"><span>Perfis de acesso</span><span class="metric-icon">⊚</span></div>
        <strong>3</strong>
        <small>Administrador, RH e Coordenador</small>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card">
        <div class="section-head">
          <div><h3>Hierarquia de acesso</h3><p>Perfis e responsabilidades</p></div>
        </div>
        <div class="card-pad">
          <div class="timeline">
            <div class="timeline-item done">
              <div class="timeline-dot">1</div>
              <div class="timeline-content">
                <strong>Administrador</strong>
                <p>Cria usuários, unidades, vínculos e permissões.</p>
              </div>
            </div>
            <div class="timeline-item done">
              <div class="timeline-dot">2</div>
              <div class="timeline-content">
                <strong>RH</strong>
                <p>Visualiza todas as unidades, revisa e aprova fechamentos.</p>
              </div>
            </div>
            <div class="timeline-item current">
              <div class="timeline-dot">3</div>
              <div class="timeline-content">
                <strong>Coordenador</strong>
                <p>Visualiza somente a própria unidade e preenche o fechamento.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function dashboardView() {
  if (state.role === "coordinator") return coordinatorDashboard();
  if (state.role === "rh") return rhDashboard();
  return adminDashboard();
}

function pointView() {
  const unit = myUnit();

  if (!unit) {
    return `
      <div class="page-intro">
        <div>
          <h1>Fechamento de ponto</h1>
          <p>Nenhuma unidade está vinculada ao seu usuário.</p>
        </div>
      </div>
      <div class="notice notice--warning">
        O fechamento ficará disponível quando o RH ou o Administrador vincular você a uma unidade.
      </div>
    `;
  }

  const locked = unit.status === "pendente" || unit.status === "aprovado";

  if (locked) {
    return `
      <div class="page-intro">
        <div>
          <h1>Fechamento de ponto</h1>
          <p>${unit.name} · Competência ${unit.competence}</p>
        </div>
        ${badge(unit.status)}
      </div>

      <div class="notice ${unit.status === "aprovado" ? "notice--info" : "notice--warning"}">
        ${unit.status === "aprovado"
          ? `Este fechamento já foi aprovado pelo RH em ${unit.rhDecisionAt || "data não registrada"} e está bloqueado para edição.`
          : `Este fechamento foi enviado em ${unit.submittedAt || "data não registrada"} e está aguardando a análise do RH. Ele fica bloqueado para edição até que haja uma decisão.`}
      </div>

      ${unit.editRequest?.status === "pendente" ? `
        <div class="notice notice--info" style="margin-top:12px">
          <strong>Solicitação de edição aguardando o RH.</strong><br>
          Motivo: ${escapeHtml(unit.editRequest.reason)}
        </div>
      ` : `
        <div class="actions" style="margin-top:12px">
          <button class="btn btn--secondary" id="requestEditBtn">Solicitar edição ao RH</button>
        </div>
      `}

      <div class="card" style="margin-top:16px">
        <div class="section-head">
          <div><h3>Servidores enviados</h3><p>${unit.rows.length} registro(s)</p></div>
        </div>
        <div class="table-wrap">
          <table class="point-table">
            <thead>
              <tr>
                <th>Matrícula</th><th>Nome</th><th>Cargo</th><th>Período</th>
                <th>DT</th><th>BH</th><th>HE</th><th>AN</th><th>GR</th><th>INS</th><th>AT</th><th>Faltas</th><th>Observação</th>
              </tr>
            </thead>
            <tbody>
              ${unit.rows.map(r => `
                <tr>
                  <td>${escapeHtml(r.matricula)}</td><td><strong>${escapeHtml(r.nome)}</strong></td><td>${escapeHtml(r.cargo)}</td><td>${escapeHtml(r.periodo)}</td>
                  <td>${escapeHtml(r.dt)}</td><td>${escapeHtml(r.bh)}</td><td>${escapeHtml(r.he)}</td><td>${escapeHtml(r.an)}</td><td>${escapeHtml(r.gr)}</td><td>${escapeHtml(r.ins)}</td><td>${escapeHtml(r.at)}</td><td>${escapeHtml(r.faltas ?? 0)}</td><td>${escapeHtml(r.observacao)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card card-pad" style="margin-top:16px">
        <h3 style="margin-top:0;font-size:14px">Documento assinado</h3>
        <div class="file-preview">
          <div class="file-icon">PDF</div>
          <div><strong>${escapeHtml(unit.document?.name || "—")}</strong><span>Assinatura: ${signatureLabel(unit.signatureMethod)}</span></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="page-intro">
      <div>
        <h1>Fechamento de ponto</h1>
        <p>Preencha todos os campos, anexe o documento assinado e envie para análise do RH.</p>
      </div>
      <div class="actions">
        <button id="saveDraftBtn" class="btn btn--outline">Salvar rascunho</button>
        <button id="validateBtn" class="btn btn--secondary">Validar preenchimento</button>
      </div>
    </div>

    ${unit.rhNote && (unit.status === "correcao" || unit.status === "rejeitado") ? `
      <div class="notice notice--danger">
        <strong>Motivo da devolução pelo RH:</strong> ${escapeHtml(unit.rhNote)}
      </div>
    ` : ""}

    <div class="card">
      <div class="section-head">
        <div>
          <h3>Identificação do fechamento</h3>
          <p>Campos obrigatórios vinculados ao envio</p>
        </div>
        <span class="required-tip"><b>*</b> obrigatório</span>
      </div>
      <div class="card-pad">
        <div class="form-grid">
          <label class="field">
            <span>Unidade <b>*</b></span>
            <input value="${escapeHtml(unit.name)}" disabled />
          </label>
          <label class="field">
            <span>Competência <b>*</b></span>
            <input id="competence" value="${escapeHtml(unit.competence)}" required />
          </label>
          <label class="field">
            <span>Início do período <b>*</b></span>
            <input id="periodStart" type="date" value="2026-08-11" required />
          </label>
          <label class="field">
            <span>Fim do período <b>*</b></span>
            <input id="periodEnd" type="date" value="2026-09-10" required />
          </label>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-head">
        <div>
          <h3>Servidores da unidade</h3>
          <p>Todos os campos devem ser informados. Quando não houver ocorrência, use 0; em observação, use "Sem observação".</p>
        </div>
        <button id="addRowBtn" class="btn btn--secondary">+ Adicionar servidor</button>
      </div>
      <div class="table-wrap">
        <table class="point-table">
          <thead>
            <tr>
              <th>Matrícula *</th>
              <th>Nome do servidor *</th>
              <th>Cargo *</th>
              <th>Período *</th>
              <th>DT *</th>
              <th>BH *</th>
              <th>HE *</th>
              <th>AN *</th>
              <th>GR *</th>
              <th>INS *</th>
              <th>AT *</th>
              <th>Faltas *</th>
              <th></th>
              <th>Observação *</th>
            </tr>
          </thead>
          <tbody id="pointBody">
            ${pointRowsHtml()}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid--2" style="margin-top:16px">
      <div class="card">
        <div class="section-head">
          <div>
            <h3>Documento assinado</h3>
            <p>Obrigatório para submeter ao RH</p>
          </div>
        </div>
        <div class="card-pad">
          <label class="field" style="margin-top:0">
            <span>Forma de assinatura <b>*</b></span>
            <select id="signatureMethod" required>
              <option value="">Selecione...</option>
              <option ${state.signatureMethod === "govbr" ? "selected" : ""} value="govbr">Assinatura Gov.br</option>
              <option ${state.signatureMethod === "certificado" ? "selected" : ""} value="certificado">Certificado digital</option>
              <option ${state.signatureMethod === "manual" ? "selected" : ""} value="manual">Assinatura manual digitalizada</option>
              <option ${state.signatureMethod === "outro" ? "selected" : ""} value="outro">Outro meio autorizado</option>
            </select>
          </label>

          <div id="dropzone" class="dropzone" style="margin-top:14px">
            <strong>Arraste o PDF assinado para cá</strong>
            <p>ou selecione o arquivo no computador. Apenas PDF.</p>
            <input id="fileInput" type="file" accept="application/pdf,.pdf" hidden />
            <button id="chooseFileBtn" class="btn btn--outline" type="button">Selecionar PDF</button>
          </div>

          <div id="filePreview">
            ${filePreviewHtml()}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <h3>Regras para envio</h3>
            <p>Validação antes do envio</p>
          </div>
        </div>
        <div class="card-pad">
          <div id="checklist">${checklistHtml()}</div>
          <div class="separator"></div>
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:12px;color:#4f5b6d">
            <input id="confirmTruth" type="checkbox" style="width:16px;min-height:auto;margin-top:2px" />
            <span>Declaro que revisei os dados e que o documento anexado corresponde a este fechamento. <b style="color:var(--danger)">*</b></span>
          </label>
        </div>
      </div>
    </div>

    <div class="submit-bar">
      <div class="summary">
        <strong id="submitSummary">${completionPercent()}% preenchido</strong>
        <span id="submitSub">O envio só será liberado após todas as validações.</span>
      </div>
      <button id="previewBtn" class="btn btn--outline">Pré-visualizar</button>
      <button id="submitPointBtn" class="btn btn--primary" disabled>Submeter ao RH</button>
    </div>
  `;
}

function pointRowsHtml() {
  return state.pointRows.map((r, i) => `
    <tr data-row="${i}">
      <td><input class="cell-mid" data-key="matricula" value="${escapeHtml(r.matricula)}" required /></td>
      <td><input class="cell-wide" data-key="nome" value="${escapeHtml(r.nome)}" required /></td>
      <td><input class="cell-wide" data-key="cargo" value="${escapeHtml(r.cargo)}" required /></td>
      <td>
        <select class="cell-mid" data-key="periodo" required>
          <option value="">Selecione</option>
          ${["Integral","20h","30h","40h","Plantão"].map(p => `<option ${r.periodo === p ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </td>
      ${["dt","bh","he","an","gr","ins","at","faltas"].map(k => `<td><input class="cell-sm" type="number" min="0" step="1" data-key="${k}" value="${escapeHtml(r[k])}" required /></td>`).join("")}
      <td><button class="remove-row" data-remove-row="${i}" title="Remover">×</button></td>
      <td><input class="cell-obs" data-key="observacao" value="${escapeHtml(r.observacao)}" placeholder="Sem observação" required /></td>
    </tr>
  `).join("");
}

function filePreviewHtml() {
  if (!state.uploadedFile) return "";
  return `
    <div class="file-preview">
      <div class="file-icon">PDF</div>
      <div>
        <strong>${escapeHtml(state.uploadedFile.name)}</strong>
        <span>${formatBytes(state.uploadedFile.size)} • documento anexado</span>
      </div>
      <button id="removeFileBtn" class="table-action">Remover</button>
    </div>
  `;
}

function completionPercent(rows = state.pointRows) {
  if (!rows.length) return 0;
  const keys = ["matricula","nome","cargo","periodo","dt","bh","he","an","gr","ins","at","faltas","observacao"];
  let total = rows.length * keys.length;
  let filled = 0;
  rows.forEach(r => keys.forEach(k => {
    if (String(r[k] ?? "").trim() !== "") filled++;
  }));
  return Math.round((filled / total) * 100);
}

function checklistHtml() {
  const rowsOk = completionPercent() === 100 && state.pointRows.length > 0;
  const sigOk = !!state.signatureMethod;
  const fileOk = !!state.uploadedFile;
  const item = (ok, text) => `
    <div style="display:flex;align-items:center;gap:9px;padding:8px 0;font-size:12px">
      <span class="timeline-dot" style="${ok ? "background:var(--success-soft);color:var(--success)" : ""}">${ok ? "✓" : "•"}</span>
      <span style="color:${ok ? "#276d53" : "#637083"}">${text}</span>
    </div>
  `;
  return [
    item(rowsOk, "Todos os campos dos servidores preenchidos"),
    item(sigOk, "Forma de assinatura informada"),
    item(fileOk, "PDF assinado anexado")
  ].join("");
}

function bindPointPage() {
  const body = $("#pointBody");
  if (!body) return;

  $$("[data-key]", body).forEach(input => input.addEventListener("input", e => {
    const tr = e.target.closest("tr");
    const index = Number(tr.dataset.row);
    state.pointRows[index][e.target.dataset.key] = e.target.value;
    e.target.classList.remove("input-error");
    refreshPointValidationUI();
  }));

  $$("[data-remove-row]", body).forEach(btn => btn.addEventListener("click", () => {
    if (state.pointRows.length === 1) {
      toast("O fechamento precisa ter pelo menos um servidor.", "error");
      return;
    }
    state.pointRows.splice(Number(btn.dataset.removeRow), 1);
    $("#pointBody").innerHTML = pointRowsHtml();
    bindPointPage();
    refreshPointValidationUI();
  }));

  $("#addRowBtn")?.addEventListener("click", () => {
    state.pointRows.push({
      matricula: "", nome: "", cargo: "", periodo: "",
      dt: "", bh: "", he: "", an: "", gr: "", ins: "", at: "", faltas: "", observacao: ""
    });
    $("#pointBody").innerHTML = pointRowsHtml();
    bindPointPage();
    refreshPointValidationUI();
    window.scrollTo({ top: document.body.scrollHeight * .55, behavior: "smooth" });
  });

  $("#signatureMethod")?.addEventListener("change", e => {
    state.signatureMethod = e.target.value;
    refreshPointValidationUI();
  });

  $("#chooseFileBtn")?.addEventListener("click", () => $("#fileInput").click());

  $("#fileInput")?.addEventListener("change", e => {
    const file = e.target.files[0];
    handleFile(file);
  });

  const dropzone = $("#dropzone");
  if (dropzone) {
    ["dragenter","dragover"].forEach(ev => dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    }));
    ["dragleave","drop"].forEach(ev => dropzone.addEventListener(ev, e => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    }));
    dropzone.addEventListener("drop", e => handleFile(e.dataTransfer.files[0]));
  }

  $("#removeFileBtn")?.addEventListener("click", () => {
    state.uploadedFile = null;
    $("#filePreview").innerHTML = "";
    refreshPointValidationUI();
  });

  $("#confirmTruth")?.addEventListener("change", refreshPointValidationUI);

  $("#saveDraftBtn")?.addEventListener("click", () => toast("Dados do fechamento atualizados.", "success"));
  $("#validateBtn")?.addEventListener("click", () => validatePoint(true));
  $("#previewBtn")?.addEventListener("click", previewPoint);
  $("#submitPointBtn")?.addEventListener("click", submitPoint);
}

function handleFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    toast("Selecione um arquivo PDF.", "error");
    return;
  }
  state.uploadedFile = file;
  $("#filePreview").innerHTML = filePreviewHtml();
  $("#removeFileBtn")?.addEventListener("click", () => {
    state.uploadedFile = null;
    $("#filePreview").innerHTML = "";
    refreshPointValidationUI();
  });
  refreshPointValidationUI();
  toast("PDF anexado com sucesso.", "success");
}

function validatePoint(showToast = false) {
  let ok = true;
  $$("[data-key]", $("#pointBody")).forEach(input => {
    const valid = String(input.value).trim() !== "";
    input.classList.toggle("input-error", !valid);
    if (!valid) ok = false;
  });

  ["#competence","#periodStart","#periodEnd"].forEach(sel => {
    const el = $(sel);
    if (el && !el.value) {
      el.classList.add("input-error");
      ok = false;
    } else {
      el?.classList.remove("input-error");
    }
  });

  if (!state.signatureMethod) ok = false;
  if (!state.uploadedFile) ok = false;
  if (!$("#confirmTruth")?.checked) ok = false;

  if (showToast) {
    toast(ok ? "Tudo certo. O fechamento pode ser submetido ao RH." : "Ainda existem campos ou documentos obrigatórios pendentes.", ok ? "success" : "error");
  }
  return ok;
}

function refreshPointValidationUI() {
  if (!$("#checklist")) return;
  $("#checklist").innerHTML = checklistHtml();
  const percent = completionPercent();
  $("#submitSummary").textContent = `${percent}% preenchido`;
  const btn = $("#submitPointBtn");
  if (btn) btn.disabled = !validatePoint(false);
}

function previewPoint() {
  const rows = state.pointRows.slice(0, 8).map(r => `
    <tr>
      <td>${escapeHtml(r.matricula)}</td>
      <td>${escapeHtml(r.nome)}</td>
      <td>${escapeHtml(r.cargo)}</td>
      <td>${escapeHtml(r.dt)}</td>
      <td>${escapeHtml(r.observacao)}</td>
    </tr>
  `).join("");

  openModal({
    title: "Pré-visualização do fechamento",
    content: `
      <div class="notice notice--info">Confira abaixo um resumo dos dados informados antes de prosseguir com o envio.</div>
      <div class="kv" style="margin:16px 0">
        <span>Unidade</span><strong>${escapeHtml(myUnit().name)}</strong>
        <span>Competência</span><strong>${escapeHtml($("#competence")?.value || "")}</strong>
        <span>Servidores</span><strong>${state.pointRows.length}</strong>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Matrícula</th><th>Servidor</th><th>Cargo</th><th>DT</th><th>Observação</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `
  });
}

function submitPoint() {
  if (!validatePoint(true)) return;

  openModal({
    title: "Confirmar envio ao RH",
    content: `
      <div class="notice notice--warning">
        Após o envio, o fechamento ficará bloqueado para edição até que o RH aprove ou devolva para correção.
      </div>
      <div class="kv" style="margin-top:16px">
        <span>Unidade</span><strong>${escapeHtml(myUnit().name)}</strong>
        <span>Competência</span><strong>${escapeHtml(myUnit().competence)}</strong>
        <span>Documento</span><strong>${escapeHtml(state.uploadedFile?.name || "")}</strong>
        <span>Assinatura</span><strong>${signatureLabel(state.signatureMethod)}</strong>
      </div>
    `,
    actions: `
      <button class="btn btn--outline" data-modal-close2>Cancelar</button>
      <button class="btn btn--primary" id="confirmSubmitBtn">Confirmar envio</button>
    `
  });

  $("[data-modal-close2]")?.addEventListener("click", closeModal);

  $("#confirmSubmitBtn")?.addEventListener("click", async () => {
    const unit = myUnit();

    try {
      const rows = state.pointRows.map(r => ({
        ...r,
        dt: Number(r.dt || 0),
        bh: Number(r.bh || 0),
        he: Number(r.he || 0),
        an: Number(r.an || 0),
        gr: Number(r.gr || 0),
        ins: Number(r.ins || 0),
        at: Number(r.at || 0),
        faltas: Number(r.faltas || 0),
        observacao: r.observacao || "Sem observação"
      }));

      await api(`/fechamentos/${unit.fechamentoId}/rows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
      });

      if (state.uploadedFile instanceof File) {
        const formData = new FormData();
        formData.append("file", state.uploadedFile);

        await api(`/fechamentos/${unit.fechamentoId}/documento`, {
          method: "POST",
          body: formData
        });
      } else if (!unit.document) {
        throw new Error("Selecione o PDF assinado antes de enviar.");
      }

      await api(`/fechamentos/${unit.fechamentoId}/submeter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature_method: state.signatureMethod })
      });

      closeModal();
      toast("Fechamento enviado ao RH com sucesso.", "success");
      await carregarDados();
      navigate("dashboard");
    } catch (e) {
      console.error(e);
      toast(e.message || "Erro ao enviar fechamento.", "error");
    }
  });
}

function approvalsView() {
  const pending = state.units.filter(u => u.status !== "rascunho" && u.status !== "nao_enviado");
  return `
    <div class="page-intro">
      <div>
        <h1>Central de aprovações</h1>
        <p>Analise os fechamentos enviados pelos coordenadores e registre a decisão do RH.</p>
      </div>
      <div class="actions">
        <select id="statusFilter" style="min-width:190px">
          <option value="all">Todos os status</option>
          <option value="pendente">Aguardando RH</option>
          <option value="aprovado">Aprovado</option>
          <option value="correcao">Correção solicitada</option>
          <option value="rejeitado">Rejeitado</option>
        </select>
      </div>
    </div>

    ${state.editRequests.length ? `
      <div class="card" style="margin-bottom:16px">
        <div class="section-head">
          <div>
            <h3>Solicitações de edição</h3>
            <p>${state.editRequests.length} solicitação(ões) aguardando decisão</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unidade</th>
                <th>Coordenador</th>
                <th>Competência</th>
                <th>Motivo</th>
                <th>Solicitado em</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${state.editRequests.map(r => `
                <tr>
                  <td><strong>${escapeHtml(r.unit_name)}</strong></td>
                  <td>${escapeHtml(r.requested_by_name)}</td>
                  <td>${escapeHtml(r.competence)}</td>
                  <td style="max-width:360px">${escapeHtml(r.reason)}</td>
                  <td>${r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : "—"}</td>
                  <td>
                    <div class="actions">
                      <button class="table-action" data-edit-request-decision="approved" data-request-id="${r.id}">Autorizar</button>
                      <button class="table-action" data-edit-request-decision="rejected" data-request-id="${r.id}">Negar</button>
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    ` : ""}

    <div class="card">
      <div class="section-head">
        <div>
          <h3>Fechamentos recebidos</h3>
          <p>${pending.length} registro(s) exibido(s)</p>
        </div>
      </div>
      <div class="table-wrap">
        <table id="approvalTable">
          <thead>
            <tr>
              <th>Unidade</th>
              <th>Coordenador</th>
              <th>Competência</th>
              <th>Servidores</th>
              <th>Status</th>
              <th>Última atualização</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${pending.map(u => `
              <tr data-status="${u.status}">
                <td><strong>${u.name}</strong></td>
                <td>${u.coordinator}</td>
                <td>${u.competence}</td>
                <td>${u.rows.length}</td>
                <td>${badge(u.status)}</td>
                <td>09/09/2026 • 16:42</td>
                <td><button class="table-action" data-review="${u.id}">Analisar</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function reviewView(unitId) {
  const unit = state.units.find(u => u.id === Number(unitId)) || state.units[1];

  return `
    <div class="page-intro">
      <div>
        <h1>${unit.name}</h1>
        <p>Confira os dados informados pelo coordenador e o documento assinado antes de registrar a decisão.</p>
      </div>
      <div class="actions">
        <button class="btn btn--outline" data-go="approvals">← Voltar</button>
      </div>
    </div>

    <div class="review-layout">
      <div class="card">
        <div class="section-head">
          <div>
            <h3>Dados do fechamento</h3>
            <p>Competência ${unit.competence}</p>
          </div>
          ${badge(unit.status)}
        </div>
        <div class="table-wrap">
          <table style="min-width:1200px">
            <thead>
              <tr>
                <th>Matrícula</th><th>Servidor</th><th>Cargo</th><th>Período</th>
                <th>DT</th><th>BH</th><th>HE</th><th>AN</th><th>GR</th><th>INS</th><th>AT</th><th>Faltas</th><th>Observação</th>
              </tr>
            </thead>
            <tbody>
              ${unit.rows.map(r => `
                <tr>
                  <td>${escapeHtml(r.matricula)}</td><td><strong>${escapeHtml(r.nome)}</strong></td><td>${escapeHtml(r.cargo)}</td><td>${escapeHtml(r.periodo)}</td>
                  <td>${escapeHtml(r.dt)}</td><td>${escapeHtml(r.bh)}</td><td>${escapeHtml(r.he)}</td><td>${escapeHtml(r.an)}</td><td>${escapeHtml(r.gr)}</td><td>${escapeHtml(r.ins)}</td><td>${escapeHtml(r.at)}</td><td>${escapeHtml(r.faltas ?? 0)}</td><td>${escapeHtml(r.observacao)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="review-side">
        <div class="card card-pad">
          <h3 style="margin-top:0;font-size:14px">Resumo</h3>
          <div class="kv">
            <span>Unidade</span><strong>${unit.name}</strong>
            <span>Coordenador</span><strong>${unit.coordinator}</strong>
            <span>Competência</span><strong>${unit.competence}</strong>
            <span>Servidores</span><strong>${unit.rows.length}</strong>
            <span>Enviado em</span><strong>${unit.submittedAt || "—"}</strong>
          </div>
        </div>

        <div class="card card-pad">
          <h3 style="margin-top:0;font-size:14px">Documento assinado</h3>
          <div class="signature-card">
            <span class="badge ${unit.document ? "badge--success" : "badge--danger"}">${unit.document ? "Documento anexado" : "Documento não anexado"}</span>
            <div class="file-preview">
              <div class="file-icon">PDF</div>
              <div>
                <strong>${escapeHtml(unit.document?.name || "—")}</strong>
                <span>Assinatura: ${signatureLabel(unit.signatureMethod)}</span>
              </div>
            </div>
            <button class="btn btn--outline btn--block" style="margin-top:10px" id="openDocBtn" data-document-id="${unit.document?.id ?? ""}">Visualizar documento</button>
          </div>
        </div>

        <div class="card card-pad">
          <h3 style="margin-top:0;font-size:14px">Decisão do RH</h3>
          ${unit.status === "pendente" ? `
            <label class="field">
              <span>Observação da análise</span>
              <textarea id="reviewNote" placeholder="Obrigatória em caso de correção ou rejeição."></textarea>
            </label>
            <div class="grid" style="gap:8px;margin-top:12px">
              <button class="btn btn--success" data-decision="approved" data-unit="${unit.id}">Aprovar fechamento</button>
              <button class="btn btn--secondary" data-decision="correction" data-unit="${unit.id}">Solicitar correção</button>
              <button class="btn btn--danger" data-decision="rejected" data-unit="${unit.id}">Rejeitar</button>
            </div>
          ` : `
            <div class="notice ${unit.status === "aprovado" ? "notice--info" : "notice--danger"}">
              <strong>${statusMeta[unit.status]?.[0] || unit.status}</strong>${unit.rhDecisionAt ? ` em ${unit.rhDecisionAt}` : ""}.
              ${unit.rhNote ? `<br>Observação: ${escapeHtml(unit.rhNote)}` : ""}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

/* =====================================================================
   UNIDADES — layout v5
   ===================================================================== */

const UNIT_FLOW = {
  nao_enviado: { pct: 12, step: "Aguardando preenchimento" },
  rascunho:    { pct: 35, step: "Em preenchimento pela unidade" },
  correcao:    { pct: 55, step: "Correção solicitada pelo RH" },
  pendente:    { pct: 78, step: "Em análise do RH" },
  rejeitado:   { pct: 100, step: "Fechamento rejeitado" },
  aprovado:    { pct: 100, step: "Fechamento aprovado" }
};

const unitsUi = { query: "", status: "todos", mode: "grid" };

function unitMark(name) {
  const clean = String(name || "U").replace(/^(USF|UBS|CAPS|UPA|CEO|SMS)\s+/i, "").trim() || String(name || "U");
  return clean.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join("") || "U";
}

function unitsFiltered() {
  const q = unitsUi.query.trim().toLowerCase();
  return state.units.filter(u => {
    const okStatus = unitsUi.status === "todos" || u.status === unitsUi.status;
    const okQuery = !q
      || String(u.name || "").toLowerCase().includes(q)
      || String(u.coordinator || "").toLowerCase().includes(q)
      || String(u.competence || "").toLowerCase().includes(q);
    return okStatus && okQuery;
  });
}

function unitsView() {
  const isAdmin = state.role === "admin";

  return `
    <div class="head-v5">
      <div class="head-v5__text">
        <span class="head-v5__eyebrow">ESTRUTURA</span>
        <h1>Unidades de saúde</h1>
      </div>
      <div class="head-v5__actions">
        <button class="btn btn--outline" id="unitsExportBtn">↓ Exportar CSV</button>
        ${isAdmin ? `<button class="btn btn--primary" id="newUnitBtn">+ Nova unidade</button>` : ""}
      </div>
    </div>

    ${unitsStats()}

    <section class="panel-v5">
      <div class="panel-v5__toolbar">
        <div class="search-v5">
          <span aria-hidden="true">⌕</span>
          <input id="unitSearch" type="search" placeholder="Buscar unidade, coordenador ou competência..." value="${escapeHtml(unitsUi.query)}" />
        </div>

        <div class="viewtoggle-v5" role="group" aria-label="Modo de exibição">
          <button type="button" data-units-mode="grid" class="${unitsUi.mode === "grid" ? "is-active" : ""}">▦ Cards</button>
          <button type="button" data-units-mode="table" class="${unitsUi.mode === "table" ? "is-active" : ""}">☰ Tabela</button>
        </div>
      </div>

      <div class="chips-v5" id="unitChips">${unitsChips()}</div>

      <div id="unitsResult">${unitsResult()}</div>
    </section>
  `;
}

function unitsStats() {
  const all = state.units;
  const count = s => all.filter(u => u.status === s).length;
  const servers = all.reduce((acc, u) => acc + (u.rows?.length || 0), 0);
  const approved = count("aprovado");
  const rate = all.length ? Math.round((approved / all.length) * 100) : 0;

  const cards = [
    ["Unidades ativas", all.length, `${servers} servidor(es) no total`, "primary", "▦"],
    ["Aguardando RH", count("pendente"), "fechamentos em análise", "warning", "◷"],
    ["Aprovadas", approved, `${rate}% da competência concluída`, "success", "✓"],
    ["Pendências", count("correcao") + count("rejeitado") + count("nao_enviado"), "correções, rejeições e não enviados", "danger", "!"]
  ];

  return `
    <div class="stats-v5">
      ${cards.map(([label, value, hint, tone, icon]) => `
        <article class="stat-v5 stat-v5--${tone}">
          <div class="stat-v5__icon" aria-hidden="true">${icon}</div>
          <div class="stat-v5__body">
            <span>${label}</span>
            <strong>${value}</strong>
            <small>${hint}</small>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function unitsChips() {
  const items = [["todos", "Todas"], ...Object.keys(statusMeta).map(k => [k, statusMeta[k][0]])];
  return items.map(([key, label]) => {
    const total = key === "todos" ? state.units.length : state.units.filter(u => u.status === key).length;
    return `
      <button type="button" class="chip-v5 ${unitsUi.status === key ? "is-active" : ""}" data-unit-status="${key}">
        ${label}<i>${total}</i>
      </button>
    `;
  }).join("");
}

function unitsResult() {
  const list = unitsFiltered();

  if (!list.length) {
    return `
      <div class="empty-v5">
        <div class="empty-v5__mark" aria-hidden="true">⌕</div>
        <strong>Nenhuma unidade encontrada</strong>
        <p>Ajuste a busca ou selecione outro status para ver os resultados.</p>
      </div>
    `;
  }

  return unitsUi.mode === "table"
    ? unitsTable(list)
    : `<div class="unit-grid-v5">${list.map(unitCard).join("")}</div>`;
}

function unitCard(u) {
  const flow = UNIT_FLOW[u.status] || { pct: 10, step: "Situação não informada" };
  const [, tone] = statusMeta[u.status] || ["", "muted"];
  const canReview = state.role === "rh" && ["pendente", "correcao", "rejeitado", "aprovado"].includes(u.status);
  const canDelete = state.role === "admin";

  return `
    <article class="unit-v5 unit-v5--${tone}">
      <header class="unit-v5__head">
        <div class="unit-v5__mark" aria-hidden="true">${unitMark(u.name)}</div>
        <div class="unit-v5__title">
          <strong>${escapeHtml(u.name)}</strong>
          <span>${escapeHtml(u.competence || "—")}</span>
        </div>
        ${badge(u.status)}
      </header>

      <dl class="unit-v5__meta">
        <div>
          <dt>Coordenador</dt>
          <dd>${escapeHtml(u.coordinator || "—")}</dd>
        </div>
        <div>
          <dt>Servidores</dt>
          <dd>${u.rows?.length || 0}</dd>
        </div>
        <div>
          <dt>Envio</dt>
          <dd>${escapeHtml(u.submittedAt || "Não enviado")}</dd>
        </div>
      </dl>

      <div class="unit-v5__flow">
        <div class="unit-v5__bar"><i style="width:${flow.pct}%"></i></div>
        <span>${flow.step}</span>
      </div>

      <footer class="unit-v5__foot">
        ${canReview ? `<button class="btn btn--secondary btn--sm" data-v5 data-review="${u.id}">Abrir fechamento</button>` : ""}
        ${canDelete ? `<button class="btn btn--outline btn--sm" data-v5 data-delete-unit="${u.id}">Excluir</button>` : ""}
        ${!canReview && !canDelete ? `<span class="unit-v5__hint">Somente leitura</span>` : ""}
      </footer>
    </article>
  `;
}

function unitsTable(list = state.units) {
  const showReview = state.role === "rh";
  const showAdminActions = state.role === "admin";

  return `
    <div class="table-wrap table-wrap--v5">
      <table>
        <thead>
          <tr>
            <th>Unidade</th>
            <th>Coordenador</th>
            <th>Servidores</th>
            <th>Competência</th>
            <th>Status</th>
            ${(showReview || showAdminActions) ? "<th>Ações</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${list.map(u => `
            <tr>
              <td>
                <div class="cell-unit-v5">
                  <span class="unit-v5__mark unit-v5__mark--sm" aria-hidden="true">${unitMark(u.name)}</span>
                  <div>
                    <strong>${escapeHtml(u.name)}</strong>
                    <small>${escapeHtml(u.submittedAt || "Sem envio registrado")}</small>
                  </div>
                </div>
              </td>
              <td>${escapeHtml(u.coordinator || "—")}</td>
              <td>${u.rows?.length || 0}</td>
              <td>${escapeHtml(u.competence || "—")}</td>
              <td>${badge(u.status)}</td>
              ${showReview ? `
                <td>
                  ${["pendente","correcao","rejeitado","aprovado"].includes(u.status)
                    ? `<button class="table-action" data-v5 data-review="${u.id}">Abrir</button>`
                    : "—"}
                </td>
              ` : ""}
              ${showAdminActions ? `
                <td><button class="table-action" data-v5 data-delete-unit="${u.id}">Excluir unidade</button></td>
              ` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function refreshUnitsResult() {
  const box = $("#unitsResult");
  if (box) box.innerHTML = unitsResult();
  const chips = $("#unitChips");
  if (chips) chips.innerHTML = unitsChips();
  bindUnitChips();
}

function bindUnitChips() {
  $$("[data-unit-status]").forEach(btn => btn.addEventListener("click", () => {
    unitsUi.status = btn.dataset.unitStatus;
    refreshUnitsResult();
  }));
}

function bindUnitsPage() {
  bindUnitChips();

  $("#unitSearch")?.addEventListener("input", debounce((e) => {
    unitsUi.query = e.target.value;
    const box = $("#unitsResult");
    if (box) box.innerHTML = unitsResult();
  }));

  $$("[data-units-mode]").forEach(btn => btn.addEventListener("click", () => {
    unitsUi.mode = btn.dataset.unitsMode;
    $$("[data-units-mode]").forEach(b => b.classList.toggle("is-active", b === btn));
    const box = $("#unitsResult");
    if (box) box.innerHTML = unitsResult();
  }));

  $("#unitsExportBtn")?.addEventListener("click", () => {
    const rows = [["Unidade", "Coordenador", "Servidores", "Competencia", "Status", "Envio"]];
    unitsFiltered().forEach(u => rows.push([
      u.name, u.coordinator || "—", u.rows?.length || 0, u.competence || "—",
      statusMeta[u.status]?.[0] || u.status, u.submittedAt || "Não enviado"
    ]));
    downloadCsv("unidades.csv", rows);
  });

  $("#unitsResult")?.addEventListener("click", (e) => {
    const review = e.target.closest("[data-review]");
    if (review) {
      navigate("review", { unitId: review.dataset.review });
      return;
    }
    const del = e.target.closest("[data-delete-unit]");
    if (del) deleteUnitById(Number(del.dataset.deleteUnit));
  });
}

async function deleteUnitById(unitId) {
  const unit = state.units.find(u => u.id === unitId);
  if (!unit) return;

  if (!window.confirm(`Excluir a unidade "${unit.name}"? Os fechamentos históricos serão preservados.`)) return;

  try {
    await api(`/units/${unitId}`, { method: "DELETE" });
    toast("Unidade excluída do uso ativo.", "success");
    await carregarDados();
    navigate("units");
  } catch (e) {
    toast(e.message || "Erro ao excluir unidade.", "error");
  }
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Arquivo exportado.", "success");
}

/* =====================================================================
   AUDITORIA / HISTÓRICO — layout v5
   ===================================================================== */

const auditUi = { query: "", filter: "todos" };

const AUDIT_ICONS = {
  aprovado: "✓",
  pendente: "↑",
  correcao: "↻",
  rejeitado: "✕",
  rascunho: "✎",
  nao_enviado: "◌"
};

function auditTone(status) {
  return statusMeta[status]?.[1] || "info";
}

function splitAuditDate(value) {
  const parts = String(value || "").split(/,?\s+/).filter(Boolean);
  return { day: parts[0] || "—", time: parts[1] || "" };
}

function auditFiltered() {
  const q = auditUi.query.trim().toLowerCase();
  return state.historyLog.filter(h => {
    const okFilter = auditUi.filter === "todos"
      || (auditUi.filter === "info" ? !statusMeta[h.status] : h.status === auditUi.filter);
    const okQuery = !q
      || String(h.user || "").toLowerCase().includes(q)
      || String(h.action || "").toLowerCase().includes(q)
      || String(h.unit || "").toLowerCase().includes(q)
      || String(h.competence || "").toLowerCase().includes(q);
    return okFilter && okQuery;
  });
}

function historyView() {
  const isAdmin = state.role === "admin";
  const title = isAdmin ? "Auditoria do sistema" : "Histórico de fechamentos";
  const desc = isAdmin
    ? "Acompanhe todas as ações registradas no sistema."
    : "Acompanhe o histórico de fechamentos da sua unidade.";

  return `
    <div class="head-v5">
      <div class="head-v5__text">
        <span class="head-v5__eyebrow">REGISTROS</span>
        <h1>${title}</h1>
        <p>${desc}</p>
      </div>
      <div class="head-v5__actions">
        <button class="btn btn--outline" id="auditExportBtn">↓ Exportar CSV</button>
      </div>
    </div>

    ${auditStats()}

    <section class="panel-v5">
      <div class="panel-v5__toolbar">
        <div class="search-v5">
          <span aria-hidden="true">⌕</span>
          <input id="auditSearch" type="search" placeholder="Buscar por usuário, ação, unidade ou competência..." value="${escapeHtml(auditUi.query)}" />
        </div>
        <span class="panel-v5__count" id="auditCount">${auditFiltered().length} evento(s)</span>
      </div>

      <div class="chips-v5" id="auditChips">${auditChips()}</div>

      <div id="auditResult">${auditResult()}</div>
    </section>
  `;
}

function auditStats() {
  const all = state.historyLog;
  const by = s => all.filter(h => h.status === s).length;
  const units = new Set(all.map(h => h.unit).filter(u => u && u !== "—"));

  const cards = [
    ["Eventos registrados", all.length, "no período disponível", "primary", "↺"],
    ["Aprovações", by("aprovado"), "decisões favoráveis do RH", "success", "✓"],
    ["Correções e rejeições", by("correcao") + by("rejeitado"), "retornaram para a unidade", "danger", "↻"],
    ["Unidades envolvidas", units.size, "com movimentação registrada", "warning", "▦"]
  ];

  return `
    <div class="stats-v5">
      ${cards.map(([label, value, hint, tone, icon]) => `
        <article class="stat-v5 stat-v5--${tone}">
          <div class="stat-v5__icon" aria-hidden="true">${icon}</div>
          <div class="stat-v5__body">
            <span>${label}</span>
            <strong>${value}</strong>
            <small>${hint}</small>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function auditChips() {
  const items = [
    ["todos", "Todos"],
    ["pendente", "Envios"],
    ["aprovado", "Aprovações"],
    ["correcao", "Correções"],
    ["rejeitado", "Rejeições"],
    ["info", "Administrativo"]
  ];

  return items.map(([key, label]) => {
    const total = key === "todos"
      ? state.historyLog.length
      : key === "info"
        ? state.historyLog.filter(h => !statusMeta[h.status]).length
        : state.historyLog.filter(h => h.status === key).length;

    return `
      <button type="button" class="chip-v5 ${auditUi.filter === key ? "is-active" : ""}" data-audit-filter="${key}">
        ${label}<i>${total}</i>
      </button>
    `;
  }).join("");
}

function auditResult() {
  const list = auditFiltered();

  if (!list.length) {
    return `
      <div class="empty-v5">
        <div class="empty-v5__mark" aria-hidden="true">↺</div>
        <strong>Nenhum registro encontrado</strong>
        <p>Altere o filtro ou refine a busca para visualizar os eventos.</p>
      </div>
    `;
  }

  const groups = [];
  list.forEach(h => {
    const { day, time } = splitAuditDate(h.date);
    let group = groups.find(g => g.day === day);
    if (!group) {
      group = { day, items: [] };
      groups.push(group);
    }
    group.items.push({ ...h, time });
  });

  return `
    <div class="audit-v5">
      ${groups.map(g => `
        <section class="audit-v5__group">
          <header class="audit-v5__day">
            <strong>${escapeHtml(g.day)}</strong>
            <span>${g.items.length} evento(s)</span>
          </header>

          <ol class="audit-v5__list">
            ${g.items.map(h => {
              const tone = auditTone(h.status);
              const icon = AUDIT_ICONS[h.status] || "•";
              return `
                <li class="audit-v5__item audit-v5__item--${tone}">
                  <div class="audit-v5__time">${escapeHtml(h.time || "--:--")}</div>
                  <div class="audit-v5__dot" aria-hidden="true">${icon}</div>
                  <div class="audit-v5__body">
                    <div class="audit-v5__line">
                      <strong>${escapeHtml(h.action)}</strong>
                      ${statusMeta[h.status] ? badge(h.status) : `<span class="badge badge--info">Registrado</span>`}
                    </div>
                    <div class="audit-v5__tags">
                      <span class="tag-v5"><i aria-hidden="true">○</i>${escapeHtml(h.user)}</span>
                      <span class="tag-v5"><i aria-hidden="true">▦</i>${escapeHtml(h.unit)}</span>
                      <span class="tag-v5"><i aria-hidden="true">▤</i>${escapeHtml(h.competence)}</span>
                    </div>
                  </div>
                </li>
              `;
            }).join("")}
          </ol>
        </section>
      `).join("")}
    </div>
  `;
}

function refreshAuditResult() {
  const box = $("#auditResult");
  if (box) box.innerHTML = auditResult();
  const count = $("#auditCount");
  if (count) count.textContent = `${auditFiltered().length} evento(s)`;
  const chips = $("#auditChips");
  if (chips) chips.innerHTML = auditChips();
  bindAuditChips();
}

function bindAuditChips() {
  $$("[data-audit-filter]").forEach(btn => btn.addEventListener("click", () => {
    auditUi.filter = btn.dataset.auditFilter;
    refreshAuditResult();
  }));
}

function bindHistoryPage() {
  bindAuditChips();

  $("#auditSearch")?.addEventListener("input", debounce((e) => {
    auditUi.query = e.target.value;
    const box = $("#auditResult");
    if (box) box.innerHTML = auditResult();
    const count = $("#auditCount");
    if (count) count.textContent = `${auditFiltered().length} evento(s)`;
  }));

  $("#auditExportBtn")?.addEventListener("click", () => {
    const rows = [["Data", "Usuario", "Acao", "Unidade", "Competencia", "Resultado"]];
    auditFiltered().forEach(h => rows.push([
      h.date, h.user, h.action, h.unit, h.competence,
      statusMeta[h.status]?.[0] || "Registrado"
    ]));
    downloadCsv("auditoria.csv", rows);
  });
}


/* =====================================================================
   DETECÇÃO INTELIGENTE DE PADRÕES
   ===================================================================== */

const patternsUi = { competence: "", unitId: "", data: null, loading: false };

function patternLevelMeta(level) {
  return level === "attention"
    ? { label: "Atenção", cls: "danger", icon: "!" }
    : { label: "Verificar", cls: "warning", icon: "⌁" };
}

function patternsView() {
  const data = patternsUi.data;
  const summary = data?.summary || { patterns: 0, attention: 0, review: 0 };
  const units = state.units || [];

  return `
    <div class="head-v5">
      <div class="head-v5__text">
        <span class="head-v5__eyebrow">INTELIGÊNCIA</span>
        <h1>Padrões inteligentes</h1>
        <p>O sistema compara os lançamentos atuais com o histórico dos servidores, do cargo e da unidade para apontar comportamentos fora do padrão.</p>
      </div>
      <div class="head-v5__actions">
        <button class="btn btn--outline" id="patternsRefreshBtn">↻ Analisar novamente</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-pad">
        <div class="form-grid">
          <label class="field">
            <span>Competência</span>
            <input id="patternsCompetence" value="${escapeHtml(patternsUi.competence)}" placeholder="Ex.: SETEMBRO/2026" />
          </label>
          <label class="field">
            <span>Unidade</span>
            <select id="patternsUnit">
              <option value="">Todas as unidades</option>
              ${units.map(u => `<option value="${u.id}" ${String(patternsUi.unitId) === String(u.id) ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="muted" style="margin:12px 0 0">São necessários pelo menos 2 históricos do servidor para uma comparação individual. Os alertas são indicativos e devem ser conferidos pelo RH.</p>
      </div>
    </div>

    <div class="stats-v5">
      <article class="stat-v5 stat-v5--primary"><div class="stat-v5__icon">◈</div><div class="stat-v5__body"><span>Padrões encontrados</span><strong>${summary.patterns}</strong><small>${data?.competence || "análise ainda não executada"}</small></div></article>
      <article class="stat-v5 stat-v5--danger"><div class="stat-v5__icon">!</div><div class="stat-v5__body"><span>Atenção</span><strong>${summary.attention}</strong><small>mudanças mais expressivas</small></div></article>
      <article class="stat-v5 stat-v5--warning"><div class="stat-v5__icon">⌁</div><div class="stat-v5__body"><span>Para verificar</span><strong>${summary.review}</strong><small>fora do padrão esperado</small></div></article>
      <article class="stat-v5 stat-v5--success"><div class="stat-v5__icon">✓</div><div class="stat-v5__body"><span>Histórico utilizado</span><strong>${data?.method?.minimum_history || 2}+</strong><small>competências por servidor</small></div></article>
    </div>

    <section class="panel-v5">
      <div class="panel-v5__toolbar">
        <strong style="font-size:14px">Alertas encontrados</strong>
        <span class="panel-v5__count">${data?.patterns?.length || 0} registro(s)</span>
      </div>
      ${patternsResultHtml(data)}
    </section>
  `;
}

function patternsResultHtml(data) {
  if (patternsUi.loading) return `<div class="empty-v5"><div class="empty-v5__mark">↻</div><strong>Analisando histórico…</strong><p>Comparando servidores, cargos e unidades.</p></div>`;
  if (!data) return `<div class="empty-v5"><div class="empty-v5__mark">◈</div><strong>Pronto para analisar</strong><p>Clique em “Analisar novamente” para executar a detecção de padrões.</p></div>`;
  if (!data.patterns?.length) return `<div class="empty-v5"><div class="empty-v5__mark">✓</div><strong>Nenhum padrão fora do esperado foi encontrado</strong><p>Isso não significa que os lançamentos estejam automaticamente corretos; significa apenas que não houve sinal estatístico pelos critérios atuais.</p></div>`;

  return `<div class="patterns-list-v5">${data.patterns.map(patternCardHtml).join("")}</div>`;
}

function patternCardHtml(p) {
  const meta = patternLevelMeta(p.level);
  if (p.kind === "servidor") {
    return `<article class="pattern-v5 pattern-v5--${meta.cls}">
      <div class="pattern-v5__top"><span class="pattern-v5__icon">${meta.icon}</span><div><strong>${escapeHtml(p.nome)}</strong><small>${escapeHtml(p.cargo || "Cargo não informado")} · matrícula ${escapeHtml(p.matricula)}</small></div><span class="badge badge--${meta.cls}">${meta.label}</span></div>
      <p>${escapeHtml(p.message)}</p>
      <div class="pattern-v5__chips">${p.anomalies.map(a => `<span class="tag-v5"><b>${escapeHtml(a.label)}</b> ${a.current} · média ${a.history.mean}${a.ratio ? ` · ${a.ratio}x` : ""}</span>`).join("")}</div>
      <small class="pattern-v5__hint">${escapeHtml(p.unit_name)} · ${escapeHtml(p.competence)} · ${p.historico_meses} competência(s) históricas usadas</small>
    </article>`;
  }
  return `<article class="pattern-v5 pattern-v5--${meta.cls}">
    <div class="pattern-v5__top"><span class="pattern-v5__icon">${meta.icon}</span><div><strong>${escapeHtml(p.message)}</strong><small>${escapeHtml(p.unit_name)} · ${escapeHtml(p.competence)}</small></div><span class="badge badge--${meta.cls}">${meta.label}</span></div>
    <p>${p.current != null ? `${escapeHtml(p.label)} atual: <b>${p.current}</b> · média histórica: <b>${p.historical_mean}</b> · ${p.ratio}x` : `${p.affected} servidores envolvidos`}</p>
  </article>`;
}

async function runPatternsAnalysis() {
  patternsUi.competence = $("#patternsCompetence")?.value.trim() || "";
  patternsUi.unitId = $("#patternsUnit")?.value || "";
  patternsUi.loading = true;
  const box = $("#content");
  if (box) box.innerHTML = patternsView();
  bindPatternsPage();
  try {
    const params = new URLSearchParams();
    if (patternsUi.competence) params.set("competence", patternsUi.competence);
    if (patternsUi.unitId) params.set("unit_id", patternsUi.unitId);
    patternsUi.data = await api(`/auditoria/padroes?${params.toString()}`);
  } catch (e) {
    patternsUi.data = null;
    toast(e.message || "Não foi possível executar a análise.", "error");
  } finally {
    patternsUi.loading = false;
    if (state.currentPage === "patterns") {
      $("#content").innerHTML = patternsView();
      bindPatternsPage();
    }
  }
}

function bindPatternsPage() {
  $("#patternsRefreshBtn")?.addEventListener("click", runPatternsAnalysis);
  if (!patternsUi.data && !patternsUi.loading && state.currentPage === "patterns") {
    setTimeout(runPatternsAnalysis, 0);
  }
}

/* =====================================================================
   USUÁRIOS E HIERARQUIA — layout v5
   ===================================================================== */

const usersUi = { query: "", perfil: "todos", mode: "grid" };

function usersScope() {
  return state.role === "rh"
    ? state.users.filter(u => u.perfilRaw === "coordinator")
    : state.users;
}

function usersFiltered() {
  const q = usersUi.query.trim().toLowerCase();
  return usersScope().filter(u => {
    const okPerfil = usersUi.perfil === "todos" || u.perfilRaw === usersUi.perfil;
    const okQuery = !q
      || String(u.nome || "").toLowerCase().includes(q)
      || String(u.email || "").toLowerCase().includes(q)
      || String(u.unidade || "").toLowerCase().includes(q);
    return okPerfil && okQuery;
  });
}

function usersView() {
  const isAdmin = state.role === "admin";
  const title = state.role === "rh" ? "Coordenadores" : "Usuários e hierarquia";
  const description = isAdmin
    ? "Gerencie usuários, perfis e a vinculação de coordenadores às unidades."
    : "Consulte os coordenadores vinculados às unidades de saúde.";

  return `
    <div class="head-v5">
      <div class="head-v5__text">
        <span class="head-v5__eyebrow">ADMINISTRAÇÃO</span>
        <h1>${title}</h1>
        <p>${description}</p>
      </div>
      <div class="head-v5__actions">
        <button class="btn btn--outline" id="usersExportBtn">↓ Exportar CSV</button>
        ${isAdmin ? `<button class="btn btn--primary" id="newUserBtn">+ Novo usuário</button>` : ""}
      </div>
    </div>

    ${usersStats()}

    ${isAdmin ? `
      <div class="levels-v5">
        <article class="level-v5 level-v5--1">
          <span class="role-chip">NÍVEL 1</span>
          <strong>Administrador</strong>
          <p>Gerencia estrutura, unidades, perfis e permissões do sistema.</p>
        </article>
        <article class="level-v5 level-v5--2">
          <span class="role-chip">NÍVEL 2</span>
          <strong>RH</strong>
          <p>Visualiza todas as unidades, analisa e decide as aprovações.</p>
        </article>
        <article class="level-v5 level-v5--3">
          <span class="role-chip">NÍVEL 3</span>
          <strong>Coordenador</strong>
          <p>Acessa somente a unidade vinculada e envia o fechamento.</p>
        </article>
      </div>
    ` : ""}

    <section class="panel-v5">
      <div class="panel-v5__toolbar">
        <div class="search-v5">
          <span aria-hidden="true">⌕</span>
          <input id="userSearch" type="search" placeholder="Buscar por nome, e-mail ou unidade..." value="${escapeHtml(usersUi.query)}" />
        </div>

        <div class="viewtoggle-v5" role="group" aria-label="Modo de exibição">
          <button type="button" data-users-mode="grid" class="${usersUi.mode === "grid" ? "is-active" : ""}">▦ Cards</button>
          <button type="button" data-users-mode="table" class="${usersUi.mode === "table" ? "is-active" : ""}">☰ Tabela</button>
        </div>
      </div>

      <div class="chips-v5" id="userChips">${usersChips()}</div>

      <div id="usersResult">${usersResult()}</div>
    </section>
  `;
}

function usersStats() {
  const all = usersScope();
  const by = p => all.filter(u => u.perfilRaw === p).length;
  const coords = all.filter(u => u.perfilRaw === "coordinator");
  const semVinculo = coords.filter(u => !u.unit_id).length;

  const cards = [
    ["Usuários", all.length, `${all.filter(u => u.status === "Ativo").length} ativo(s)`, "primary", "○"],
    ["Coordenadores", coords.length, `${coords.length - semVinculo} com unidade vinculada`, "success", "▦"],
    ["Sem vínculo", semVinculo, "aguardando vinculação de unidade", "warning", "!"],
    ["RH e Administração", by("rh") + by("admin"), "acessos com escopo global", "info", "⌘"]
  ];

  return `
    <div class="stats-v5">
      ${cards.map(([label, value, hint, tone, icon]) => `
        <article class="stat-v5 stat-v5--${tone}">
          <div class="stat-v5__icon" aria-hidden="true">${icon}</div>
          <div class="stat-v5__body">
            <span>${label}</span>
            <strong>${value}</strong>
            <small>${hint}</small>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function usersChips() {
  const items = state.role === "rh"
    ? [["todos", "Todos"], ["coordinator", "Coordenadores"]]
    : [["todos", "Todos"], ["admin", "Administradores"], ["rh", "RH"], ["coordinator", "Coordenadores"]];

  return items.map(([key, label]) => {
    const total = key === "todos"
      ? usersScope().length
      : usersScope().filter(u => u.perfilRaw === key).length;

    return `
      <button type="button" class="chip-v5 ${usersUi.perfil === key ? "is-active" : ""}" data-user-perfil="${key}">
        ${label}<i>${total}</i>
      </button>
    `;
  }).join("");
}

function userActions(u) {
  return `
    ${state.role === "admin" ? `<button class="table-action" data-v5 data-edit-user-id="${u.id}">Editar</button>` : ""}
    ${u.perfilRaw === "coordinator" && u.unit_id
      ? `<button class="table-action" data-v5 data-unlink-user="${u.id}">Desvincular</button>`
      : ""}
    ${u.perfilRaw === "coordinator" && !u.unit_id && u.status === "Ativo"
      ? `<button class="table-action" data-v5 data-link-user="${u.id}">Vincular</button>`
      : ""}
    ${u.id !== state.user?.id
      ? `<button class="table-action table-action--danger" data-v5 data-delete-user="${u.id}">Excluir</button>`
      : `<span class="unit-v5__hint">Seu acesso</span>`}
  `;
}

function usersResult() {
  const list = usersFiltered();

  if (!list.length) {
    return `
      <div class="empty-v5">
        <div class="empty-v5__mark" aria-hidden="true">○</div>
        <strong>Nenhum usuário encontrado</strong>
        <p>Ajuste a busca ou selecione outro perfil de acesso.</p>
      </div>
    `;
  }

  if (usersUi.mode === "table") {
    return `
      <div class="table-wrap table-wrap--v5">
        <table>
          <thead>
            <tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Unidade / Escopo</th><th>Status</th><th>Ações</th></tr>
          </thead>
          <tbody>
            ${list.map(u => `
              <tr>
                <td>
                  <div class="cell-unit-v5">
                    <span class="user-v5__avatar user-v5__avatar--sm" aria-hidden="true">${initials(u.nome)}</span>
                    <div><strong>${escapeHtml(u.nome)}</strong></div>
                  </div>
                </td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="role-chip">${escapeHtml(u.perfil)}</span></td>
                <td>${escapeHtml(u.unidade)}</td>
                <td><span class="badge ${u.status === "Ativo" ? "badge--success" : "badge--danger"}">${escapeHtml(u.status)}</span></td>
                <td><div class="actions">${userActions(u)}</div></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  return `
    <div class="user-grid-v5">
      ${list.map(u => `
        <article class="user-v5 user-v5--${u.perfilRaw}">
          <header class="user-v5__head">
            <div class="user-v5__avatar" aria-hidden="true">${initials(u.nome)}</div>
            <div class="user-v5__id">
              <strong>${escapeHtml(u.nome)}</strong>
              <span>${escapeHtml(u.email)}</span>
            </div>
            <span class="badge ${u.status === "Ativo" ? "badge--success" : "badge--danger"}">${escapeHtml(u.status)}</span>
          </header>

          <div class="user-v5__meta">
            <span class="role-chip">${escapeHtml(u.perfil)}</span>
            <span class="tag-v5"><i aria-hidden="true">▦</i>${escapeHtml(u.unidade)}</span>
          </div>

          <footer class="user-v5__foot">${userActions(u)}</footer>
        </article>
      `).join("")}
    </div>
  `;
}

function refreshUsersResult() {
  const box = $("#usersResult");
  if (box) box.innerHTML = usersResult();
  const chips = $("#userChips");
  if (chips) chips.innerHTML = usersChips();
  bindUserChips();
}

function bindUserChips() {
  $$("[data-user-perfil]").forEach(btn => btn.addEventListener("click", () => {
    usersUi.perfil = btn.dataset.userPerfil;
    refreshUsersResult();
  }));
}

function bindUsersPage() {
  bindUserChips();

  $("#userSearch")?.addEventListener("input", debounce((e) => {
    usersUi.query = e.target.value;
    const box = $("#usersResult");
    if (box) box.innerHTML = usersResult();
  }));

  $$("[data-users-mode]").forEach(btn => btn.addEventListener("click", () => {
    usersUi.mode = btn.dataset.usersMode;
    $$("[data-users-mode]").forEach(b => b.classList.toggle("is-active", b === btn));
    const box = $("#usersResult");
    if (box) box.innerHTML = usersResult();
  }));

  $("#usersExportBtn")?.addEventListener("click", () => {
    const rows = [["Nome", "E-mail", "Perfil", "Unidade/Escopo", "Status"]];
    usersFiltered().forEach(u => rows.push([u.nome, u.email, u.perfil, u.unidade, u.status]));
    downloadCsv("usuarios.csv", rows);
  });

  $("#usersResult")?.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit-user-id]");
    if (edit) return openEditUserModal(Number(edit.dataset.editUserId));

    const link = e.target.closest("[data-link-user]");
    if (link) return openLinkUserModal(Number(link.dataset.linkUser));

    const unlink = e.target.closest("[data-unlink-user]");
    if (unlink) return unlinkUserById(Number(unlink.dataset.unlinkUser));

    const del = e.target.closest("[data-delete-user]");
    if (del) return deleteUserById(Number(del.dataset.deleteUser));
  });
}

async function deleteUserById(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;

  if (!window.confirm(`Excluir o acesso de ${user.nome}? O histórico será preservado.`)) return;

  try {
    await api(`/usuarios/${userId}`, { method: "DELETE" });
    toast("Usuário excluído do acesso ao sistema.", "success");
    await carregarDados();
    navigate("users");
  } catch (e) {
    toast(e.message || "Erro ao excluir usuário.", "error");
  }
}

async function unlinkUserById(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;

  if (!window.confirm(`Desvincular ${user.nome} da unidade atual?`)) return;

  try {
    await api(`/usuarios/${userId}/desvincular-unidade`, { method: "PATCH" });
    toast("Coordenador desvinculado.", "success");
    await carregarDados();
    navigate("users");
  } catch (e) {
    toast(e.message || "Erro ao desvincular coordenador.", "error");
  }
}

function profileView() {
  const isCoordinator = state.role === "coordinator";
  const unit = isCoordinator ? myUnit() : null;

  const roleLabel = state.user?.short || state.user?.name || "Usuário";
  const scopeLabel = isCoordinator ? "Unidade vinculada" : "Escopo de acesso";
  const scopeValue = isCoordinator
    ? (unit?.name || "Nenhuma unidade vinculada")
    : "Todas as unidades";

  return `
    <div class="profile-v4">
      <div class="profile-v4__heading">
        <span class="profile-v4__eyebrow">CONTA</span>
        <h1>Meu perfil</h1>
      </div>

      <section class="card profile-v4__shell">
        <aside class="profile-v4__aside">
          <div class="profile-v4__aside-inner">
            <div class="profile-v4__avatar-wrap">
              <div class="avatar profile-v4__avatar" id="profileAvatarLarge">
                ${state.user.initials}
              </div>

              <button
                class="profile-v4__avatar-edit"
                id="changeProfilePhotoBtn"
                type="button"
                title="Alterar foto"
                aria-label="Alterar foto de perfil"
              >✎</button>
            </div>

            <div class="profile-v4__aside-name">
              <strong>${escapeHtml(state.user.user)}</strong>
              <span>${escapeHtml(roleLabel)}</span>
            </div>

            <div class="profile-v4__photo-actions">
              <button class="btn btn--primary" id="changeProfilePhotoBtnSecondary" type="button">
                Alterar foto
              </button>
              <button class="btn btn--outline" id="removeProfilePhotoBtn" type="button">
                Remover foto
              </button>
            </div>

            <div class="profile-v4__aside-meta">
              <p>${escapeHtml(state.user.email || "—")}</p>
              <span class="profile-v4__status">
                <span class="profile-v4__status-dot"></span>
                Conta ativa
              </span>
            </div>
          </div>
        </aside>

        <div class="profile-v4__content">
          <div class="profile-v4__cards">
            <section class="profile-v4__panel profile-v4__panel--info">
              <div class="profile-v4__panel-header">
                <span class="profile-v4__eyebrow">INFORMAÇÕES</span>
                <h3>Dados da conta</h3>
              </div>

              <div class="profile-v4__info-box">
                <div class="profile-v4__info-row">
                  <span>Nome completo</span>
                  <strong>${escapeHtml(state.user.user)}</strong>
                </div>

                <div class="profile-v4__info-row">
                  <span>E-mail</span>
                  <strong>${escapeHtml(state.user.email || "—")}</strong>
                </div>

                <div class="profile-v4__info-row">
                  <span>Perfil de acesso</span>
                  <strong>${escapeHtml(roleLabel)}</strong>
                </div>

                <div class="profile-v4__info-row">
                  <span>${scopeLabel}</span>
                  <strong class="${isCoordinator && !unit ? "text-warning" : ""}">
                    ${escapeHtml(scopeValue)}
                  </strong>
                </div>
              </div>
            </section>

            <section class="profile-v4__panel profile-v4__panel--security">
              <div class="profile-v4__panel-header">
                <span class="profile-v4__eyebrow">SEGURANÇA</span>
                <h3>Redefinir senha</h3>
              </div>

              <form id="profilePasswordForm" class="profile-v4__password-form">
                <label class="profile-v4__field">
                  <span>Senha atual</span>
                  <input
                    type="password"
                    id="profileCurrentPassword"
                    placeholder="Digite sua senha atual"
                    autocomplete="current-password"
                    required
                  />
                </label>

                <label class="profile-v4__field">
                  <span>Nova senha</span>
                  <input
                    type="password"
                    id="profileNewPassword"
                    placeholder="Mínimo de 8 caracteres"
                    autocomplete="new-password"
                    minlength="8"
                    required
                  />
                </label>

                <label class="profile-v4__field">
                  <span>Confirmar nova senha</span>
                  <input
                    type="password"
                    id="profileConfirmPassword"
                    placeholder="Repita a nova senha"
                    autocomplete="new-password"
                    minlength="8"
                    required
                  />
                </label>

                <button class="btn btn--primary profile-v4__password-btn" type="submit">
                  Alterar senha
                </button>
              </form>
            </section>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindCurrentPage() {
  $$("[data-go]").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.go)));

  $$("[data-review]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => navigate("review", { unitId: btn.dataset.review })));

  if (state.currentPage === "point") bindPointPage();
  if (state.currentPage === "units") bindUnitsPage();
  if (state.currentPage === "history") bindHistoryPage();
  if (state.currentPage === "patterns") bindPatternsPage();
  if (state.currentPage === "users") bindUsersPage();

  const reloadRhDashboard = async () => {
    if (state.role !== "rh") return;
    const competence = $("#rhCompetenceFilter")?.value || "";
    const unitId = $("#rhUnitFilter")?.value || "";
    const params = new URLSearchParams();
    if (competence) params.set("competence", competence);
    if (unitId) params.set("unit_id", unitId);

    try {
      state.rhDashboard = await api(`/dashboard/rh?${params.toString()}`);
      navigate("dashboard");
    } catch (e) {
      toast(e.message || "Erro ao atualizar o dashboard do RH.", "error");
    }
  };

  $("#rhCompetenceFilter")?.addEventListener("change", reloadRhDashboard);
  $("#rhUnitFilter")?.addEventListener("change", reloadRhDashboard);

  $("#statusFilter")?.addEventListener("change", e => {
    $$("#approvalTable tbody tr").forEach(tr => {
      tr.style.display = e.target.value === "all" || tr.dataset.status === e.target.value ? "" : "none";
    });
  });

  $$("[data-decision]").forEach(btn => btn.addEventListener("click", async () => {
    const note = $("#reviewNote")?.value.trim();
    const decision = btn.dataset.decision;

    if (decision !== "approved" && !note) {
      $("#reviewNote").classList.add("input-error");
      toast("Informe a justificativa para correção ou rejeição.", "error");
      return;
    }

    const unit = state.units.find(u => u.id === Number(btn.dataset.unit));
    if (!unit?.fechamentoId) {
      toast("Fechamento não encontrado.", "error");
      return;
    }

    try {
      await api(`/fechamentos/${unit.fechamentoId}/decisao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: decision === "approved" ? null : note
        })
      });

      toast(
        decision === "approved"
          ? "Fechamento aprovado."
          : "Decisão registrada e devolvida ao coordenador.",
        "success"
      );

      await carregarDados();
      navigate("approvals");
    } catch (e) {
      toast(e.message || "Erro ao registrar decisão.", "error");
    }
  }));

  $("#openDocBtn")?.addEventListener("click", async (e) => {
    const documentId = e.currentTarget.dataset.documentId;
    if (!documentId) {
      toast("Nenhum documento foi anexado a este fechamento.", "error");
      return;
    }

    await abrirDocumento(Number(documentId));
  });


  $("#requestEditBtn")?.addEventListener("click", () => {
    const unit = myUnit();
    if (!unit?.fechamentoId) {
      toast("Fechamento não encontrado.", "error");
      return;
    }
    openEditRequestModal(unit);
  });

  $$("[data-edit-request-decision]").forEach(btn => btn.addEventListener("click", () => {
    openEditRequestDecisionModal(
      Number(btn.dataset.requestId),
      btn.dataset.editRequestDecision
    );
  }));

  $$("[data-delete-user]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => {
    deleteUserById(Number(btn.dataset.deleteUser));
  }));

  $$("[data-unlink-user]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => {
    unlinkUserById(Number(btn.dataset.unlinkUser));
  }));

  $$("[data-link-user]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => {
    openLinkUserModal(Number(btn.dataset.linkUser));
  }));

  $$("[data-delete-unit]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => {
    deleteUnitById(Number(btn.dataset.deleteUnit));
  }));

  $("#newUserBtn")?.addEventListener("click", openNewUserModal);
  $("#newUnitBtn")?.addEventListener("click", openNewUnitModal);
  $("#profilePasswordForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const current_password = $("#profileCurrentPassword")?.value || "";
    const new_password = $("#profileNewPassword")?.value || "";
    const confirm_password = $("#profileConfirmPassword")?.value || "";

    if (!current_password) {
      toast("Informe sua senha atual.", "error");
      return;
    }

    if (new_password.length < 8) {
      toast("A nova senha deve ter no mínimo 8 caracteres.", "error");
      return;
    }

    if (new_password !== confirm_password) {
      toast("A confirmação da nova senha não confere.", "error");
      return;
    }

    try {
      await api("/usuarios/me/senha", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password,
          new_password
        })
      });

      e.currentTarget.reset();
      toast("Senha alterada com sucesso.", "success");
    } catch (error) {
      toast(error.message || "Não foi possível alterar a senha.", "error");
    }
  });

  $("#changeProfilePhotoBtn")?.addEventListener("click", openProfilePhotoModal);
  $("#changeProfilePhotoBtnSecondary")?.addEventListener("click", openProfilePhotoModal);

  $("#removeProfilePhotoBtn")?.addEventListener("click", async () => {
    if (!window.confirm("Remover sua foto de perfil?")) return;

    try {
      await api("/usuarios/me/foto", { method: "DELETE" });
      await refreshCurrentProfilePhoto();
      toast("Foto de perfil removida.", "success");
    } catch (e) {
      toast(e.message || "Erro ao remover foto.", "error");
    }
  });

  if (state.currentPage === "profile") {
    renderCurrentUserAvatars();
  }
  $$("[data-edit-user-id]:not([data-v5])").forEach(btn => btn.addEventListener("click", () => openEditUserModal(Number(btn.dataset.editUserId))));
}


async function abrirDocumento(documentId) {
  let novaAba = null;

  try {
    // Abre a aba imediatamente, ainda dentro do clique do usuário.
    // Isso evita bloqueio de pop-up após o await/fetch.
    novaAba = window.open("", "_blank");

    if (!novaAba) {
      throw new Error("O navegador bloqueou a nova aba. Permita pop-ups para este site.");
    }

    novaAba.document.write(`
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <title>Carregando documento...</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 32px;
              color: #243047;
            }
          </style>
        </head>
        <body>
          <p>Carregando documento...</p>
        </body>
      </html>
    `);

    const token = getToken();

    if (!token) {
      throw new Error("Sua sessão expirou. Entre novamente no sistema.");
    }

    const response = await fetch(`/documentos/${documentId}/download`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      let mensagem = `Não foi possível abrir o documento (HTTP ${response.status}).`;

      try {
        const erro = await response.json();
        mensagem = erro.detail || mensagem;
      } catch (_) {}

      throw new Error(mensagem);
    }

    const blob = await response.blob();

    if (!blob.size) {
      throw new Error("O documento retornado está vazio.");
    }

    const pdfBlob = new Blob([blob], { type: "application/pdf" });
    const url = URL.createObjectURL(pdfBlob);

    novaAba.location.href = url;

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 120000);

  } catch (error) {
    console.error("Erro ao abrir PDF:", error);

    if (novaAba && !novaAba.closed) {
      novaAba.document.body.innerHTML = `
        <p style="font-family:Arial,sans-serif;padding:24px;color:#b42318;">
          ${String(error.message || "Erro ao abrir o documento.")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}
        </p>
      `;
    }

    toast(error.message || "Erro ao abrir o documento.", "error");
  }
}


function openEditRequestModal(unit) {
  openModal({
    title: "Solicitar edição do fechamento",
    content: `
      <div class="notice notice--warning">
        O fechamento continuará bloqueado até que o RH autorize a alteração.
      </div>
      <label class="field" style="margin-top:14px">
        <span>Motivo da solicitação</span>
        <textarea id="editRequestReason" maxlength="1000" placeholder="Explique o que precisa ser corrigido."></textarea>
      </label>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="sendEditRequestBtn">Enviar solicitação</button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  $("#sendEditRequestBtn")?.addEventListener("click", async () => {
    const reason = $("#editRequestReason").value.trim();

    if (reason.length < 5) {
      toast("Informe o motivo da solicitação.", "error");
      return;
    }

    try {
      await api(`/fechamentos/${unit.fechamentoId}/solicitar-edicao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });

      closeModal();
      toast("Solicitação enviada ao RH.", "success");
      await carregarDados();
      navigate("point");
    } catch (e) {
      toast(e.message || "Erro ao enviar solicitação.", "error");
    }
  });
}


function openEditRequestDecisionModal(requestId, decision) {
  const approved = decision === "approved";

  openModal({
    title: approved ? "Autorizar edição" : "Negar solicitação",
    content: `
      <div class="notice ${approved ? "notice--info" : "notice--warning"}">
        ${approved
          ? "Ao autorizar, o fechamento será liberado para correção pelo coordenador."
          : "O fechamento permanecerá bloqueado para o coordenador."}
      </div>
      <label class="field" style="margin-top:14px">
        <span>Observação ${approved ? "(opcional)" : "(opcional)"}</span>
        <textarea id="editDecisionNote" maxlength="1000" placeholder="Registre uma observação, se necessário."></textarea>
      </label>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn ${approved ? "btn--success" : "btn--danger"}" id="confirmEditRequestDecision">
        ${approved ? "Autorizar edição" : "Negar solicitação"}
      </button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  $("#confirmEditRequestDecision")?.addEventListener("click", async () => {
    try {
      await api(`/solicitacoes-edicao/${requestId}/decisao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: $("#editDecisionNote").value.trim() || null
        })
      });

      closeModal();
      toast(
        approved ? "Edição autorizada." : "Solicitação negada.",
        "success"
      );
      await carregarDados();
      navigate("approvals");
    } catch (e) {
      toast(e.message || "Erro ao decidir solicitação.", "error");
    }
  });
}


function openLinkUserModal(userId) {
  const user = state.users.find(u => u.id === Number(userId));
  if (!user) return;

  openModal({
    title: "Vincular coordenador",
    content: `
      <div class="edit-user-head">
        <div class="avatar">${initials(user.nome)}</div>
        <div>
          <strong>${escapeHtml(user.nome)}</strong>
          <span>Selecione a unidade de saúde</span>
        </div>
      </div>
      <label class="field">
        <span>Unidade</span>
        <select id="linkUserUnit">
          <option value="">Selecione...</option>
          ${state.units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("")}
        </select>
      </label>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="confirmLinkUser">Vincular</button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  $("#confirmLinkUser")?.addEventListener("click", async () => {
    const unit_id = Number($("#linkUserUnit").value);

    if (!unit_id) {
      toast("Selecione uma unidade.", "error");
      return;
    }

    try {
      await api(`/usuarios/${userId}/vincular-unidade`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_id })
      });

      closeModal();
      toast("Coordenador vinculado à unidade.", "success");
      await carregarDados();
      navigate("users");
    } catch (e) {
      toast(e.message || "Erro ao vincular coordenador.", "error");
    }
  });
}



function openProfilePhotoModal() {
  let selectedFile = null;
  let previewUrl = null;

  openModal({
    title: "Alterar foto de perfil",
    content: `
      <div class="profile-photo-modal">
        <div class="profile-photo-preview" id="profilePhotoPreview">
          ${currentProfilePhotoUrl
            ? `<img src="${currentProfilePhotoUrl}" alt="Foto atual">`
            : `<span>${state.user.initials}</span>`}
        </div>

        <div class="profile-photo-modal__copy">
          <strong>Escolha uma nova foto</strong>
          <p>JPG, PNG ou WEBP. Tamanho máximo de 2 MB.</p>
        </div>

        <label class="btn btn--outline profile-file-button">
          Selecionar imagem
          <input
            type="file"
            id="profilePhotoInput"
            accept="image/jpeg,image/png,image/webp"
            hidden
          >
        </label>

        <div class="profile-selected-file" id="profileSelectedFile">
          Nenhuma imagem selecionada.
        </div>
      </div>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="saveProfilePhotoBtn" disabled>Salvar foto</button>
    `
  });

  const cleanup = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  };

  $("[data-cancel]")?.addEventListener("click", () => {
    cleanup();
    closeModal();
  });

  $("#profilePhotoInput")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];

    if (!file) return;

    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.type)) {
      toast("Use uma imagem JPG, PNG ou WEBP.", "error");
      event.target.value = "";
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast("A foto deve ter no máximo 2 MB.", "error");
      event.target.value = "";
      return;
    }

    selectedFile = file;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);

    $("#profilePhotoPreview").innerHTML =
      `<img src="${previewUrl}" alt="Prévia da nova foto">`;

    $("#profileSelectedFile").textContent =
      `${file.name} • ${(file.size / 1024).toFixed(0)} KB`;

    $("#saveProfilePhotoBtn").disabled = false;
  });

  $("#saveProfilePhotoBtn")?.addEventListener("click", async () => {
    if (!selectedFile) return;

    const button = $("#saveProfilePhotoBtn");
    button.disabled = true;
    button.textContent = "Salvando...";

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      await api("/usuarios/me/foto", {
        method: "POST",
        body: formData
      });

      cleanup();
      closeModal();

      await refreshCurrentProfilePhoto();
      renderCurrentUserAvatars();

      toast("Foto de perfil atualizada.", "success");

    } catch (e) {
      button.disabled = false;
      button.textContent = "Salvar foto";
      toast(e.message || "Erro ao atualizar foto.", "error");
    }
  });
}


function openNewUserModal() {
  openModal({
    title: "Novo usuário",
    content: `
      <div class="grid grid--2">
        <label class="field" style="margin-top:0"><span>Nome completo <b>*</b></span><input id="mName" /></label>
        <label class="field" style="margin-top:0"><span>E-mail <b>*</b></span><input id="mEmail" type="email" /></label>\n        <label class="field"><span>Senha inicial <b>*</b></span><input id="mPassword" type="password" minlength="8" /></label>
        <label class="field"><span>Perfil <b>*</b></span>
          <select id="mRole">
            <option value="">Selecione...</option>
            <option>Administrador</option>
            <option>RH</option>
            <option>Coordenador</option>
          </select>
        </label>
        <label class="field"><span>Unidade / Escopo <b>*</b></span>
          <select id="mUnit">
            <option value="">Selecione...</option>
            <option>Secretaria Municipal de Saúde</option>
            ${state.units.map(u => `<option>${u.name}</option>`).join("")}
          </select>
        </label>
      </div>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="saveUserBtn">Salvar usuário</button>
    `
  });
  $("[data-cancel]")?.addEventListener("click", closeModal);
  $("#saveUserBtn")?.addEventListener("click", async () => {
    const name = $("#mName").value.trim();
    const email = $("#mEmail").value.trim();
    const password = $("#mPassword").value;
    const roleLabel = $("#mRole").value;
    const unitName = $("#mUnit").value;

    if (!name || !email || !password || !roleLabel || !unitName) {
      toast("Preencha todos os campos obrigatórios.", "error");
      return;
    }

    const perfil =
      roleLabel === "Administrador" ? "admin" :
      roleLabel === "RH" ? "rh" : "coordinator";

    const selectedUnit = state.units.find(u => u.name === unitName);
    const unit_id = perfil === "coordinator" ? selectedUnit?.id : null;

    if (perfil === "coordinator" && !unit_id) {
      toast("Selecione uma unidade válida para o coordenador.", "error");
      return;
    }

    try {
      await api("/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, perfil, unit_id })
      });

      closeModal();
      toast("Usuário cadastrado.", "success");
      await carregarDados();
      navigate("users");
    } catch (e) {
      toast(e.message || "Erro ao cadastrar usuário.", "error");
    }
  });
}

function openEditUserModal(userId) {
  const u = state.users.find(user => user.id === Number(userId));
  if (!u) return;

  openModal({
    title: "Editar usuário",
    content: `
      <div class="edit-user-head">
        <div class="avatar">${initials(u.nome)}</div>
        <div>
          <strong>${escapeHtml(u.nome)}</strong>
          <span>${escapeHtml(u.email)}</span>
        </div>
      </div>

      <div class="grid grid--2">
        <label class="field" style="margin-top:0"><span>Perfil</span>
          <select id="editRole">
            ${["Administrador","RH","Coordenador"].map(r => `<option ${u.perfil === r ? "selected" : ""}>${r}</option>`).join("")}
          </select>
        </label>

        <label class="field" style="margin-top:0"><span>Unidade / Escopo</span>
          <select id="editUnit">
            <option value="">Secretaria Municipal de Saúde</option>
            ${state.units.map(x => `<option value="${x.id}" ${u.unit_id === x.id ? "selected" : ""}>${x.name}</option>`).join("")}
          </select>
        </label>
      </div>

      <div class="separator"></div>

      <div class="password-reset-box">
        <div>
          <strong>Redefinir senha</strong>
          <span>Deixe em branco para manter a senha atual.</span>
        </div>
        <input id="editPassword" type="password" minlength="8" placeholder="Nova senha (mín. 8 caracteres)" />
      </div>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="saveEditUser">Salvar alterações</button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  const syncUnitField = () => {
    const coordinator = $("#editRole").value === "Coordenador";
    $("#editUnit").disabled = !coordinator;
    if (!coordinator) $("#editUnit").value = "";
  };

  $("#editRole")?.addEventListener("change", syncUnitField);
  syncUnitField();

  $("#saveEditUser")?.addEventListener("click", async () => {
    const roleLabel = $("#editRole").value;
    const perfil =
      roleLabel === "Administrador" ? "admin" :
      roleLabel === "RH" ? "rh" : "coordinator";

    const unit_id = perfil === "coordinator" ? Number($("#editUnit").value) || null : null;
    const password = $("#editPassword").value;

    if (perfil === "coordinator" && !unit_id) {
      toast("Selecione a unidade do coordenador.", "error");
      return;
    }

    if (password && password.length < 8) {
      toast("A nova senha deve ter pelo menos 8 caracteres.", "error");
      return;
    }

    try {
      await api(`/usuarios/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ perfil, unit_id })
      });

      if (password) {
        await api(`/usuarios/${u.id}/senha`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
      }

      closeModal();
      toast("Usuário atualizado.", "success");
      await carregarDados();
      navigate("users");
    } catch (e) {
      toast(e.message || "Erro ao atualizar usuário.", "error");
    }
  });
}

function openChangeMyPasswordModal() {
  openModal({
    title: "Alterar senha",
    content: `
      <label class="field" style="margin-top:0">
        <span>Senha atual</span>
        <input id="currentPassword" type="password" autocomplete="current-password" />
      </label>
      <label class="field">
        <span>Nova senha</span>
        <input id="newPassword" type="password" minlength="8" autocomplete="new-password" />
      </label>
      <label class="field">
        <span>Confirmar nova senha</span>
        <input id="confirmPassword" type="password" minlength="8" autocomplete="new-password" />
      </label>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="saveMyPasswordBtn">Atualizar senha</button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  $("#saveMyPasswordBtn")?.addEventListener("click", async () => {
    const current_password = $("#currentPassword").value;
    const new_password = $("#newPassword").value;
    const confirm = $("#confirmPassword").value;

    if (!current_password || !new_password || !confirm) {
      toast("Preencha os três campos.", "error");
      return;
    }

    if (new_password.length < 8) {
      toast("A nova senha deve ter pelo menos 8 caracteres.", "error");
      return;
    }

    if (new_password !== confirm) {
      toast("A confirmação da senha não confere.", "error");
      return;
    }

    try {
      await api("/usuarios/me/senha", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password, new_password })
      });

      closeModal();
      toast("Senha alterada com sucesso.", "success");
    } catch (e) {
      toast(e.message || "Erro ao alterar senha.", "error");
    }
  });
}

function openNewUnitModal() {
  openModal({
    title: "Nova unidade",
    content: `
      <label class="field" style="margin-top:0">
        <span>Nome da unidade <b>*</b></span>
        <input id="unitName" placeholder="Ex.: USF ..." />
      </label>
    `,
    actions: `
      <button class="btn btn--outline" data-cancel>Cancelar</button>
      <button class="btn btn--primary" id="saveUnitBtn">Salvar unidade</button>
    `
  });

  $("[data-cancel]")?.addEventListener("click", closeModal);

  $("#saveUnitBtn")?.addEventListener("click", async () => {
    const name = $("#unitName").value.trim();

    if (!name) {
      toast("Informe o nome da unidade.", "error");
      return;
    }

    try {
      await api("/units", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });

      closeModal();
      toast("Unidade cadastrada.", "success");
      await carregarDados();
      navigate("units");
    } catch (e) {
      toast(e.message || "Erro ao cadastrar unidade.", "error");
    }
  });
}

function signatureLabel(method) {
  return {
    govbr: "Gov.br",
    certificado: "Certificado digital",
    manual: "Assinatura manual digitalizada",
    outro: "Outro meio autorizado"
  }[method] || "Não informado";
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadPersisted();

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();

  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;

  if (!email || !password) {
    toast("Informe e-mail e senha.", "error");
    return;
  }

  const submitBtn = $(".login-submit");
  if (submitBtn.disabled) return;
  const originalHtml = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = "<span>…</span> ENTRANDO...";

  try {
    const userData = await fazerLogin(email, password);
    await setLoginFromUser(userData);
  } catch (e) {
    console.error(e);
    toast(e.message || "Não foi possível entrar.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalHtml;
  }
});

$$(".demo-user").forEach(btn => {
  btn.style.display = "none";
});

(async function restaurarSessao() {
  const token = getToken();
  const rawUser = localStorage.getItem(USER_KEY);

  if (!token || !rawUser) return;

  try {
    const userData = JSON.parse(rawUser);
    await setLoginFromUser(userData);
  } catch (e) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
})();

$("#togglePassword").addEventListener("click", () => {
  const p = $("#loginPassword");
  p.type = p.type === "password" ? "text" : "password";
});

$("#forgotPasswordLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  toast("Solicite a redefinição de senha ao Administrador ou RH.", "");
});

$("#logoutBtn").addEventListener("click", logout);

bindNotifications();
$("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));