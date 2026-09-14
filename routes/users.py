from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import require_role
from models import Users
from schemas.users import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/usuarios", tags=["usuarios"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


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

    for campo, valor in payload.model_dump(exclude_unset=True).items():
        setattr(user, campo, valor)

    db.commit()
    db.refresh(user)
    return user