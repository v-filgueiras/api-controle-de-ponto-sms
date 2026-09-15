from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from database.connect import get_db
from deps import require_role
from models import Fechamentos, PointRows, Units, Users

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]


def _competencia_atual() -> str:
    from datetime import datetime
    agora = datetime.now()
    return f"{MESES[agora.month - 1]}/{agora.year}"


def _soma(rows, campo: str) -> int:
    return sum(int(getattr(row, campo, 0) or 0) for row in rows)


@router.get("/rh")
def dashboard_rh(
    competence: str | None = None,
    unit_id: int | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh")),
):
    """Dashboard consolidado, acessível exclusivamente ao perfil RH."""

    competencia = competence or _competencia_atual()

    todas_unidades = db.query(Units).order_by(Units.name.asc()).all()
    unidades_filtradas = (
        [u for u in todas_unidades if u.id == unit_id]
        if unit_id is not None
        else todas_unidades
    )

    query = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.unit))
        .filter(Fechamentos.competence == competencia)
    )
    if unit_id is not None:
        query = query.filter(Fechamentos.unit_id == unit_id)

    fechamentos = query.all()
    por_unidade = {f.unit_id: f for f in fechamentos}

    unidades_saida = []
    totais = {
        "units": len(unidades_filtradas),
        "employees": 0,
        "worked_days": 0,
        "absences": 0,
        "medical_certificates": 0,
        "overtime": 0,
        "time_bank": 0,
        "night_additional": 0,
        "gratification": 0,
        "insalubrity": 0,
        "pending": 0,
        "approved": 0,
        "correction": 0,
        "rejected": 0,
        "not_sent": 0,
    }

    for unidade in unidades_filtradas:
        fechamento = por_unidade.get(unidade.id)
        rows = fechamento.rows if fechamento else []
        status = fechamento.status if fechamento else "nao_enviado"

        dados = {
            "unit_id": unidade.id,
            "unit_name": unidade.name,
            "status": status,
            "employees": len(rows),
            "dt": _soma(rows, "dt"),
            "faltas": _soma(rows, "faltas"),
            "at": _soma(rows, "at"),
            "bh": _soma(rows, "bh"),
            "he": _soma(rows, "he"),
            "an": _soma(rows, "an"),
            "gr": _soma(rows, "gr"),
            "ins": _soma(rows, "ins"),
        }
        unidades_saida.append(dados)

        totais["employees"] += dados["employees"]
        totais["worked_days"] += dados["dt"]
        totais["absences"] += dados["faltas"]
        totais["medical_certificates"] += dados["at"]
        totais["overtime"] += dados["he"]
        totais["time_bank"] += dados["bh"]
        totais["night_additional"] += dados["an"]
        totais["gratification"] += dados["gr"]
        totais["insalubrity"] += dados["ins"]

        if status == "pendente":
            totais["pending"] += 1
        elif status == "aprovado":
            totais["approved"] += 1
        elif status == "correcao":
            totais["correction"] += 1
        elif status == "rejeitado":
            totais["rejected"] += 1
        elif status in ("rascunho", "nao_enviado"):
            totais["not_sent"] += 1

    # Competências para o filtro do frontend.
    competencias_db = [
        c[0]
        for c in db.query(Fechamentos.competence).distinct().all()
        if c[0]
    ]
    competencias = [competencia]
    for item in competencias_db:
        if item not in competencias:
            competencias.append(item)

    # Ranking: maior quantidade de faltas primeiro.
    unidades_saida.sort(key=lambda x: (-x["faltas"], x["unit_name"]))

    return {
        "competence": competencia,
        "selected_unit_id": unit_id,
        "competences": competencias,
        "available_units": [
            {"id": u.id, "name": u.name}
            for u in todas_unidades
        ],
        "totals": totais,
        "units": unidades_saida,
    }