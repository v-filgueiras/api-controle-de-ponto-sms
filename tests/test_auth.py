from conftest import SENHA, criar_usuario, login
from rate_limit import JanelaDeslizante


def test_login_ignora_maiusculas_no_email(client, db):
    criar_usuario(db, "Maria@Exemplo.com", "rh")
    resp = client.post(
        "/auth/login", data={"username": "maria@exemplo.com", "password": SENHA}
    )
    assert resp.status_code == 200


def test_login_senha_errada(client, db):
    criar_usuario(db, "a@exemplo.com", "rh")
    resp = client.post("/auth/login", data={"username": "a@exemplo.com", "password": "x" * 10})
    assert resp.status_code == 401


def test_cadastro_pendente_nao_loga(client, db):
    criar_usuario(db, "novo@exemplo.com", "coordinator", aprovado=False)
    resp = client.post(
        "/auth/login", data={"username": "novo@exemplo.com", "password": SENHA}
    )
    assert resp.status_code == 403


def test_registrar_normaliza_email_e_barra_duplicado(client):
    dados = {"name": "Fulano", "email": "Fulano@Exemplo.com", "password": SENHA}
    assert client.post("/auth/registrar", json=dados).status_code == 201
    dados["email"] = "fulano@exemplo.com"
    assert client.post("/auth/registrar", json=dados).status_code == 409


def test_bootstrap_exige_token(client):
    dados = {"name": "Admin", "email": "admin@exemplo.com", "password": SENHA}
    r = client.post("/auth/bootstrap-admin", json={**dados, "bootstrap_token": "errado"})
    assert r.status_code == 403
    r = client.post(
        "/auth/bootstrap-admin", json={**dados, "bootstrap_token": "token-bootstrap-teste"}
    )
    assert r.status_code == 201


def test_bootstrap_bloqueado_com_usuarios(client, db):
    criar_usuario(db, "a@exemplo.com", "admin")
    r = client.post(
        "/auth/bootstrap-admin",
        json={
            "name": "X", "email": "x@exemplo.com", "password": SENHA,
            "bootstrap_token": "token-bootstrap-teste",
        },
    )
    assert r.status_code == 409


def test_trocar_senha_invalida_token_antigo(client, db):
    criar_usuario(db, "a@exemplo.com", "rh")
    antigo = login(client, "a@exemplo.com")

    r = client.put(
        "/usuarios/me/senha",
        headers=antigo,
        json={"current_password": SENHA, "new_password": "outra-senha-123"},
    )
    assert r.status_code == 200
    novo = {"Authorization": f"Bearer {r.json()['access_token']}"}

    assert client.get("/usuarios", headers=antigo).status_code == 401
    assert client.get("/usuarios", headers=novo).status_code == 200


def test_redefinir_senha_por_token(client, db):
    from datetime import datetime, timedelta

    from models import PasswordResetTokens
    from routes.auth_extra import _hash_token

    user = criar_usuario(db, "a@exemplo.com", "rh")
    sessao_antiga = login(client, "a@exemplo.com")

    db.add(PasswordResetTokens(
        user_id=user.id,
        token_hash=_hash_token("token-de-teste-123"),
        expires_at=datetime.now() + timedelta(hours=1),
    ))
    db.commit()

    r = client.post(
        "/auth/redefinir-senha",
        json={"token": "token-de-teste-123", "new_password": "nova-senha-123"},
    )
    assert r.status_code == 200
    # o mesmo link não funciona duas vezes
    r = client.post(
        "/auth/redefinir-senha",
        json={"token": "token-de-teste-123", "new_password": "nova-senha-456"},
    )
    assert r.status_code == 400

    assert client.get("/usuarios", headers=sessao_antiga).status_code == 401
    login(client, "a@exemplo.com", "nova-senha-123")


def test_janela_deslizante_bloqueia_apos_o_limite():
    janela = JanelaDeslizante(maximo=3, janela_segundos=60)
    for _ in range(3):
        assert not janela.bloqueado("ip")
        janela.registrar("ip")
    assert janela.bloqueado("ip")
    assert not janela.bloqueado("outro-ip")
    janela.limpar("ip")
    assert not janela.bloqueado("ip")


def test_login_bloqueia_apos_falhas(client, db, monkeypatch):
    import routes.auth as auth_routes

    monkeypatch.setattr(auth_routes, "RATE_LIMIT_ENABLED", True)
    auth_routes.falhas_de_login.limpar("testclient|a@exemplo.com")
    criar_usuario(db, "a@exemplo.com", "rh")

    for _ in range(5):
        r = client.post("/auth/login", data={"username": "a@exemplo.com", "password": "errada-123"})
        assert r.status_code == 401
    # a 6ª tentativa é barrada mesmo com a senha certa
    r = client.post("/auth/login", data={"username": "a@exemplo.com", "password": SENHA})
    assert r.status_code == 429
    auth_routes.falhas_de_login.limpar("testclient|a@exemplo.com")
