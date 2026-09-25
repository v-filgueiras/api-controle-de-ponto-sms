from __future__ import annotations

from collections import Counter, defaultdict
from statistics import mean, median, pstdev

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from database.connect import get_db
from deps import require_role
from models import Fechamentos, HistoryLog, Users

router = APIRouter(prefix="/auditoria", tags=["auditoria"])

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]

CAMPOS = ("dt", "bh", "he", "an", "gr", "ins", "at")
LABELS = {
    "dt": "DT", "bh": "BH", "he": "HE", "an": "AN",
    "gr": "GR", "ins": "INS", "at": "AT",
}


def _competence_key(value: str):
    try:
        mes, ano = value.split("/", 1)
        return int(ano), MESES.index(mes.upper()) + 1
    except (ValueError, IndexError):
        return 0, 0


def _competencia_anterior(competence: str) -> str | None:
    ano, mes = _competence_key(competence)
    if not ano or not mes:
        return None
    mes -= 1
    if mes == 0:
        mes = 12
        ano -= 1
    return f"{MESES[mes - 1]}/{ano}"


def _num(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _totais(rows) -> dict[str, int]:
    return {campo: sum(_num(getattr(row, campo, 0)) for row in rows) for campo in CAMPOS}


def _variacao(atual: int, anterior: int) -> float | None:
    if anterior == 0:
        return None
    return round(((atual - anterior) / anterior) * 100, 1)


def _nivel(tipo: str) -> str:
    return {"danger": "atenção", "warning": "verificar", "success": "informativo"}.get(tipo, "verificar")


def _evento(tipo: str, titulo: str, descricao: str, referencia: str | None = None) -> dict:
    return {"type": tipo, "level": _nivel(tipo), "title": titulo, "description": descricao, "reference": referencia}


def _checar_acesso(user: Users, unit_id: int):
    # Auditoria é exclusiva de admin/rh, que enxergam todas as unidades —
    # por isso não há checagem adicional por unit_id aqui.
    if user.perfil not in ("admin", "rh"):
        raise HTTPException(status_code=403, detail="A auditoria está disponível para Administrador e RH.")


@router.get("/fechamentos")
def listar_fechamentos_auditaveis(
    competence: str | None = None,
    unit_id: int | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    query = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.unit))
        .order_by(Fechamentos.id.desc())
    )
    if competence:
        query = query.filter(Fechamentos.competence == competence)
    if unit_id is not None:
        query = query.filter(Fechamentos.unit_id == unit_id)
    items = query.limit(500).all()
    items.sort(key=lambda f: (_competence_key(f.competence), f.id), reverse=True)
    return [
        {
            "id": f.id,
            "unit_id": f.unit_id,
            "unit_name": f.unit.name if f.unit else "—",
            "competence": f.competence,
            "status": f.status,
            "document_id": f.document_id,
            "updated_at": f.updated_at,
        }
        for f in items
    ]


@router.get("/fechamento/{fechamento_id}")
def auditar_fechamento(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("admin", "rh")),
):
    fechamento = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.unit))
        .filter(Fechamentos.id == fechamento_id)
        .first()
    )
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso(user, fechamento.unit_id)

    rows = list(fechamento.rows or [])
    atual = _totais(rows)
    eventos: list[dict] = []

    matriculas = [str(r.matricula or "").strip() for r in rows]
    duplicadas = sorted([m for m, n in Counter(matriculas).items() if m and n > 1])
    if duplicadas:
        eventos.append(_evento("danger", "Matrículas duplicadas", f"Foram encontradas {len(duplicadas)} matrícula(s) repetida(s) no fechamento.", ", ".join(duplicadas[:10])))

    for row in rows:
        campos_obrigatorios = {"matricula": row.matricula, "nome": row.nome, "cargo": row.cargo, "periodo": row.periodo}
        faltantes = [campo for campo, valor in campos_obrigatorios.items() if not str(valor or "").strip()]
        if faltantes:
            eventos.append(_evento("danger", f"Cadastro incompleto: {row.nome or 'Servidor sem nome'}", "Existem campos básicos sem preenchimento.", ", ".join(faltantes)))
        if all(_num(getattr(row, campo, 0)) == 0 for campo in CAMPOS):
            observacao = str(getattr(row, "observacao", "") or "").strip()
            if not observacao or observacao.lower() == "sem observação":
                eventos.append(_evento("warning", f"Servidor sem lançamentos: {row.nome}", "Todos os indicadores numéricos estão zerados e não há justificativa registrada.", str(row.matricula)))

    if not fechamento.document_id:
        eventos.append(_evento("warning", "Documento não anexado", "O fechamento ainda não possui documento associado."))

    anterior_comp = _competencia_anterior(fechamento.competence)
    anterior = None
    if anterior_comp:
        anterior = (
            db.query(Fechamentos)
            .options(joinedload(Fechamentos.rows))
            .filter(Fechamentos.unit_id == fechamento.unit_id, Fechamentos.competence == anterior_comp)
            .first()
        )

    comparacao = None
    if anterior:
        prev = _totais(anterior.rows or [])
        comparacao = {
            "competence": anterior.competence,
            "totals": prev,
            "changes": {campo: {"current": atual[campo], "previous": prev[campo], "percent": _variacao(atual[campo], prev[campo])} for campo in CAMPOS},
        }
        for campo in ("he", "bh", "an"):
            if prev[campo] > 0 and atual[campo] >= prev[campo] * 2:
                eventos.append(_evento("warning", f"Variação relevante em {LABELS[campo]}", f"O total de {LABELS[campo]} passou de {prev[campo]} para {atual[campo]} em relação à competência anterior."))
    else:
        eventos.append(_evento("success", "Sem competência anterior para comparação", "A unidade não possui fechamento imediatamente anterior disponível para esta comparação."))

    historico = (
        db.query(HistoryLog)
        .filter(HistoryLog.fechamento_id == fechamento.id)
        .order_by(HistoryLog.timestamp.desc())
        .limit(100)
        .all()
    )
    timeline = [{"timestamp": item.timestamp, "action": item.action, "status": item.status_snapshot} for item in historico]

    return {
        "fechamento": {"id": fechamento.id, "unit_id": fechamento.unit_id, "unit_name": fechamento.unit.name if fechamento.unit else "—", "competence": fechamento.competence, "status": fechamento.status, "document_id": fechamento.document_id, "updated_at": fechamento.updated_at, "submitted_at": fechamento.submitted_at},
        "summary": {"employees": len(rows), "events": len(eventos), "attention": sum(1 for e in eventos if e["type"] == "danger"), "verification": sum(1 for e in eventos if e["type"] == "warning"), "informational": sum(1 for e in eventos if e["type"] == "success")},
        "totals": atual,
        "comparison": comparacao,
        "events": eventos,
        "timeline": timeline,
    }


