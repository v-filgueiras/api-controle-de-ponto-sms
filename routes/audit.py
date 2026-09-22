from datetime import datetime, timedelta
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from database.connect import get_db
from deps import get_current_user
from models import Fechamentos, PointRows, Users, Fechamentos

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


def _auditoria_basica(rows: list[PointRows]) -> list[dict]:
    issues = []
    
    por_servidor = defaultdict(lambda: {"dias": set(), "total_extras": 0, "eventos_at": 0})
    por_dia = defaultdict(list)
    
    for row in rows:
        servidor_key = f"{row.employee_name}_{row.employee_id}"
        por_servidor[servidor_key]["dias"].add(row.date if hasattr(row, 'date') else None)
        por_servidor[servidor_key]["total_extras"] += int(row.he or 0)
        por_servidor[servidor_key]["eventos_at"] += 1 if (row.at or 0) > 0 else 0
        
        por_dia[getattr(row, 'date', None)].append(row)
    
    # Dias sem registro
    for servidor, dados in por_servidor.items():
        dias_faltantes = 20 - len(dados["dias"])
        if dias_faltantes >= 3:
            issues.append({
                "severity": "warning",
                "type": "missing_days",
                "message": f"{servidor.split('_')[0]} — {dias_faltantes} dias sem registro"
            })
    
    # Extras anormais em um dia
    for servidor, dados in por_servidor.items():
        dias_com_extras = len([r for r in rows if getattr(r, 'employee_id', None) == int(servidor.split('_')[1]) and (r.he or 0) > 10])
        if dias_com_extras > 0:
            max_extras = max([r.he for r in rows if getattr(r, 'employee_id', None) == int(servidor.split('_')[1])] or [0])
            if max_extras >= 12:
                issues.append({
                    "severity": "error",
                    "type": "abnormal_overtime",
                    "message": f"{servidor.split('_')[0]} — {max_extras}h extras em um único dia"
                })
    
    # Atestado em dia trabalhado
    for row in rows:
        if (row.at or 0) > 0 and (row.dt or 0) > 0:
            issues.append({
                "severity": "error",
                "type": "medical_cert_working_day",
                "message": f"Atestado lançado em dia já trabalhado para {row.employee_name}"
            })
    
    return issues


def _comparacao_mes_anterior(db: Session, unit_id: int, competencia: str) -> dict:
    competencia_ant = _competencia_anterior(competencia)
    
    fecha_atual = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.unit_id == unit_id,
        Fechamentos.competence == competencia
    ).first()
    
    fecha_ant = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.unit_id == unit_id,
        Fechamentos.competence == competencia_ant
    ).first()
    
    dados_atual = {
        "he": sum(r.he or 0 for r in (fecha_atual.rows if fecha_atual else [])),
        "at": sum(r.at or 0 for r in (fecha_atual.rows if fecha_atual else [])),
        "bh": sum(r.bh or 0 for r in (fecha_atual.rows if fecha_atual else [])),
        "faltas": sum(r.faltas or 0 for r in (fecha_atual.rows if fecha_atual else [])),
    }
    
    dados_ant = {
        "he": sum(r.he or 0 for r in (fecha_ant.rows if fecha_ant else [])),
        "at": sum(r.at or 0 for r in (fecha_ant.rows if fecha_ant else [])),
        "bh": sum(r.bh or 0 for r in (fecha_ant.rows if fecha_ant else [])),
        "faltas": sum(r.faltas or 0 for r in (fecha_ant.rows if fecha_ant else [])),
    }
    
    comparacoes = {}
    for chave in dados_atual:
        ant = dados_ant[chave]
        atual = dados_atual[chave]
        pct = ((atual - ant) / ant * 100) if ant > 0 else 0
        
        comparacoes[chave] = {
            "anterior": ant,
            "atual": atual,
            "variacao_percentual": round(pct, 1)
        }
    
    return comparacoes


def _padroes_suspeitos(rows: list[PointRows]) -> list[dict]:
    alertas = []
    
    # Extras em mesmo padrão
    extras_por_servidor = defaultdict(list)
    for row in rows:
        if (row.he or 0) >= 12:
            extras_por_servidor[row.employee_id].append(row.he)
    
    for servidor_id, extras in extras_por_servidor.items():
        if len(extras) >= 3 and len(set(extras)) == 1:
            alertas.append({
                "severity": "warning",
                "type": "repetitive_pattern",
                "message": f"🔴 {len(extras)} servidores com exatamente {extras[0]}h extras durante {len(extras)} dias consecutivos."
            })
    
    # Registros no último dia
    ultimos_registros = sum(1 for r in rows if hasattr(r, 'created_at') and (datetime.now() - r.created_at).days < 1)
    if ultimos_registros > 0:
        alertas.append({
            "severity": "warning",
            "type": "late_submission",
            "message": f"🟡 {ultimos_registros} registros lançados no último dia antes do fechamento."
        })
    
    return alertas


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
        raise HTTPException(status_code=404, detail="Fechamento não encontrado")
    
    if user.perfil == "coordinator" and user.unit_id != fechamento.unit_id:
        raise HTTPException(status_code=403, detail="Sem acesso")
    
    rows = fechamento.rows or []
    
    return {
        "fechamento_id": fechamento_id,
        "inconsistencias": _auditoria_basica(rows),
        "comparacao_mes_anterior": _comparacao_mes_anterior(db, fechamento.unit_id, fechamento.competence),
        "padroes_suspeitos": _padroes_suspeitos(rows),
    }