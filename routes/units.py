from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user, require_role
from models import HistoryLog, Units, Users
from schemas.units import UnitCreate, UnitOut

router = APIRouter(prefix="/units", tags=["units"])


@router.get("", response_model=list[UnitOut])
def listar_unidades(
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    query = db.query(Units).filter(Units.active.is_(True))

    if user.perfil == "coordinator":
        if user.unit_id is None:
            return []
        query = query.filter(Units.id == user.unit_id)

    return query.order_by(Units.name.asc()).all()


@router.get("/{unit_id}", response_model=UnitOut)
def obter_unidade(
    unit_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    if user.perfil == "coordinator" and user.unit_id != unit_id:
        raise HTTPException(status_code=403, detail="Você só pode acessar a própria unidade.")

    unit = (
        db.query(Units)
        .filter(Units.id == unit_id, Units.active.is_(True))
        .first()
    )
    if not unit:
        raise HTTPException(status_code=404, detail="Unidade não encontrada.")
    return unit


@router.post("", response_model=UnitOut, status_code=201)
def criar_unidade(
    payload: UnitCreate,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin")),
):
    existente = db.query(Units).filter(Units.name == payload.name).first()
    if existente:
        if existente.active:
            raise HTTPException(status_code=409, detail="Já existe uma unidade com esse nome.")
        raise HTTPException(
            status_code=409,
            detail="Já existe uma unidade desativada com esse nome.",
        )

    unit = Units(name=payload.name, active=True)
    db.add(unit)
    db.commit()
    db.refresh(unit)
    return unit


@router.delete("/{unit_id}")
def excluir_unidade(
    unit_id: int,
    db: Session = Depends(get_db),
    actor: Users = Depends(require_role("admin")),
):
    unit = db.query(Units).filter(Units.id == unit_id).first()
    if not unit:
        raise HTTPException(status_code=404, detail="Unidade não encontrada.")

    if not unit.active:
        raise HTTPException(status_code=409, detail="Esta unidade já está desativada.")

    # Preserva fechamentos/histórico e apenas remove a unidade do uso corrente.
    db.query(Users).filter(Users.unit_id == unit.id).update(
        {Users.unit_id: None},
        synchronize_session=False,
    )

    unit.active = False

    db.add(
        HistoryLog(
            user_id=actor.id,
            action=f"Desativou unidade: {unit.name}",
            fechamento_id=None,
            unit_id=unit.id,
            status_snapshot=None,
        )
    )

    db.commit()

    return {
        "message": "Unidade excluída do uso ativo. Fechamentos e histórico foram preservados."
    }