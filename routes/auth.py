import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from jose import jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from database.connect import get_db
from models import Users


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


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserSessionOut


class BootstrapAdminIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8)


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

    admin = Users(
        name=payload.name,
        email=str(payload.email),
        hash_passwd=pwd_context.hash(payload.password),
        perfil="admin",
        unit_id=None,
        status=True,
    )

    db.add(admin)
    db.commit()
    db.refresh(admin)

    return {
        "id": admin.id,
        "name": admin.name,
        "email": admin.email,
        "perfil": admin.perfil,
        "message": "Primeiro administrador criado com sucesso.",
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
        },
    }
