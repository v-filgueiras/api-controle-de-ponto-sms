from conftest import SENHA, login


def test_admin_cria_usuario_com_email_normalizado(client, cenario):
    admin = login(client, cenario["admin"])
    r = client.post(
        "/usuarios", headers=admin,
        json={"name": "Novo RH", "email": "Novo.RH@Exemplo.com", "password": SENHA, "perfil": "rh"},
    )
    assert r.status_code == 201
    assert r.json()["email"] == "novo.rh@exemplo.com"

    r = client.post(
        "/usuarios", headers=admin,
        json={"name": "Dup", "email": "NOVO.rh@exemplo.com", "password": SENHA, "perfil": "rh"},
    )
    assert r.status_code == 409


def test_coordenador_nao_lista_usuarios(client, cenario):
    coord = login(client, cenario["coord1"])
    assert client.get("/usuarios", headers=coord).status_code == 403


def test_rh_aprova_cadastro_pendente(client, cenario):
    client.post("/auth/registrar", json={"name": "Novo", "email": "novo@exemplo.com", "password": SENHA})
    rh = login(client, cenario["rh"])
    pendentes = client.get("/usuarios/pendentes", headers=rh).json()
    assert [u["email"] for u in pendentes] == ["novo@exemplo.com"]

    uid = pendentes[0]["id"]
    assert client.patch(f"/usuarios/{uid}/aprovar", headers=rh).status_code == 200
    login(client, "novo@exemplo.com")
