"""Senhas, tokens de acesso e busca de usuário por e-mail."""

import hashlib
import logging
from datetime import datetime, timedelta, timezone

from jose import jwt
from passlib.context import CryptContext
from sqlalchemy import func
from sqlalchemy.orm import Session

from config import ACCESS_TOKEN_EXPIRE_MINUTES, ALGORITHM, SECRET_KEY
from models import Users

# O passlib 1.7.4 tenta ler bcrypt.__about__ (removido no bcrypt 4.x) e loga um
# traceback inofensivo; o hash funciona normalmente. Só silencia esse aviso.
logging.getLogger("passlib.handlers.bcrypt").setLevel(logging.ERROR)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Hash descartável usado para gastar o mesmo tempo de CPU quando o e-mail não
# existe, evitando que o tempo de resposta revele quais e-mails têm conta.
_HASH_FALSO = pwd_context.hash("senha-falsa-para-igualar-tempo")


def normalizar_email(email: str) -> str:
    return email.strip().lower()


def buscar_usuario_por_email(db: Session, email: str) -> Users | None:
    return (
        db.query(Users)
        .filter(func.lower(Users.email) == normalizar_email(email))
        .first()
    )


def verificar_senha(senha: str, hash_passwd: str | None) -> bool:
    if hash_passwd is None:
        pwd_context.verify(senha, _HASH_FALSO)
        return False
    return pwd_context.verify(senha, hash_passwd)


def senha_fingerprint(hash_passwd: str) -> str:
    """Impressão digital curta do hash da senha atual.

    Vai dentro do JWT: trocar/redefinir a senha muda o hash e, com isso,
    invalida todos os tokens emitidos antes da troca.
    """
    return hashlib.sha256(hash_passwd.encode("utf-8")).hexdigest()[:16]


def criar_access_token(user: Users) -> str:
    expira_em = datetime.now(timezone.utc) + timedelta(
        minutes=ACCESS_TOKEN_EXPIRE_MINUTES
    )

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "perfil": user.perfil,
        "pv": senha_fingerprint(user.hash_passwd),
        "exp": expira_em,
    }

    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
