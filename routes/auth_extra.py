"""Confirmação de e-mail e recuperação de senha.

Dois recursos:

1) Confirmação de e-mail: ao criar uma conta (bootstrap do primeiro admin ou
   usuário criado por um admin), o e-mail entra como "não confirmado". O
   login é bloqueado até o usuário clicar no link enviado por e-mail.
   Usuários que já existiam antes deste recurso não são afetados: sem
   registro em email_verifications, o login trata como já confirmado.

2) Esqueci minha senha: gera um token de uso único, válido por 1 hora,
   enviado por e-mail, que permite definir uma nova senha sem precisar da
   senha atual. As respostas nunca revelam se um e-mail existe ou não no
   sistema, para não permitir enumeração de contas.

Assim como mensagens.py, os modelos ficam neste arquivo para não mexer em
models.py. Como este módulo é importado pelo main.py antes do
Base.metadata.create_all(), as tabelas "email_verifications" e
"password_reset_tokens" são criadas automaticamente na próxima
inicialização.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Session

from database.connect import Base, get_db
from email_utils import enviar_email_confirmacao, enviar_email_redefinicao_senha
from models import HistoryLog, Users

logger = logging.getLogger("auth_extra")

router = APIRouter(prefix="/auth", tags=["auth"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

VERIFICACAO_VALIDADE_HORAS = 24
VERIFICACAO_REENVIO_MINIMO_SEGUNDOS = 60
RESET_SENHA_VALIDADE_MINUTOS = 60


class EmailVerifications(Base):
    __tablename__ = "email_verifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    verified = Column(Boolean, nullable=False, default=False)
    verified_at = Column(DateTime, nullable=True)
    token_hash = Column(String(64), nullable=True, index=True)
    token_expires_at = Column(DateTime, nullable=True)
    last_sent_at = Column(DateTime, nullable=True)


class PasswordResetTokens(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)


class SolicitarVerificacaoIn(BaseModel):
    email: EmailStr


class EsqueciSenhaIn(BaseModel):
    email: EmailStr


class RedefinirSenhaIn(BaseModel):
    token: str = Field(min_length=10)
    new_password: str = Field(min_length=8, max_length=128)


def _gerar_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def criar_verificacao_e_enviar(db: Session, user: Users) -> None:
    """Gera um novo token de confirmação para `user` e envia por e-mail.

    Usado tanto na criação de conta quanto no reenvio manual. O registro de
    verificação é salvo ANTES de tentar enviar o e-mail — assim, mesmo que
    o envio falhe (SMTP mal configurado, fora do ar etc.), o login do
    usuário continua bloqueado até uma confirmação de verdade acontecer.
    Falha de envio só é registrada em log (não no banco), para não haver
    risco de estourar o tamanho de nenhuma coluna.
    """
    verificacao = (
        db.query(EmailVerifications).filter(EmailVerifications.user_id == user.id).first()
    )
    if not verificacao:
        verificacao = EmailVerifications(user_id=user.id, verified=False)
        db.add(verificacao)

    token = _gerar_token()
    verificacao.token_hash = _hash_token(token)
    verificacao.token_expires_at = datetime.now() + timedelta(hours=VERIFICACAO_VALIDADE_HORAS)
    verificacao.last_sent_at = datetime.now()
    verificacao.verified = False
    verificacao.verified_at = None

    db.commit()

    try:
        enviar_email_confirmacao(user.email, user.name, token)
    except Exception:
        logger.warning(
            "Falha ao enviar e-mail de confirmação para user_id=%s (%s)",
            user.id, user.email, exc_info=True,
        )


@router.get("/verificar-email/confirmar")
def confirmar_email(token: str, db: Session = Depends(get_db)):
    token_hash = _hash_token(token)

    verificacao = (
        db.query(EmailVerifications)
        .filter(EmailVerifications.token_hash == token_hash)
        .first()
    )

    if (
        not verificacao
        or verificacao.verified
        or not verificacao.token_expires_at
        or verificacao.token_expires_at < datetime.now()
    ):
        raise HTTPException(status_code=400, detail="Link de confirmação inválido ou expirado.")

    verificacao.verified = True
    verificacao.verified_at = datetime.now()
    verificacao.token_hash = None
    verificacao.token_expires_at = None

    db.add(HistoryLog(
        user_id=verificacao.user_id,
        action="Confirmou o e-mail cadastrado",
        fechamento_id=None,
        unit_id=None,
        status_snapshot=None,
    ))

    db.commit()

    return {"message": "E-mail confirmado com sucesso. Você já pode acessar o sistema."}


@router.post("/verificar-email/reenviar")
def reenviar_verificacao(payload: SolicitarVerificacaoIn, db: Session = Depends(get_db)):
    mensagem_generica = {
        "message": "Se o e-mail informado estiver cadastrado e pendente de confirmação, reenviamos o link."
    }

    user = db.query(Users).filter(Users.email == str(payload.email)).first()
    if not user:
        return mensagem_generica

    verificacao = (
        db.query(EmailVerifications).filter(EmailVerifications.user_id == user.id).first()
    )
    if verificacao and verificacao.verified:
        return mensagem_generica

    if (
        verificacao
        and verificacao.last_sent_at
        and (datetime.now() - verificacao.last_sent_at).total_seconds() < VERIFICACAO_REENVIO_MINIMO_SEGUNDOS
    ):
        return mensagem_generica

    criar_verificacao_e_enviar(db, user)
    db.commit()

    return mensagem_generica


@router.post("/esqueci-senha")
def esqueci_senha(payload: EsqueciSenhaIn, db: Session = Depends(get_db)):
    mensagem_generica = {
        "message": "Se o e-mail informado estiver cadastrado, enviamos instruções para redefinir a senha."
    }

    user = db.query(Users).filter(Users.email == str(payload.email)).first()
    if not user or not user.status:
        return mensagem_generica

    token = _gerar_token()

    db.add(PasswordResetTokens(
        user_id=user.id,
        token_hash=_hash_token(token),
        expires_at=datetime.now() + timedelta(minutes=RESET_SENHA_VALIDADE_MINUTOS),
    ))
    db.commit()

    try:
        enviar_email_redefinicao_senha(user.email, user.name, token)
    except Exception:
        logger.warning(
            "Falha ao enviar e-mail de redefinição de senha para user_id=%s (%s)",
            user.id, user.email, exc_info=True,
        )

    return mensagem_generica


@router.post("/redefinir-senha")
def redefinir_senha(payload: RedefinirSenhaIn, db: Session = Depends(get_db)):
    token_hash = _hash_token(payload.token)

    reset = (
        db.query(PasswordResetTokens)
        .filter(PasswordResetTokens.token_hash == token_hash)
        .first()
    )

    if not reset or reset.used_at is not None or reset.expires_at < datetime.now():
        raise HTTPException(status_code=400, detail="Link de redefinição inválido ou expirado.")

    user = db.query(Users).filter(Users.id == reset.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    user.hash_passwd = pwd_context.hash(payload.new_password)
    reset.used_at = datetime.now()

    # Invalida quaisquer outros links de redefinição pendentes deste usuário.
    db.query(PasswordResetTokens).filter(
        PasswordResetTokens.user_id == user.id,
        PasswordResetTokens.id != reset.id,
        PasswordResetTokens.used_at.is_(None),
    ).update({PasswordResetTokens.used_at: datetime.now()}, synchronize_session=False)

    db.add(HistoryLog(
        user_id=user.id,
        action="Redefiniu a senha via recuperação por e-mail",
        fechamento_id=None,
        unit_id=user.unit_id,
        status_snapshot=None,
    ))

    db.commit()

    return {"message": "Senha redefinida com sucesso. Você já pode acessar com a nova senha."}