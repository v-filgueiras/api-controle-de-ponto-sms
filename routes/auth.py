import secrets

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from config import BOOTSTRAP_TOKEN, RATE_LIMIT_ENABLED
from database.connect import get_db
from email_utils import email_tem_dominio_real
from models import Users
from rate_limit import chave_login, falhas_de_login, limite_por_ip
from routes.auth_extra import criar_verificacao_e_enviar
from security import (
    buscar_usuario_por_email,
    criar_access_token,
    normalizar_email,
    pwd_context,
    verificar_senha,
)


router = APIRouter(prefix="/auth", tags=["auth"])


class UserSessionOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    perfil: str
    unit_id: int | None
    status: bool
    approval_status: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserSessionOut


class BootstrapAdminIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8)
    bootstrap_token: str = Field(min_length=1)


class RegistrarIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


def _exigir_email_valido(email: str) -> None:
    email_valido, motivo = email_tem_dominio_real(email)
    if not email_valido:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"E-mail inválido ou com domínio inexistente: {motivo}",
        )


@router.post(
    "/bootstrap-admin",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(limite_por_ip(5, 15 * 60))],
)
def criar_primeiro_admin(
    payload: BootstrapAdminIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    if db.query(Users).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="O sistema já possui usuários cadastrados. Bootstrap bloqueado.",
        )

    if not BOOTSTRAP_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bootstrap desativado: defina BOOTSTRAP_TOKEN no servidor.",
        )

    if not secrets.compare_digest(payload.bootstrap_token, BOOTSTRAP_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token de bootstrap inválido.",
        )

    email = normalizar_email(str(payload.email))
    _exigir_email_valido(email)

    admin = Users(
        name=payload.name.strip(),
        email=email,
        hash_passwd=pwd_context.hash(payload.password),
        perfil="admin",
        unit_id=None,
        status=True,
        # O primeiro admin não tem quem o aprove, então já nasce aprovado.
        approval_status="aprovado",
    )

    db.add(admin)
    db.commit()
    db.refresh(admin)

    criar_verificacao_e_enviar(db, admin, background_tasks)

    return {
        "id": admin.id,
        "name": admin.name,
        "email": admin.email,
        "perfil": admin.perfil,
        "message": "Primeiro administrador criado. Verifique o e-mail para confirmar o cadastro.",
    }


@router.post(
    "/registrar",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(limite_por_ip(10, 60 * 60))],
)
def registrar_conta(
    payload: RegistrarIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Autocadastro público a partir da tela de login.

    O usuário fica com approval_status="pendente" (perfil "coordinator", sem
    unidade vinculada) e só consegue logar depois de ser aprovado por um
    usuário RH ou Administrador, que também cuidará de vincular o
    coordenador à unidade correta. O e-mail de confirmação é enviado, mas a
    confirmação não é exigida para o login.
    """
    email = normalizar_email(str(payload.email))
    _exigir_email_valido(email)

    if buscar_usuario_por_email(db, email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Já existe uma conta cadastrada com esse e-mail.",
        )

    novo_usuario = Users(
        name=payload.name.strip(),
        email=email,
        hash_passwd=pwd_context.hash(payload.password),
        perfil="coordinator",
        unit_id=None,
        status=True,
        approval_status="pendente",
    )

    db.add(novo_usuario)
    db.commit()
    db.refresh(novo_usuario)

    criar_verificacao_e_enviar(db, novo_usuario, background_tasks)

    return {
        "message": (
            "Conta criada. Assim que o RH ou a administração aprovar seu cadastro, "
            "você já poderá acessar o sistema normalmente."
        )
    }


@router.post("/login", response_model=TokenOut)
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    email = normalizar_email(form_data.username)
    chave = chave_login(request, email)

    if RATE_LIMIT_ENABLED and falhas_de_login.bloqueado(chave):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.",
        )

    user = buscar_usuario_por_email(db, email)

    senha_ok = verificar_senha(form_data.password, user.hash_passwd if user else None)

    if not user or not senha_ok:
        falhas_de_login.registrar(chave)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="E-mail ou senha incorretos.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    falhas_de_login.limpar(chave)

    if not user.status:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Usuário inativo.",
        )

    if user.approval_status == "pendente":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seu cadastro ainda aguarda aprovação do RH ou da administração.",
        )

    if user.approval_status == "rejeitado":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seu cadastro não foi aprovado para acesso ao sistema. Fale com o RH ou a administração.",
        )

    token = criar_access_token(user)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "perfil": user.perfil,
            "unit_id": user.unit_id,
            "status": user.status,
            "approval_status": user.approval_status,
        },
    }
