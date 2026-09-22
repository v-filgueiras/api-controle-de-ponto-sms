from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user, require_role
from models import HistoryLog, Units, Users
from schemas.users import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/usuarios", tags=["usuarios"])


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

MAX_PROFILE_PHOTO_SIZE = 2 * 1024 * 1024
ALLOWED_PROFILE_PHOTO_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}


def _validar_assinatura_imagem(data: bytes, content_type: str) -> bool:
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")

    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")

    if content_type == "image/webp":
        return (
            len(data) >= 12
            and data[:4] == b"RIFF"
            and data[8:12] == b"WEBP"
        )

    return False


class AdminPasswordUpdate(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class MyPasswordUpdate(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UnitLinkIn(BaseModel):
    unit_id: int


def registrar_acao_administrativa(
    db: Session,
    actor: Users,
    action: str,
    unit_id: int | None = None,
):
    db.add(
        HistoryLog(
            user_id=actor.id,
            action=action,
            fechamento_id=None,
            unit_id=unit_id,
            status_snapshot=None,
        )
    )


def validar_gerenciamento_de_coordenador(actor: Users, target: Users):
    if actor.perfil == "rh" and target.perfil != "coordinator":
        raise HTTPException(
            status_code=403,
            detail="O RH só pode gerenciar usuários coordenadores.",
        )


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
    actor: Users = Depends(require_role("admin", "rh")),
):
    query = db.query(Users)

    # O RH só precisa visualizar coordenadores.
    if actor.perfil == "rh":
        query = query.filter(Users.perfil == "coordinator")

    return query.order_by(Users.name.asc()).all()


@router.post("/me/foto")
async def atualizar_minha_foto(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    content_type = (file.content_type or "").lower()

    if content_type not in ALLOWED_PROFILE_PHOTO_TYPES:
        raise HTTPException(
            status_code=422,
            detail="Formato não permitido. Use JPG, PNG ou WEBP.",
        )

    data = await file.read(MAX_PROFILE_PHOTO_SIZE + 1)

    if not data:
        raise HTTPException(status_code=422, detail="A imagem enviada está vazia.")

    if len(data) > MAX_PROFILE_PHOTO_SIZE:
        raise HTTPException(
            status_code=413,
            detail="A foto deve ter no máximo 2 MB.",
        )

    if not _validar_assinatura_imagem(data, content_type):
        raise HTTPException(
            status_code=422,
            detail="O conteúdo do arquivo não corresponde a uma imagem válida.",
        )

    user.profile_photo = data
    user.profile_photo_mime = content_type
    db.commit()

    return {"message": "Foto de perfil atualizada com sucesso."}


@router.delete("/me/foto")
def remover_minha_foto(
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    user.profile_photo = None
    user.profile_photo_mime = None
    db.commit()

    return {"message": "Foto de perfil removida com sucesso."}


@router.get("/{user_id}/foto")
def obter_foto_usuario(
    user_id: int,
    db: Session = Depends(get_db),
    _: Users = Depends(get_current_user),
):
    user = db.query(Users).filter(Users.id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    if not user.profile_photo or not user.profile_photo_mime:
        raise HTTPException(status_code=404, detail="Usuário sem foto de perfil.")

    return Response(
        content=user.profile_photo,
        media_type=user.profile_photo_mime,
        headers={
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": "inline",
        },
    )


@router.get("/{user_id}", response_model=UserOut)
def obter_usuario(
    user_id: int,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    validar_gerenciamento_de_coordenador(actor, user)
    return user


@router.post("", response_model=UserOut, status_code=201)
def criar_usuario(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin")),
):
    if payload.perfil == "coordinator" and not payload.unit_id:
        raise HTTPException(status_code=422, detail="Coordenador precisa de unit_id.")

    if payload.unit_id:
        unit = (
            db.query(Units)
            .filter(Units.id == payload.unit_id, Units.active.is_(True))
            .first()
        )
        if not unit:
            raise HTTPException(status_code=422, detail="Unidade inválida ou inativa.")

    if db.query(Users).filter(Users.email == payload.email).first():
        raise HTTPException(status_code=409, detail="Já existe um usuário com esse e-mail.")

    user = Users(
        name=payload.name,
        email=payload.email,
        hash_passwd=pwd_context.hash(payload.password),
        perfil=payload.perfil,
        unit_id=payload.unit_id,
        status=True,
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

    if perfil == "coordinator" and unit_id:
        unit = (
            db.query(Units)
            .filter(Units.id == unit_id, Units.active.is_(True))
            .first()
        )
        if not unit:
            raise HTTPException(status_code=422, detail="Unidade inválida ou inativa.")

    if perfil != "coordinator":
        dados["unit_id"] = None

    dados.pop("password", None)
    dados.pop("hash_passwd", None)

    for campo, valor in dados.items():
        if hasattr(user, campo):
            setattr(user, campo, valor)

    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}/desvincular-unidade")
def desvincular_coordenador(
    user_id: int,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    validar_gerenciamento_de_coordenador(actor, user)

    if user.perfil != "coordinator":
        raise HTTPException(status_code=422, detail="Somente coordenadores possuem vínculo de unidade.")

    if user.unit_id is None:
        raise HTTPException(status_code=409, detail="Este coordenador já está sem unidade vinculada.")

    old_unit_id = user.unit_id
    user.unit_id = None

    registrar_acao_administrativa(
        db,
        actor,
        f"Desvinculou coordenador: {user.name}",
        old_unit_id,
    )

    db.commit()
    return {"message": "Coordenador desvinculado da unidade com sucesso."}


@router.patch("/{user_id}/vincular-unidade")
def vincular_coordenador(
    user_id: int,
    payload: UnitLinkIn,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    validar_gerenciamento_de_coordenador(actor, user)

    if user.perfil != "coordinator":
        raise HTTPException(status_code=422, detail="Somente coordenadores podem ser vinculados a unidades.")

    unit = (
        db.query(Units)
        .filter(Units.id == payload.unit_id, Units.active.is_(True))
        .first()
    )
    if not unit:
        raise HTTPException(status_code=404, detail="Unidade não encontrada ou inativa.")

    user.unit_id = unit.id
    user.status = True

    registrar_acao_administrativa(
        db,
        actor,
        f"Vinculou coordenador {user.name} à unidade {unit.name}",
        unit.id,
    )

    db.commit()
    return {"message": "Coordenador vinculado à unidade com sucesso."}


@router.delete("/{user_id}")
def excluir_usuario(
    user_id: int,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    if actor.id == user.id:
        raise HTTPException(status_code=409, detail="Você não pode excluir a própria conta.")

    validar_gerenciamento_de_coordenador(actor, user)

    old_unit_id = user.unit_id
    user.status = False
    user.unit_id = None

    registrar_acao_administrativa(
        db,
        actor,
        f"Desativou usuário: {user.name} ({user.perfil})",
        old_unit_id,
    )

    db.commit()

    return {
        "message": "Usuário excluído do acesso ao sistema. O histórico foi preservado."
    }


@router.patch("/{user_id}/reativar")
def reativar_usuario(
    user_id: int,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin", "rh")),
):
    user = db.query(Users).filter(Users.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    validar_gerenciamento_de_coordenador(actor, user)

    if user.status:
        raise HTTPException(status_code=409, detail="Este usuário já está ativo.")

    user.status = True

    registrar_acao_administrativa(
        db,
        actor,
        f"Reativou usuário: {user.name} ({user.perfil})",
        user.unit_id,
    )

    db.commit()

    return {"message": "Usuário reativado com sucesso."}