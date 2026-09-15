from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user, require_role
from models import Users
from schemas.users import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/usuarios", tags=["usuarios"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class AdminPasswordUpdate(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class MyPasswordUpdate(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


@router.put("/me/senha")
def alterar_minha_senha(
    payload: MyPasswordUpdate,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    if not pwd_context.verify(payload.current_password, user.hash_passwd):
        raise HTTPException(status_code=400, detail="Senha atual incorreta.")

    user.hash_passwd = pwd_context.hash(payload.new_password)
    db.commit()

    return {"message": "Senha alterada com sucesso."}


@router.put("/{user_id}/senha")
def redefinir_senha_usuario(
    user_id: int,
    payload: AdminPasswordUpdate,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    user.hash_passwd = pwd_context.hash(payload.password)
    db.commit()

    return {"message": "Senha redefinida com sucesso."}


@router.get("", response_model=list[UserOut])
def listar_usuarios(
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    return db.query(Users).all()


@router.get("/{user_id}", response_model=UserOut)
def obter_usuario(
    user_id: int,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    return user


@router.post("", response_model=UserOut, status_code=201)
def criar_usuario(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin")),
):
    if payload.perfil == "coordinator" and not payload.unit_id:
        raise HTTPException(status_code=422, detail="Coordenador precisa de unit_id.")
    if db.query(Users).filter(Users.email == payload.email).first():
        raise HTTPException(status_code=409, detail="Já existe um usuário com esse e-mail.")

    user = Users(
        name=payload.name,
        email=payload.email,
        hash_passwd=pwd_context.hash(payload.password),
        perfil=payload.perfil,
        unit_id=payload.unit_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.put("/{user_id}", response_model=UserOut)
def atualizar_usuario(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    dados = payload.model_dump(exclude_unset=True)

    if "email" in dados:
        existente = (
            db.query(Users)
            .filter(Users.email == dados["email"], Users.id != user_id)
            .first()
        )
        if existente:
            raise HTTPException(status_code=409, detail="Já existe um usuário com esse e-mail.")

    perfil = dados.get("perfil", user.perfil)
    unit_id = dados.get("unit_id", user.unit_id)

    if perfil == "coordinator" and not unit_id:
        raise HTTPException(status_code=422, detail="Coordenador precisa de unit_id.")

    if perfil != "coordinator":
        dados["unit_id"] = None

    # Senha nunca é atualizada por este endpoint genérico.
    dados.pop("password", None)
    dados.pop("hash_passwd", None)

    for campo, valor in dados.items():
        if hasattr(user, campo):
            setattr(user, campo, valor)

    db.commit()
    db.refresh(user)
    return user