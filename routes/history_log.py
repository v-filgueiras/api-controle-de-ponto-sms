from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user, require_role
from models import Fechamentos, HistoryLog, Users
from schemas.history_log import HistoryLogOut

router = APIRouter(prefix="/historico", tags=["historico"])


@router.get("", response_model=list[HistoryLogOut])
def listar_historico(
    fechamento_id: int | None = None,
    unit_id: int | None = None,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    query = db.query(HistoryLog)

    if user.perfil == "coordinator":
        query = query.filter(HistoryLog.unit_id == user.unit_id)
    elif user.perfil not in ("admin", "rh"):
        raise HTTPException(status_code=403, detail="Acesso não autorizado.")

    if fechamento_id is not None:
        query = query.filter(HistoryLog.fechamento_id == fechamento_id)
    if unit_id is not None:
        if user.perfil == "coordinator" and unit_id != user.unit_id:
            raise HTTPException(status_code=403, detail="Você só pode acessar a própria unidade.")
        query = query.filter(HistoryLog.unit_id == unit_id)

    return query.order_by(HistoryLog.timestamp.desc()).all()


@router.get("/fechamento/{fechamento_id}", response_model=list[HistoryLogOut])
def historico_do_fechamento(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    if user.perfil == "coordinator" and user.unit_id != fechamento.unit_id:
        raise HTTPException(status_code=403, detail="Você só pode acessar a própria unidade.")

    return (
        db.query(HistoryLog)
        .filter(HistoryLog.fechamento_id == fechamento_id)
        .order_by(HistoryLog.timestamp.desc())
        .all()
    )
