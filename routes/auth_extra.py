"""Confirmação de e-mail e recuperação de senha.

1) Confirmação de e-mail: ao criar uma conta, um link de confirmação é
   enviado por e-mail. A confirmação fica registrada em email_verifications,
   mas NÃO bloqueia o login: o acesso é controlado pela aprovação do
   RH/administração (users.approval_status).

2) Esqueci minha senha: gera um token de uso único, válido por 1 hora,
   enviado por e-mail, que permite definir uma nova senha sem precisar da
   senha atual. As respostas nunca revelam se um e-mail existe ou não no
   sistema, para não permitir enumeração de contas. Redefinir a senha
   encerra todas as sessões abertas (ver security.senha_fingerprint).

Os e-mails são enviados em segundo plano (BackgroundTasks) para a
requisição não ficar presa no SMTP.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from database.connect import get_db
from email_utils import enviar_email_confirmacao, enviar_email_redefinicao_senha
from history import registrar_evento
from models import EmailVerifications, PasswordResetTokens, Users
from rate_limit import limite_por_ip
from security import buscar_usuario_por_email, pwd_context

logger = logging.getLogger("auth_extra")

router = APIRouter(prefix="/auth", tags=["auth"])

VERIFICACAO_VALIDADE_HORAS = 24
VERIFICACAO_REENVIO_MINIMO_SEGUNDOS = 60
RESET_SENHA_VALIDADE_MINUTOS = 60
RESET_SENHA_REENVIO_MINIMO_SEGUNDOS = 60


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


def _enviar_seguro(envio, destinatario: str, nome: str, token: str, user_id: int) -> None:
    """Roda em segundo plano: falha de SMTP só vira log, nunca erro de API."""
    try:
        envio(destinatario, nome, token)
    except Exception:
        logger.warning(
            "Falha ao enviar e-mail para user_id=%s", user_id, exc_info=True
        )


def criar_verificacao_e_enviar(
    db: Session, user: Users, background_tasks: BackgroundTasks
) -> None:
    """Gera um novo token de confirmação para `user` e agenda o envio."""
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

    background_tasks.add_task(
        _enviar_seguro, enviar_email_confirmacao, user.email, user.name, token, user.id
    )


@router.get(
    "/verificar-email/confirmar",
    dependencies=[Depends(limite_por_ip(30, 15 * 60))],
)
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

    registrar_evento(db, verificacao.user_id, "Confirmou o e-mail cadastrado")

    db.commit()

    return {"message": "E-mail confirmado com sucesso. Você já pode acessar o sistema."}


@router.post(
    "/verificar-email/reenviar",
    dependencies=[Depends(limite_por_ip(5, 15 * 60))],
)
def reenviar_verificacao(
    payload: SolicitarVerificacaoIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    mensagem_generica = {
        "message": "Se o e-mail informado estiver cadastrado e pendente de confirmação, reenviamos o link."
    }

    user = buscar_usuario_por_email(db, str(payload.email))
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

    criar_verificacao_e_enviar(db, user, background_tasks)

    return mensagem_generica


@router.post(
    "/esqueci-senha",
    dependencies=[Depends(limite_por_ip(5, 15 * 60))],
)
def esqueci_senha(
    payload: EsqueciSenhaIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    mensagem_generica = {
        "message": "Se o e-mail informado estiver cadastrado, enviamos instruções para redefinir a senha."
    }

    user = buscar_usuario_por_email(db, str(payload.email))
    if not user or not user.status:
        return mensagem_generica

    ultimo = (
        db.query(PasswordResetTokens)
        .filter(PasswordResetTokens.user_id == user.id)
        .order_by(PasswordResetTokens.created_at.desc())
        .first()
    )
    if (
        ultimo
        and (datetime.now() - ultimo.created_at).total_seconds()
        < RESET_SENHA_REENVIO_MINIMO_SEGUNDOS
    ):
        return mensagem_generica

    token = _gerar_token()

    db.add(PasswordResetTokens(
        user_id=user.id,
        token_hash=_hash_token(token),
        expires_at=datetime.now() + timedelta(minutes=RESET_SENHA_VALIDADE_MINUTOS),
    ))
    db.commit()

    background_tasks.add_task(
        _enviar_seguro, enviar_email_redefinicao_senha, user.email, user.name, token, user.id
    )

    return mensagem_generica


@router.post(
    "/redefinir-senha",
    dependencies=[Depends(limite_por_ip(10, 15 * 60))],
)
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

    registrar_evento(
        db, user.id, "Redefiniu a senha via recuperação por e-mail", unit_id=user.unit_id
    )

    db.commit()

    return {"message": "Senha redefinida com sucesso. Você já pode acessar com a nova senha."}