def _stats(values: list[int]) -> dict:
    if not values:
        return {"count": 0, "mean": 0, "median": 0, "std": 0}
    return {"count": len(values), "mean": round(mean(values), 2), "median": round(median(values), 2), "std": round(pstdev(values), 2)}


def _row_values(row) -> dict[str, int]:
    return {campo: _num(getattr(row, campo, 0)) for campo in CAMPOS}


def _anomaly(field: str, current: int, history: list[int], cargo_values: list[int], unit_values: list[int]):
    if len(history) < 2:
        return None

    s = _stats(history)
    media = float(s["mean"])
    desvio = float(s["std"])
    grupo = _stats(cargo_values) if cargo_values else _stats(unit_values)

    ratio = None if media <= 0 else round(current / media, 2)
    z = round((current - media) / desvio, 2) if desvio > 0 else None

    # Exige um volume mínimo para evitar que 1h -> 2h seja tratado como grande anomalia.
    salto_relativo = media >= 3 and current >= media * 2.5
    z_alto = z is not None and z >= 2.0 and current >= media + 3
    acima_grupo = grupo["mean"] >= 3 and current >= grupo["mean"] * 2.0 and current >= media * 1.5

    if not (salto_relativo or z_alto or acima_grupo):
        return None

    if z_alto:
        motivo = f"{LABELS[field]} está {z} desvios-padrão acima da média histórica do servidor."
    elif salto_relativo:
        motivo = f"{LABELS[field]} está {ratio}x acima da média histórica do servidor."
    else:
        motivo = f"{LABELS[field]} está acima do padrão do cargo na unidade."

    return {
        "field": field,
        "label": LABELS[field],
        "current": current,
        "history": s,
        "group": grupo,
        "ratio": ratio,
        "z_score": z,
        "reason": motivo,
    }


def _pattern_level(anomalias: list[dict]) -> str:
    if any((a.get("z_score") or 0) >= 3 or (a.get("ratio") or 0) >= 5 for a in anomalias):
        return "attention"
    return "review"


