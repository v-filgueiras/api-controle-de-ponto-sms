import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from jose import jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from database.connect import get_db
from email_utils import email_tem_dominio_real
from models import Users
from routes.auth_extra import criar_verificacao_e_enviar


router = APIRouter(prefix="/auth", tags=["auth"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

SECRET_KEY = os.getenv("SECRET_KEY", "troque-esta-chave-em-producao")
ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "480"))


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


class RegistrarIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


def criar_access_token(user: Users) -> str:
    expira_em = datetime.now(timezone.utc) + timedelta(
        minutes=ACCESS_TOKEN_EXPIRE_MINUTES
    )

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "perfil": user.perfil,
        "exp": expira_em,
    }

    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


@router.post("/bootstrap-admin", status_code=status.HTTP_201_CREATED)
def criar_primeiro_admin(
    payload: BootstrapAdminIn,
    db: Session = Depends(get_db),
):
    if db.query(Users).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="O sistema já possui usuários cadastrados. Bootstrap bloqueado.",
        )

    email_valido, motivo = email_tem_dominio_real(str(payload.email))
    if not email_valido:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"E-mail inválido ou com domínio inexistente: {motivo}",
        )

    admin = Users(
        name=payload.name,
        email=str(payload.email),
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

    criar_verificacao_e_enviar(db, admin)
    db.commit()

    return {
        "id": admin.id,
        "name": admin.name,
        "email": admin.email,
        "perfil": admin.perfil,
        "message": "Primeiro administrador criado. Verifique o e-mail para confirmar o cadastro antes de acessar.",
    }


@router.post("/registrar", status_code=status.HTTP_201_CREATED)
def registrar_conta(
    payload: RegistrarIn,
    db: Session = Depends(get_db),
):
    """Autocadastro público a partir da tela de login.

    O usuário fica com approval_status="pendente" (perfil "coordinator", sem
    unidade vinculada) e só consegue efetivamente logar depois de:
      1) confirmar o e-mail (link enviado por e-mail); e
      2) ser aprovado por um usuário RH ou Administrador, que também cuidará
         de vincular o coordenador à unidade correta.
    """
    email_valido, motivo = email_tem_dominio_real(str(payload.email))
    if not email_valido:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"E-mail inválido ou com domínio inexistente: {motivo}",
        )

    if db.query(Users).filter(Users.email == str(payload.email)).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Já existe uma conta cadastrada com esse e-mail.",
        )

    novo_usuario = Users(
        name=payload.name.strip(),
        email=str(payload.email),
        hash_passwd=pwd_context.hash(payload.password),
        perfil="coordinator",
        unit_id=None,
        status=True,
        approval_status="pendente",
    )

    db.add(novo_usuario)
    db.commit()
    db.refresh(novo_usuario)

    criar_verificacao_e_enviar(db, novo_usuario)
    db.commit()

    return {
        "message": (
            "Conta criada. Assim que o RH ou a administração aprovar seu cadastro, "
            "você já poderá acessar o sistema normalmente."
        )
    }


@router.post("/login", response_model=TokenOut)
def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    user = (
        db.query(Users)
        .filter(Users.email == form_data.username)
        .first()
    )

    if not user or not pwd_context.verify(
        form_data.password,
        user.hash_passwd,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="E-mail ou senha incorretos.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.status:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Usuário inativo.",
        )

    # A trava de acesso agora é só a aprovação do RH/administração; a
    # confirmação de e-mail deixou de ser exigida para o login.
    if user.approval_status == "pendente":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seu cadastro foi confirmado, mas ainda aguarda aprovação do RH ou da administração.",
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