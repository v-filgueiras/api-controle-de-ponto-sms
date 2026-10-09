from sqlalchemy.orm import Session

from models import Fechamentos, HistoryLog

_ACTION_MAX = 100  # tamanho da coluna history_log.action


def registrar_evento(
    db: Session,
    user_id: int,
    action: str,
    fechamento: Fechamentos | None = None,
    unit_id: int | None = None,
) -> None:
    db.add(HistoryLog(
        user_id=user_id,
        action=action[:_ACTION_MAX],
        fechamento_id=fechamento.id if fechamento else None,
        unit_id=fechamento.unit_id if fechamento else unit_id,
        status_snapshot=fechamento.status if fechamento else None,
    ))
