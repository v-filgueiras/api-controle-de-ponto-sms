from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user, require_role
from models import Fechamentos, HistoryLog, Users
from schemas.history_log import HistoryLogOut

router = APIRouter(prefix="/historico", tags=["historico"])

# Sem limite, essa consulta cresce para sempre junto com o histórico e cada
# chamada fica mais lenta. Paginamos com um teto sensato por padrão.
HISTORICO_LIMIT_PADRAO = 300
HISTORICO_LIMIT_MAXIMO = 1000


@router.get("", response_model=list[HistoryLogOut])
def listar_historico(
    fechamento_id: int | None = None,
    unit_id: int | None = None,
    limit: int = HISTORICO_LIMIT_PADRAO,
    offset: int = 0,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    limit = max(1, min(limit, HISTORICO_LIMIT_MAXIMO))
    offset = max(0, offset)

    query = db.query(HistoryLog)

    # Só o RH enxerga o histórico global. Admin e coordinator só veem as
    # próprias ações (registradas com o user_id de quem agiu).
    if user.perfil == "rh":
        pass
    elif user.perfil in ("admin", "coordinator"):
        query = query.filter(HistoryLog.user_id == user.id)
    else:
        raise HTTPException(status_code=403, detail="Acesso não autorizado.")

    if fechamento_id is not None:
        query = query.filter(HistoryLog.fechamento_id == fechamento_id)
    if unit_id is not None:
        query = query.filter(HistoryLog.unit_id == unit_id)

    return (
        query.order_by(HistoryLog.timestamp.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )


@router.get("/fechamento/{fechamento_id}", response_model=list[HistoryLogOut])
def historico_do_fechamento(
    fechamento_id: int,
    limit: int = HISTORICO_LIMIT_MAXIMO,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")

    limit = max(1, min(limit, HISTORICO_LIMIT_MAXIMO))

    query = db.query(HistoryLog).filter(HistoryLog.fechamento_id == fechamento_id)

    # Só o RH enxerga todas as ações do fechamento. Admin e coordinator só
    # veem as próprias ações dentro dele.
    if user.perfil != "rh":
        query = query.filter(HistoryLog.user_id == user.id)

    return query.order_by(HistoryLog.timestamp.desc()).limit(limit).all()