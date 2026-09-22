from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from database.connect import get_db
from deps import get_current_user, require_role
from models import Fechamentos, PointRows, Users

router = APIRouter(prefix="/auditoria", tags=["auditoria"])

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]


@router.get("/dashboard")
def dashboard_auditoria(
    mes: str | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh", "admin")),
):
    """Dashboard de auditoria com problemas em todas as unidades"""
    
    if not mes:
        agora = datetime.now()
        mes = f"{MESES[agora.month - 1]}/{agora.year}"
    
    # Todos os fechamentos do mês
    fechamentos = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.competence == mes
    ).all()
    
    problemas_por_unit = {}
    servidores_problematicos = []
    
    for fechamento in fechamentos:
        unit_id = fechamento.unit_id
        rows = fechamento.rows or []
        
        problemas = _contar_problemas(rows)
        
        if any(problemas.values()):
            problemas_por_unit[unit_id] = {
                "unit_id": unit_id,
                "competence": fechamento.competence,
                "status": fechamento.status,
                **problemas
            }
        
        # Servidores com mais de 2 problemas
        servidor_probs = _problemas_por_servidor(rows)
        for servidor, count in servidor_probs.items():
            if count >= 2:
                servidores_problematicos.append({
                    "unit_id": unit_id,
                    "servidor": servidor,
                    "problemas": count
                })
    
    return {
        "mes": mes,
        "total_unidades": len(fechamentos),
        "unidades_com_problemas": len(problemas_por_unit),
        "problemas_por_unidade": list(problemas_por_unit.values()),
        "servidores_problematicos": sorted(
            servidores_problematicos,
            key=lambda x: x["problemas"],
            reverse=True
        )[:10],
    }


def _contar_problemas(rows):
    """Conta tipos de problemas em uma lista de registros"""
    problemas = {
        "dias_faltantes": 0,
        "extras_anormais": 0,
        "conflitos_at": 0,
        "banco_negativo": 0,
    }
    
    por_servidor = {}
    for row in rows:
        key = row.employee_id
        if key not in por_servidor:
            por_servidor[key] = {"registros": 0, "he": 0, "at": 0, "dt": 0, "bh": 0}
        
        por_servidor[key]["registros"] += 1
        por_servidor[key]["he"] += row.he or 0
        por_servidor[key]["at"] += row.at or 0
        por_servidor[key]["dt"] += row.dt or 0
        por_servidor[key]["bh"] += row.bh or 0
    
    # Dias faltantes
    for _, dados in por_servidor.items():
        if dados["registros"] < 18:
            problemas["dias_faltantes"] += 1
    
    # Extras anormais
    for row in rows:
        if (row.he or 0) >= 12:
            problemas["extras_anormais"] += 1
    
    # Conflitos AT
    for row in rows:
        if (row.at or 0) > 0 and (row.dt or 0) > 0:
            problemas["conflitos_at"] += 1
    
    # Banco negativo
    for _, dados in por_servidor.items():
        if dados["bh"] < -10:
            problemas["banco_negativo"] += 1
    
    return problemas


def _problemas_por_servidor(rows):
    """Conta problemas por servidor"""
    probs = {}
    
    for row in rows:
        if row.employee_name not in probs:
            probs[row.employee_name] = 0
        
        if (row.he or 0) >= 12:
            probs[row.employee_name] += 1
        
        if (row.at or 0) > 0 and (row.dt or 0) > 0:
            probs[row.employee_name] += 1
    
    return probs


@router.post("/fechamentos/{fechamento_id}/exportar")
def exportar_auditoria(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    """Exporta relatório de auditoria em formato JSON/CSV"""
    
    fechamento = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.id == fechamento_id
    ).first()
    
    if not fechamento:
        raise HTTPException(status_code=404)
    
    if user.perfil == "coordinator" and user.unit_id != fechamento.unit_id:
        raise HTTPException(status_code=403)
    
    rows = fechamento.rows or []
    problemas = _contar_problemas(rows)
    
    export_data = {
        "fechamento_id": fechamento_id,
        "competence": fechamento.competence,
        "unit_id": fechamento.unit_id,
        "status": fechamento.status,
        "data_geracao": datetime.now().isoformat(),
        "total_servidores": len(set(r.employee_id for r in rows)),
        "problemas_encontrados": problemas,
        "detalhes": []
    }
    
    for row in rows:
        export_data["detalhes"].append({
            "servidor": row.employee_name,
            "dt": row.dt,
            "he": row.he,
            "at": row.at,
            "bh": row.bh,
            "faltas": row.faltas,
        })
    
    return export_data


@router.get("/historico-problemas")
def historico_problemas(
    unit_id: int | None = None,
    meses: int = 6,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh", "admin")),
):
    """Histórico de problemas nos últimos N meses"""
    
    from datetime import datetime, timedelta
    
    agora = datetime.now()
    data_inicio = agora - timedelta(days=30 * meses)
    
    fechamentos = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).all()
    
    historico = {}
    
    for f in fechamentos:
        if unit_id and f.unit_id != unit_id:
            continue
        
        problemas = _contar_problemas(f.rows or [])
        total = sum(problemas.values())
        
        if total > 0:
            mes_key = f.competence
            if mes_key not in historico:
                historico[mes_key] = {
                    "mes": mes_key,
                    "total_problemas": 0,
                    "detalhes": {}
                }
            
            historico[mes_key]["total_problemas"] += total
            
            for tipo, count in problemas.items():
                if tipo not in historico[mes_key]["detalhes"]:
                    historico[mes_key]["detalhes"][tipo] = 0
                historico[mes_key]["detalhes"][tipo] += count
    
    return {
        "periodo_meses": meses,
        "historico": sorted(historico.values(), key=lambda x: x["mes"])
    }