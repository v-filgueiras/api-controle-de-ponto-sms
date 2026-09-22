// 🔐 SISTEMA DE AUTENTICAÇÃO - Protege a aplicação

class AuthManager {
  constructor() {
    this.token = localStorage.getItem('token');
    this.user = JSON.parse(localStorage.getItem('user') || 'null');
  }

  // Verificar se está autenticado
  isAuthenticated() {
    return !!this.token && !!this.user;
  }

  // Guardar token após login
  saveAuth(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  }

  // Limpar tudo ao logout
  logout() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.clear();
  }

  // Obter headers com token
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  // Validar token no servidor
  async validateToken() {
    if (!this.token) return false;
    try {
      const res = await fetch('/auth/verify', {
        headers: this.getHeaders()
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  }
}

// Instância global
const auth = new AuthManager();

// 🎯 INICIALIZAR - Decidir qual tela mostrar
async function inicializarApp() {
  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');

  // Se não tem token, mostra login
  if (!auth.isAuthenticated()) {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    return;
  }

  // Se tem token, valida no servidor
  const isValid = await auth.validateToken();
  
  if (isValid) {
    // Token válido = mostra app
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    carregarDadosDoUsuario();
  } else {
    // Token inválido/expirado = volta para login
    auth.logout();
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    toast('Sessão expirada. Faça login novamente.', 'warning');
  }
}

// 🔓 FAZER LOGIN
async function fazerLogin(email, senha) {
  try {
    const formData = new FormData();
    formData.append('username', email);
    formData.append('password', senha);

    const res = await fetch('/auth/login', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const erro = await res.json();
      throw new Error(erro.detail || 'Erro ao fazer login');
    }

    const data = await res.json();
    
    // Salvar auth
    auth.saveAuth(data.access_token, data.user);
    
    // Ir para app
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    
    // Carregar dados
    carregarDadosDoUsuario();
    toast(`Bem-vindo, ${data.user.name}!`, 'success');

  } catch (err) {
    toast(err.message, 'error');
  }
}

// 🔒 FAZER LOGOUT
async function fazerLogout() {
  if (!confirm('Tem certeza que quer sair?')) return;

  auth.logout();
  
  // Voltar para login
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  
  // Limpar UI
  document.getElementById('content').innerHTML = '';
  
  toast('Você foi desconectado', 'info');
}

// 📱 CARREGAR DADOS DO USUÁRIO
function carregarDadosDoUsuario() {
  if (!auth.user) return;
  
  document.getElementById('sidebarUser').textContent = auth.user.name;
  document.getElementById('sidebarRole').textContent = auth.user.perfil;
  document.getElementById('topAvatar').textContent = auth.user.name.charAt(0);
  document.getElementById('sidebarAvatar').textContent = auth.user.name.charAt(0);
}

// 🛡️ PROTEÇÃO DE ROTAS - Interceptor de requisições
async function fetchProtegido(url, options = {}) {
  if (!auth.isAuthenticated()) {
    // Se não tem autenticação, vai para login
    document.getElementById('appView').classList.add('hidden');
    document.getElementById('loginView').classList.remove('hidden');
    throw new Error('Não autenticado');
  }

  // Adiciona token automaticamente
  const headers = {
    ...auth.getHeaders(),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  // Se receber 401, token expirou
  if (response.status === 401) {
    auth.logout();
    document.getElementById('appView').classList.add('hidden');
    document.getElementById('loginView').classList.remove('hidden');
    toast('Sessão expirada. Faça login novamente.', 'warning');
    throw new Error('Token expirado');
  }

  return response;
}

// ⏰ VERIFICAR SESSÃO A CADA 5 MINUTOS
function verificarSessao() {
  setInterval(async () => {
    if (!auth.isAuthenticated()) return;
    
    const isValid = await auth.validateToken();
    if (!isValid) {
      auth.logout();
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('loginView').classList.remove('hidden');
      toast('Sua sessão expirou', 'warning');
    }
  }, 5 * 60 * 1000); // 5 minutos
}

// 🎬 EXECUTAR NA INICIALIZAÇÃO
document.addEventListener('DOMContentLoaded', () => {
  inicializarApp();
  verificarSessao();

  // Botão de logout
  document.getElementById('logoutBtn')?.addEventListener('click', fazerLogout);

  // Proteger todos os fetch
  window.fetch_original = window.fetch;
  window.fetch = (...args) => {
    // Se for login ou bootstrap, usa fetch normal
    if (args[0].includes('/auth/login') || args[0].includes('/auth/bootstrap')) {
      return window.fetch_original(...args);
    }
    // Caso contrário, usa protegido
    return fetchProtegido(...args);
  };
});

// 📤 FAZER LOGIN (conectar com form existente)
if (document.getElementById('loginForm')) {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value;
    const senha = document.getElementById('loginPassword').value;
    const btn = e.target.querySelector('button[type="submit"]');
    
    btn.disabled = true;
    btn.textContent = 'Entrando...';
    
    await fazerLogin(email, senha);
    
    btn.disabled = false;
    btn.textContent = '→ ACESSAR SISTEMA';
  });
}