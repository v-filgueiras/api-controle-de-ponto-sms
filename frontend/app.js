
const API_URL = "";
const TOKEN_KEY = "sms-ponto-token";
const USER_KEY = "sms-ponto-user";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
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
    unidade: unit?.name || "Secretaria Municipal de Saúde",
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
    rows: f.rows || []
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

  if (state.role === "admin" || state.role === "rh") {
    try {
      const usuarios = await api("/usuarios");
      state.users = usuarios.map(mapUser);
      state.units.forEach(unit => {
        const coord = state.users.find(u => u.perfilRaw === "coordinator" && u.unit_id === unit.id);
        if (coord) unit.coordinator = coord.nome;
      });
    } catch (e) {
      console.warn("Não foi possível carregar usuários:", e);
    }

    try {
      const aprovacoes = await api("/aprovacoes");
      aprovacoes.forEach(f => {
        const unitIndex = state.units.findIndex(u => u.id === f.unit_id);
        if (unitIndex >= 0) {
          state.units[unitIndex] = mapFechamento(f, state.units[unitIndex]);
        }
      });
    } catch (e) {
      console.warn("Não foi possível carregar aprovações:", e);
    }
  }

  if (state.role === "rh") {
    try {
      state.rhDashboard = await api("/dashboard/rh");
    } catch (e) {
      console.warn("Não foi possível carregar o dashboard do RH:", e);
      state.rhDashboard = null;
    }
  }

  if (state.role === "coordinator" && state.user?.unit_id) {
    const f = await api(`/unidades/${state.user.unit_id}/fechamento-atual`);
    const unitIndex = state.units.findIndex(u => u.id === state.user.unit_id);
    if (unitIndex >= 0) {
      state.units[unitIndex].coordinator = state.user.user;
      state.units[unitIndex] = mapFechamento(f, state.units[unitIndex]);
    }
  }

  try {
    const historico = await api("/historico");
    state.historyLog = historico.map(h => ({
      date: new Date(h.timestamp).toLocaleString("pt-BR"),
      user: `Usuário #${h.user_id}`,
      action: h.action,
      unit: state.units.find(u => u.id === h.unit_id)?.name || "—",
      competence: state.units.find(u => u.id === h.unit_id)?.competence || "—",
      status: h.status_snapshot || "info"
    }));
  } catch (e) {
    console.warn("Histórico não carregado:", e);
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
  return state.units.find(u => u.coordinator === state.user?.user) || state.units[0];
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
      ["units", "⌘", "Unidades"],
      ["history", "↺", "Histórico"],
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
  $("#sidebarAvatar").textContent = state.user.initials;
  $("#topAvatar").textContent = state.user.initials;

  renderNav();

  try {
    await carregarDados();
    navigate("dashboard");
  } catch (e) {
    console.error(e);
    toast(e.message || "Erro ao carregar dados do sistema.", "error");
  }
}

