"""Chat entre coordenadores e RH.

Uma conversa por unidade: o coordenador da unidade conversa com o RH.
Qualquer pessoa do RH enxerga e responde a conversa de qualquer unidade.

O model fica neste arquivo para ficar independente do seu models.py.
Como o main.py importa este módulo antes de Base.metadata.create_all(),
a tabela "mensagens" é criada automaticamente na próxima inicialização
(create_all não altera tabelas que já existem, então nada do que você
tem hoje é afetado).
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import Column, DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Session

from database.connect import Base, get_db
from deps import require_role
from models import Units, Users

router = APIRouter(tags=["mensagens"])


class Mensagens(Base):
    __tablename__ = "mensagens"

    id = Column(Integer, primary_key=True, index=True)
    unit_id = Column(Integer, nullable=False)
    sender_id = Column(Integer, nullable=False)
    sender_perfil = Column(String(20), nullable=False)  # "coordinator" | "rh"
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    # None = ainda não lida pelo outro lado da conversa
    read_at = Column(DateTime, nullable=True)

    __table_args__ = (Index("ix_mensagens_unit_id_id", "unit_id", "id"),)


class MensagemIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


def _lado_oposto(perfil: str) -> str:
    return "rh" if perfil == "coordinator" else "coordinator"


def _checar_acesso(db: Session, user: Users, unit_id: int) -> Units:
    if user.perfil == "coordinator" and user.unit_id != unit_id:
        raise HTTPException(
            status_code=403,
            detail="Você só pode acessar a conversa da própria unidade.",
        )

    unit = db.query(Units).filter(Units.id == unit_id, Units.active.is_(True)).first()
    if not unit:
        raise HTTPException(status_code=404, detail="Unidade não encontrada ou inativa.")
    return unit


def _msg_out(msg: Mensagens, sender_name: str | None) -> dict:
    return {
        "id": msg.id,
        "unit_id": msg.unit_id,
        "sender_id": msg.sender_id,
        "sender_name": sender_name or "Usuário",
        "sender_perfil": msg.sender_perfil,
        "body": msg.body,
        "created_at": msg.created_at,
        "read_at": msg.read_at,
    }


@router.get("/mensagens/resumo")
def resumo_conversas(
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator", "rh")),
):
    """Lista de conversas com a última mensagem e a contagem de não lidas."""
    if user.perfil == "coordinator":
        unidades = (
            db.query(Units).filter(Units.id == user.unit_id, Units.active.is_(True)).all()
            if user.unit_id
            else []
        )
    else:
        unidades = (
            db.query(Units).filter(Units.active.is_(True)).order_by(Units.name.asc()).all()
        )

    ids = [u.id for u in unidades]
    if not ids:
        return {"conversations": [], "unread_total": 0}

    nao_lidas = dict(
        db.query(Mensagens.unit_id, func.count(Mensagens.id))
        .filter(
            Mensagens.unit_id.in_(ids),
            Mensagens.sender_perfil == _lado_oposto(user.perfil),
            Mensagens.read_at.is_(None),
        )
        .group_by(Mensagens.unit_id)
        .all()
    )

    ultimos_ids = [
        i
        for (i,) in db.query(func.max(Mensagens.id))
        .filter(Mensagens.unit_id.in_(ids))
        .group_by(Mensagens.unit_id)
        .all()
    ]

    ultimas = {}
    if ultimos_ids:
        rows = (
            db.query(Mensagens, Users.name)
            .outerjoin(Users, Users.id == Mensagens.sender_id)
            .filter(Mensagens.id.in_(ultimos_ids))
            .all()
        )
        ultimas = {m.unit_id: _msg_out(m, nome) for m, nome in rows}

    conversas = [
        {
            "unit_id": u.id,
            "unit_name": u.name,
            "last_message": ultimas.get(u.id),
            "unread": int(nao_lidas.get(u.id, 0)),
        }
        for u in unidades
    ]

    return {
        "conversations": conversas,
        "unread_total": sum(c["unread"] for c in conversas),
    }


@router.get("/unidades/{unit_id}/mensagens")
def listar_mensagens(
    unit_id: int,
    after_id: int | None = None,
    limit: int = Query(100, ge=1, le=300),
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator", "rh")),
):
    """Sem after_id: as últimas `limit` mensagens. Com after_id: só as mais novas (polling)."""
    _checar_acesso(db, user, unit_id)

    query = (
        db.query(Mensagens, Users.name)
        .outerjoin(Users, Users.id == Mensagens.sender_id)
        .filter(Mensagens.unit_id == unit_id)
    )

    if after_id is not None:
        rows = (
            query.filter(Mensagens.id > after_id)
            .order_by(Mensagens.id.asc())
            .limit(limit)
            .all()
        )
    else:
        rows = query.order_by(Mensagens.id.desc()).limit(limit).all()
        rows.reverse()

    return [_msg_out(m, nome) for m, nome in rows]


@router.post("/unidades/{unit_id}/mensagens", status_code=201)
def enviar_mensagem(
    unit_id: int,
    payload: MensagemIn,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator", "rh")),
):
    _checar_acesso(db, user, unit_id)

    texto = payload.body.strip()
    if not texto:
        raise HTTPException(status_code=422, detail="A mensagem não pode ficar vazia.")

    msg = Mensagens(
        unit_id=unit_id,
        sender_id=user.id,
        sender_perfil=user.perfil,
        body=texto,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return _msg_out(msg, user.name)


@router.post("/unidades/{unit_id}/mensagens/lidas")
def marcar_como_lidas(
    unit_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator", "rh")),
):
    """Marca como lidas as mensagens que o outro lado enviou nesta conversa."""
    _checar_acesso(db, user, unit_id)

    atualizadas = (
        db.query(Mensagens)
        .filter(
            Mensagens.unit_id == unit_id,
            Mensagens.sender_perfil == _lado_oposto(user.perfil),
            Mensagens.read_at.is_(None),
        )
        .update({Mensagens.read_at: datetime.now()}, synchronize_session=False)
    )
    db.commit()
    return {"marked": atualizadas}