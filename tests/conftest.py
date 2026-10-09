import os
import tempfile

# As variáveis precisam existir ANTES de importar a aplicação.
_tmp = tempfile.mkdtemp(prefix="ponto-tests-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["SECRET_KEY"] = "chave-de-teste"
os.environ["UPLOAD_DIR"] = f"{_tmp}/uploads"
os.environ["BOOTSTRAP_TOKEN"] = "token-bootstrap-teste"
os.environ["EMAIL_CHECK_DELIVERABILITY"] = "false"
os.environ["RATE_LIMIT_ENABLED"] = "false"
os.environ["CORS_ORIGINS"] = "http://localhost:5500"

import pytest
from fastapi.testclient import TestClient

from database.connect import Base, SessionLocal, engine
from main import app
from models import Units, Users
from security import pwd_context

SENHA = "senha-segura-123"


@pytest.fixture(autouse=True)
def banco_limpo():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def db():
    sessao = SessionLocal()
    try:
        yield sessao
    finally:
        sessao.close()


def criar_usuario(db, email, perfil, unit_id=None, aprovado=True, ativo=True):
    user = Users(
        name=email.split("@")[0],
        email=email,
        hash_passwd=pwd_context.hash(SENHA),
        perfil=perfil,
        unit_id=unit_id,
        status=ativo,
        approval_status="aprovado" if aprovado else "pendente",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def login(client, email, senha=SENHA):
    resp = client.post("/auth/login", data={"username": email, "password": senha})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
def cenario(db):
    """Duas unidades, um coordenador em cada, um RH e um admin."""
    u1 = Units(name="UBS Centro")
    u2 = Units(name="UBS Norte")
    db.add_all([u1, u2])
    db.commit()
    return {
        "u1": u1.id,
        "u2": u2.id,
        "coord1": criar_usuario(db, "coord1@exemplo.com", "coordinator", u1.id).email,
        "coord2": criar_usuario(db, "coord2@exemplo.com", "coordinator", u2.id).email,
        "rh": criar_usuario(db, "rh@exemplo.com", "rh").email,
        "admin": criar_usuario(db, "admin@exemplo.com", "admin").email,
    }