function logout() {
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
    </button>
  `).join("");

  $$("#mainNav button").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.page)));
}

function navigate(page, params = {}) {
  state.currentPage = page;
  $$("#mainNav button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  $("#sidebar").classList.remove("open");

  const titles = {
    dashboard: ["Visão geral", "Painel"],
    point: ["Fechamento", "Fechamento de ponto"],
    approvals: ["Fluxo de aprovação", "Aprovações"],
    units: ["Estrutura", "Unidades"],
    history: ["Registros", state.role === "admin" ? "Auditoria" : "Histórico"],
    users: ["Administração", "Usuários e hierarquia"],
    profile: ["Conta", "Meu perfil"],
    review: ["Aprovações", "Analisar fechamento"]
  };

  $("#breadcrumb").textContent = titles[page]?.[0] || "Sistema";
  $("#pageTitle").textContent = titles[page]?.[1] || "Controle de Ponto";

  if (page === "point" && state.role === "coordinator") {
    const unit = myUnit();
    state.pointRows = unit.rows;
    state.uploadedFile = unit.document;
    state.signatureMethod = unit.signatureMethod || "";
  }

  const content = $("#content");
  if (page === "dashboard") content.innerHTML = dashboardView();
  if (page === "point") content.innerHTML = pointView();
  if (page === "approvals") content.innerHTML = approvalsView();
  if (page === "units") content.innerHTML = unitsView();
  if (page === "history") content.innerHTML = historyView();
  if (page === "users") content.innerHTML = usersView();
  if (page === "profile") content.innerHTML = profileView();
  if (page === "review") content.innerHTML = reviewView(params.unitId || 2);

  bindCurrentPage();
}

function coordinatorDashboard() {
  const unit = myUnit();
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
        <p>Gerencie perfis, vínculos entre coordenadores e unidades e a estrutura de acesso.</p>
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
            <button class="btn btn--outline btn--block" style="margin-top:10px" id="openDocBtn">Visualizar documento</button>
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

function unitsView() {
  return `
    <div class="page-intro">
      <div>
        <h1>Unidades</h1>
        <p>Visão consolidada das unidades, coordenadores vinculados e situação do fechamento.</p>
      </div>
      ${state.role === "admin" ? `<div class="actions"><button class="btn btn--primary" id="newUnitBtn">+ Nova unidade</button></div>` : ""}
    </div>

    <div class="card">
      <div class="section-head">
        <div>
          <h3>Unidades cadastradas</h3>
          <p>${state.units.length} unidade(s)</p>
        </div>
      </div>
      ${unitsTable(state.role === "rh")}
    </div>
  `;
}

function unitsTable(showReview) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Unidade</th><th>Coordenador</th><th>Servidores</th><th>Competência</th><th>Status</th>${showReview ? "<th></th>" : ""}</tr>
        </thead>
        <tbody>
          ${state.units.map(u => `
            <tr>
              <td><strong>${u.name}</strong></td>
              <td>${u.coordinator}</td>
              <td>${u.rows.length}</td>
              <td>${u.competence}</td>
              <td>${badge(u.status)}</td>
              ${showReview ? `<td>${["pendente","correcao","rejeitado","aprovado"].includes(u.status) ? `<button class="table-action" data-review="${u.id}">Abrir</button>` : ""}</td>` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function usersView() {
  return `
    <div class="page-intro">
      <div>
        <h1>Usuários e hierarquia</h1>
        <p>Cadastre usuários, defina perfis de acesso e vincule coordenadores às respectivas unidades.</p>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="newUserBtn">+ Novo usuário</button>
      </div>
    </div>

    <div class="grid grid--3" style="margin-bottom:16px">
      <div class="card card-pad">
        <span class="role-chip">NÍVEL 1</span>
        <h3 style="margin-bottom:6px">Administrador</h3>
        <p class="muted" style="font-size:12px">Gerencia estrutura, perfis e permissões.</p>
      </div>
      <div class="card card-pad">
        <span class="role-chip">NÍVEL 2</span>
        <h3 style="margin-bottom:6px">RH</h3>
        <p class="muted" style="font-size:12px">Visualiza todas as unidades e decide aprovações.</p>
      </div>
      <div class="card card-pad">
        <span class="role-chip">NÍVEL 3</span>
        <h3 style="margin-bottom:6px">Coordenador</h3>
        <p class="muted" style="font-size:12px">Acessa apenas as unidades vinculadas ao próprio usuário.</p>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <div><h3>Usuários cadastrados</h3><p>${state.users.length} usuário(s)</p></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Unidade / Escopo</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            ${state.users.map((u,i) => `
              <tr>
                <td><strong>${u.nome}</strong></td>
                <td>${u.email}</td>
                <td><span class="role-chip">${u.perfil}</span></td>
                <td>${u.unidade}</td>
                <td><span class="badge badge--success">${u.status}</span></td>
                <td><button class="table-action" data-edit-user="${i}">Editar</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function historyView() {
  const title = state.role === "admin" ? "Auditoria do sistema" : "Histórico de fechamentos";
  const desc = state.role === "admin"
    ? "Registro resumido das ações administrativas e decisões."
    : "Consulte os fechamentos anteriores e seus respectivos status.";

  return `
    <div class="page-intro">
      <div><h1>${title}</h1><p>${desc}</p></div>
      <div class="actions"><button class="btn btn--outline">Exportar CSV</button></div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Unidade</th><th>Competência</th><th>Resultado</th></tr>
          </thead>
          <tbody>
            ${state.historyLog.map(h => `
              <tr>
                <td>${h.date}</td><td>${escapeHtml(h.user)}</td><td>${escapeHtml(h.action)}</td>
                <td>${escapeHtml(h.unit)}</td><td>${escapeHtml(h.competence)}</td>
                <td>${statusMeta[h.status] ? badge(h.status) : `<span class="badge badge--info">Registrado</span>`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function profileView() {
  return `
    <div class="page-intro">
      <div><h1>Meu perfil</h1><p>Informações de acesso ao sistema.</p></div>
    </div>
    <div class="grid grid--2">
      <div class="card card-pad">
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:18px">
          <div class="avatar" style="width:52px;height:52px">${state.user.initials}</div>
          <div>
            <strong>${state.user.user}</strong>
            <div class="muted" style="font-size:11px;margin-top:4px">${state.user.name}</div>
          </div>
        </div>
        <div class="kv">
          <span>Perfil</span><strong>${state.user.short}</strong>
          <span>Status</span><strong>Ativo</strong>
          <span>Unidade / Escopo</span><strong>${state.role === "coordinator" ? myUnit().name : "Secretaria Municipal de Saúde"}</strong>
        </div>
      </div>
      <div class="card card-pad security-panel">
        <div class="security-panel__icon">⌁</div>
        <div>
          <span class="eyebrow">SEGURANÇA</span>
          <h3>Senha de acesso</h3>
          <p class="muted">Atualize sua senha sempre que necessário.</p>
        </div>
        <button class="btn btn--primary" id="changeMyPasswordBtn">Alterar senha</button>
      </div>
    </div>
  `;
}

function bindCurrentPage() {
  $$("[data-go]").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.go)));

  $$("[data-review]").forEach(btn => btn.addEventListener("click", () => navigate("review", { unitId: btn.dataset.review })));

  if (state.currentPage === "point") bindPointPage();

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

  $("#openDocBtn")?.addEventListener("click", async () => {
    if (!unit.document?.id) {
      toast("Nenhum documento foi anexado a este fechamento.", "error");
      return;
    }

    await abrirDocumento(unit.document.id);
  });

  $("#newUserBtn")?.addEventListener("click", openNewUserModal);
  $("#newUnitBtn")?.addEventListener("click", openNewUnitModal);
  $("#changeMyPasswordBtn")?.addEventListener("click", openChangeMyPasswordModal);
  $$("[data-edit-user]").forEach(btn => btn.addEventListener("click", () => openEditUserModal(Number(btn.dataset.editUser))));
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

function openEditUserModal(index) {
  const u = state.users[index];

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

  try {
    const userData = await fazerLogin(email, password);
    await setLoginFromUser(userData);
  } catch (e) {
    console.error(e);
    toast(e.message || "Não foi possível entrar.", "error");
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

$("#logoutBtn").addEventListener("click", logout);
$("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));