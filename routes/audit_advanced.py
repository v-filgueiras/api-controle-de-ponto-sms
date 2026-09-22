from datetime import datetime, timedelta
from collections import defaultdict
from statistics import mean, stdev
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from database.connect import get_db
from deps import get_current_user
from models import Fechamentos, PointRows, Users

router = APIRouter(prefix="/auditoria", tags=["auditoria"])

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]


def _competencia_anterior(competencia: str) -> str:
    partes = competencia.split("/")
    mes_idx = MESES.index(partes[0])
    ano = int(partes[1])
    if mes_idx == 0:
        return f"{MESES[11]}/{ano - 1}"
    return f"{MESES[mes_idx - 1]}/{ano}"


def _auditoria_basica(rows):
    issues = []
    por_servidor = defaultdict(lambda: {
        "dias": set(),
        "total_extras": 0,
        "total_at": 0,
        "total_bh": 0,
        "registros": []
    })
    
    for row in rows:
        key = f"{row.employee_name}_{row.employee_id}"
        por_servidor[key]["registros"].append(row)
        por_servidor[key]["total_extras"] += int(row.he or 0)
        por_servidor[key]["total_at"] += int(row.at or 0)
        por_servidor[key]["total_bh"] += int(row.bh or 0)
    
    # Dias sem registro (expectativa: 20-22 dias úteis)
    for servidor, dados in por_servidor.items():
        registros = len(dados["registros"])
        if registros < 18:
            issues.append({
                "severity": "warning",
                "employee": servidor.split('_')[0],
                "type": "missing_days",
                "message": f"{servidor.split('_')[0]} — {22 - registros} dias sem registro"
            })
    
    # Extras anormais
    for servidor, dados in por_servidor.items():
        extras = [r.he for r in dados["registros"] if r.he]
        if extras:
            max_extra = max(extras)
            if max_extra >= 12:
                issues.append({
                    "severity": "error",
                    "employee": servidor.split('_')[0],
                    "type": "abnormal_overtime",
                    "message": f"{servidor.split('_')[0]} — {max_extra}h extras em um dia"
                })
    
    # Atestado + trabalho no mesmo dia
    for row in rows:
        if (row.at or 0) > 0 and (row.dt or 0) > 0:
            issues.append({
                "severity": "error",
                "employee": row.employee_name,
                "type": "conflict",
                "message": f"Atestado + trabalho no mesmo dia para {row.employee_name}"
            })
    
    # Banco de horas negativo
    for servidor, dados in por_servidor.items():
        if dados["total_bh"] < -10:
            issues.append({
                "severity": "warning",
                "employee": servidor.split('_')[0],
                "type": "negative_bank",
                "message": f"{servidor.split('_')[0]} — Banco de horas: -{abs(dados['total_bh'])}h"
            })
    
    return issues


def _comparacao_mes_anterior(db: Session, unit_id: int, competencia: str):
    comp_ant = _competencia_anterior(competencia)
    
    f_atual = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.unit_id == unit_id, Fechamentos.competence == competencia
    ).first()
    
    f_ant = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.unit_id == unit_id, Fechamentos.competence == comp_ant
    ).first()
    
    rows_atual = f_atual.rows if f_atual else []
    rows_ant = f_ant.rows if f_ant else []
    
    metricas = {}
    for chave in ["he", "at", "bh", "faltas"]:
        atual = sum(getattr(r, chave, 0) or 0 for r in rows_atual)
        anterior = sum(getattr(r, chave, 0) or 0 for r in rows_ant)
        
        pct = 0
        if anterior > 0:
            pct = ((atual - anterior) / anterior * 100)
        
        metricas[chave] = {
            "anterior": anterior,
            "atual": atual,
            "variacao": round(pct, 1),
            "alerta": abs(pct) > 30
        }
    
    return metricas


def _padroes_suspeitos(rows):
    alertas = []
    
    # Agrupar por valor de extras
    extras_count = defaultdict(int)
    for row in rows:
        if (row.he or 0) >= 10:
            extras_count[int(row.he)] += 1
    
    for valor, count in extras_count.items():
        if count >= 3:
            alertas.append({
                "severity": "warning",
                "type": "pattern",
                "message": f"🔴 {count} registros com exatamente {valor}h extras"
            })
    
    # Servidor com muitos registros alterados
    por_servidor = defaultdict(int)
    for row in rows:
        if hasattr(row, 'updated_at') and row.updated_at:
            dias_atras = (datetime.now() - row.updated_at).days
            if dias_atras < 3:
                por_servidor[row.employee_name] += 1
    
    for servidor, count in por_servidor.items():
        if count >= 3:
            alertas.append({
                "severity": "warning",
                "type": "recent_updates",
                "message": f"🟡 {count} alterações recentes para {servidor}"
            })
    
    # Verificar concentração de registros (lançamentos em lote)
    if hasattr(rows[0], 'created_at') if rows else False:
        criadas_hoje = sum(1 for r in rows if (datetime.now() - r.created_at).days < 1)
        if criadas_hoje > len(rows) * 0.6:
            alertas.append({
                "severity": "warning",
                "type": "batch_submission",
                "message": f"🟡 {criadas_hoje} registros lançados hoje (possível lote)"
            })
    
    return alertas


def _detalhes_por_servidor(rows):
    detalhe = defaultdict(lambda: {
        "total_he": 0,
        "total_at": 0,
        "total_bh": 0,
        "total_faltas": 0,
        "dias": 0,
        "alertas": 0
    })
    
    for row in rows:
        key = row.employee_name
        detalhe[key]["total_he"] += int(row.he or 0)
        detalhe[key]["total_at"] += int(row.at or 0)
        detalhe[key]["total_bh"] += int(row.bh or 0)
        detalhe[key]["total_faltas"] += int(row.faltas or 0)
        detalhe[key]["dias"] += 1
    
    return dict(detalhe)


@router.get("/fechamentos/{fechamento_id}")
def auditar_fechamento(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.id == fechamento_id
    ).first()
    
    if not fechamento:
        raise HTTPException(status_code=404)
    
    if user.perfil == "coordinator" and user.unit_id != fechamento.unit_id:
        raise HTTPException(status_code=403)
    
    rows = fechamento.rows or []
    
    inconsistencias = _auditoria_basica(rows)
    padroes = _padroes_suspeitos(rows)
    comparacao = _comparacao_mes_anterior(db, fechamento.unit_id, fechamento.competence)
    detalhes = _detalhes_por_servidor(rows)
    
    # Score de risco
    score = 0
    score += len([i for i in inconsistencias if i["severity"] == "error"]) * 10
    score += len([i for i in inconsistencias if i["severity"] == "warning"]) * 5
    score += len(padroes) * 3
    score += sum(1 for m in comparacao.values() if m["alerta"]) * 4
    
    return {
        "fechamento_id": fechamento_id,
        "competence": fechamento.competence,
        "risk_score": min(100, score),
        "inconsistencias": inconsistencias,
        "padroes_suspeitos": padroes,
        "comparacao_mes_anterior": comparacao,
        "detalhes_servidores": detalhes,
        "total_servidores": len(detalhes),
        "total_inconsistencias": len(inconsistencias),
    }