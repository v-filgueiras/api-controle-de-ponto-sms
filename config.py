"""Configuração central lida das variáveis de ambiente (.env)."""

import os

from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY não configurada. Defina a variável de ambiente SECRET_KEY "
        "antes de iniciar o sistema (nunca use um valor padrão em produção)."
    )

ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "480"))

# Token exigido por /auth/bootstrap-admin. Sem ele, a criação do primeiro
# administrador fica desativada (evita que o primeiro visitante vire admin).
BOOTSTRAP_TOKEN = os.getenv("BOOTSTRAP_TOKEN", "")

# Origens permitidas no CORS, separadas por vírgula.
CORS_ORIGINS = [
    origem.strip()
    for origem in os.getenv(
        "CORS_ORIGINS", "http://127.0.0.1:5500,http://localhost:5500"
    ).split(",")
    if origem.strip()
]

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")

# "enforce" | "report-only" | "off"
CSP_MODE = os.getenv("CSP_MODE", "report-only").lower()

RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() != "false"

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]
