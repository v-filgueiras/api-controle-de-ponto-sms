import os
from urllib.parse import urlencode
from locust import HttpUser, task, between, events

EMAIL = os.getenv("LOCUST_EMAIL", "")
PASSWORD = os.getenv("LOCUST_PASSWORD", "")
ROLE = os.getenv("LOCUST_ROLE", "coordinator").lower().strip()


class SistemaPontoUser(HttpUser):
    wait_time = between(1, 3)

    def on_start(self):
        if not EMAIL or not PASSWORD:
            raise RuntimeError(
                "Defina LOCUST_EMAIL e LOCUST_PASSWORD antes de iniciar."
            )

        form = urlencode({"username": EMAIL, "password": PASSWORD})

        with self.client.post(
            "/auth/login",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            name="POST /auth/login",
            catch_response=True,
        ) as r:
            if r.status_code != 200:
                r.failure(f"Login falhou: HTTP {r.status_code} - {r.text[:200]}")
                return
            try:
                data = r.json()
            except Exception:
                r.failure("Login não retornou JSON.")
                return

            token = data.get("access_token")
            if not token:
                r.failure("Login não retornou access_token.")
                return

            self.token = token
            self.user = data.get("user") or {}
            self.unit_id = self.user.get("unit_id")
            r.success()

        self.headers = {"Authorization": f"Bearer {self.token}"}

    def get(self, path, name):
        return self.client.get(path, headers=self.headers, name=name)

    # ---------- Coordenador ----------
    @task(5)
    def coord_units(self):
        if ROLE == "coordinator":
            self.get("/units", "GET /units")

    @task(5)
    def coord_fechamento(self):
        if ROLE == "coordinator" and self.unit_id:
            self.get(
                f"/unidades/{self.unit_id}/fechamento-atual",
                "GET /unidades/{unit_id}/fechamento-atual",
            )

    @task(3)
    def coord_historico(self):
        if ROLE == "coordinator":
            self.get("/historico?limit=1000", "GET /historico")

    @task(3)
    def coord_mensagens(self):
        if ROLE == "coordinator":
            self.get("/mensagens/resumo", "GET /mensagens/resumo")

    # ---------- RH ----------
    @task(5)
    def rh_units(self):
        if ROLE == "rh":
            self.get("/units", "GET /units")

    @task(4)
    def rh_usuarios(self):
        if ROLE == "rh":
            self.get("/usuarios", "GET /usuarios")

    @task(5)
    def rh_aprovacoes(self):
        if ROLE == "rh":
            self.get("/aprovacoes", "GET /aprovacoes")

    @task(4)
    def rh_dashboard(self):
        if ROLE == "rh":
            self.get("/dashboard/rh", "GET /dashboard/rh")

    @task(3)
    def rh_solicitacoes(self):
        if ROLE == "rh":
            self.get(
                "/solicitacoes-edicao?status=pendente",
                "GET /solicitacoes-edicao",
            )

    @task(3)
    def rh_historico(self):
        if ROLE == "rh":
            self.get("/historico?limit=1000", "GET /historico")

    @task(3)
    def rh_mensagens(self):
        if ROLE == "rh":
            self.get("/mensagens/resumo", "GET /mensagens/resumo")

    # ---------- Administrador ----------
    @task(5)
    def admin_units(self):
        if ROLE == "admin":
            self.get("/units", "GET /units")

    @task(5)
    def admin_usuarios(self):
        if ROLE == "admin":
            self.get("/usuarios", "GET /usuarios")

    @task(4)
    def admin_aprovacoes(self):
        if ROLE == "admin":
            self.get("/aprovacoes", "GET /aprovacoes")

    @task(3)
    def admin_historico(self):
        if ROLE == "admin":
            self.get("/historico?limit=1000", "GET /historico")


@events.test_start.add_listener
def show_config(environment, **kwargs):
    print("\n=== TESTE SISTEMA DE PONTO ===")
    print("Perfil:", ROLE)
    print("E-mail configurado:", bool(EMAIL))
    print("Senha configurada:", bool(PASSWORD))
    print("==============================\n")