@router.get("/padroes")
def detectar_padroes(
    competence: str | None = None,
    unit_id: int | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    """Detecção estatística de padrões anormais usando o histórico do sistema.

    Não é ML: usa histórico individual + grupo de cargo/unidade + regras estatísticas.
    O resultado é um alerta para revisão humana, nunca uma conclusão de irregularidade.
    """
    query = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.unit))
        .filter(Fechamentos.status != "rascunho")
    )
    if unit_id is not None:
        query = query.filter(Fechamentos.unit_id == unit_id)

    fechamentos = query.all()
    if not fechamentos:
        return {"competence": competence, "summary": {"patterns": 0, "attention": 0, "review": 0}, "patterns": [], "units": []}

    if competence:
        atuais = [f for f in fechamentos if f.competence == competence]
    else:
        # Por padrão, analisa a competência mais recente existente por unidade.
        latest_by_unit = {}
        for f in fechamentos:
            if f.unit_id not in latest_by_unit or _competence_key(f.competence) > _competence_key(latest_by_unit[f.unit_id].competence):
                latest_by_unit[f.unit_id] = f
        atuais = list(latest_by_unit.values())
        competence = max((f.competence for f in atuais), key=_competence_key, default=None)

    # Indexa todos os fechamentos para não fazer uma consulta por servidor.
    por_unidade = defaultdict(list)
    for f in fechamentos:
        por_unidade[f.unit_id].append(f)
    for lista in por_unidade.values():
        lista.sort(key=lambda f: _competence_key(f.competence), reverse=True)

    patterns = []
    unit_patterns = []

    for fechamento in atuais:
        historicos_unidade = [f for f in por_unidade[fechamento.unit_id] if _competence_key(f.competence) < _competence_key(fechamento.competence)]
        historicos_unidade = historicos_unidade[:12]

        current_rows = list(fechamento.rows or [])
        current_by_matricula = {str(r.matricula or "").strip(): r for r in current_rows if str(r.matricula or "").strip()}

        # Grupo atual por cargo.
        cargo_current = defaultdict(list)
        for r in current_rows:
            cargo_current[str(r.cargo or "").strip().upper()].append(r)

        for matricula, row in current_by_matricula.items():
            historicos_row = []
            for old in historicos_unidade:
                for old_row in old.rows or []:
                    if str(old_row.matricula or "").strip() == matricula:
                        historicos_row.append(old_row)

            if len(historicos_row) < 2:
                continue

            cargo_key = str(row.cargo or "").strip().upper()
            grupo_rows = cargo_current.get(cargo_key, [])
            anomalias = []
            for campo in CAMPOS:
                hist_values = [_num(getattr(r, campo, 0)) for r in historicos_row]
                cargo_values = [_num(getattr(r, campo, 0)) for r in grupo_rows if r is not row]
                unit_values = [_num(getattr(r, campo, 0)) for r in current_rows if r is not row]
                a = _anomaly(campo, _num(getattr(row, campo, 0)), hist_values, cargo_values, unit_values)
                if a:
                    anomalias.append(a)

            if anomalias:
                patterns.append({
                    "kind": "servidor",
                    "level": _pattern_level(anomalias),
                    "fechamento_id": fechamento.id,
                    "unit_id": fechamento.unit_id,
                    "unit_name": fechamento.unit.name if fechamento.unit else "—",
                    "competence": fechamento.competence,
                    "matricula": matricula,
                    "nome": row.nome,
                    "cargo": row.cargo,
                    "historico_meses": len(historicos_row),
                    "message": f"{row.nome} apresentou comportamento diferente do próprio histórico em {len(anomalias)} indicador(es).",
                    "anomalies": anomalias,
                })

        # Padrão coletivo: compara os totais atuais da unidade com a média das últimas competências.
        if len(historicos_unidade) >= 2:
            atuais_totais = _totais(current_rows)
            for campo in ("he", "bh", "an"):
                medias = [_totais(old.rows or [])[campo] for old in historicos_unidade[:6]]
                media = mean(medias) if medias else 0
                if media >= 10 and atuais_totais[campo] >= media * 2:
                    unit_patterns.append({
                        "kind": "unidade",
                        "level": "attention" if atuais_totais[campo] >= media * 3 else "review",
                        "fechamento_id": fechamento.id,
                        "unit_id": fechamento.unit_id,
                        "unit_name": fechamento.unit.name if fechamento.unit else "—",
                        "competence": fechamento.competence,
                        "field": campo,
                        "label": LABELS[campo],
                        "current": atuais_totais[campo],
                        "historical_mean": round(media, 2),
                        "ratio": round(atuais_totais[campo] / media, 2),
                        "message": f"O total de {LABELS[campo]} da unidade está acima da média das últimas competências.",
                    })

        # Padrão coletivo de servidores: 3 ou mais pessoas do mesmo cargo com aumento do mesmo indicador.
        for campo in ("he", "bh", "an"):
            affected = []
            for p in patterns:
                if p["fechamento_id"] != fechamento.id or p["kind"] != "servidor":
                    continue
                if any(a["field"] == campo for a in p["anomalies"]):
                    affected.append(p)
            if len(affected) >= 3:
                unit_patterns.append({
                    "kind": "concentracao",
                    "level": "attention",
                    "fechamento_id": fechamento.id,
                    "unit_id": fechamento.unit_id,
                    "unit_name": fechamento.unit.name if fechamento.unit else "—",
                    "competence": fechamento.competence,
                    "field": campo,
                    "label": LABELS[campo],
                    "affected": len(affected),
                    "message": f"{len(affected)} servidores apresentaram aumento incomum de {LABELS[campo]} na mesma competência.",
                })

    patterns.extend(unit_patterns)
    patterns.sort(key=lambda p: (0 if p["level"] == "attention" else 1, _competence_key(p["competence"])), reverse=False)

    return {
        "competence": competence,
        "summary": {
            "patterns": len(patterns),
            "attention": sum(1 for p in patterns if p["level"] == "attention"),
            "review": sum(1 for p in patterns if p["level"] == "review"),
        },
        "patterns": patterns[:300],
        "units": sorted({p["unit_name"] for p in patterns}),
        "method": {
            "name": "Detecção estatística de padrões",
            "history_window": "até 12 competências anteriores por unidade",
            "minimum_history": 2,
            "note": "Alertas indicam comportamento fora do padrão e devem ser revisados pelo RH.",
        },
    }