from collections import defaultdict
from statistics import mean, stdev, median
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from database.connect import get_db
from deps import require_role
from models import Fechamentos, PointRows, Users

router = APIRouter(prefix="/auditoria-ia", tags=["auditoria-ia"])

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]


def _calcular_zscore(valor, media, desvio):
    """Calcula Z-score para detecção de anomalias"""
    if desvio == 0:
        return 0
    return (valor - media) / desvio


def _analisar_padroes_servidor(rows_servidor: list[PointRows]) -> dict:
    """Análise profunda de um único servidor"""
    
    if not rows_servidor:
        return {}
    
    # Extrair métricas
    he_valores = [r.he or 0 for r in rows_servidor]
    at_valores = [r.at or 0 for r in rows_servidor]
    bh_valores = [r.bh or 0 for r in rows_servidor]
    dt_valores = [r.dt or 0 for r in rows_servidor]
    faltas_valores = [r.faltas or 0 for r in rows_servidor]
    
    # Estatísticas básicas
    stats = {}
    for nome, valores in {
        'he': he_valores,
        'at': at_valores,
        'bh': bh_valores,
        'dt': dt_valores,
        'faltas': faltas_valores
    }.items():
        if valores:
            media = mean(valores)
            desvio = stdev(valores) if len(valores) > 1 else 0
            mediana = median(valores)
            
            stats[nome] = {
                'media': round(media, 2),
                'mediana': round(mediana, 2),
                'desvio_padrao': round(desvio, 2),
                'min': min(valores),
                'max': max(valores),
                'total': sum(valores),
            }
    
    # Detectar anomalias (Z-score > 2.5)
    anomalias = []
    
    for i, row in enumerate(rows_servidor):
        for metrica in ['he', 'at', 'dt']:
            valores = {'he': he_valores, 'at': at_valores, 'dt': dt_valores}[metrica]
            valor = valores[i]
            
            if valor == 0 or metrica not in stats:
                continue
            
            s = stats[metrica]
            z = _calcular_zscore(valor, s['media'], s['desvio_padrao'])
            
            if abs(z) > 2.5:
                anomalias.append({
                    'dia': i + 1,
                    'metrica': metrica,
                    'valor': valor,
                    'media': s['media'],
                    'zscore': round(z, 2),
                    'severidade': 'crítica' if abs(z) > 3.5 else 'alta'
                })
    
    # Padrão de comportamento
    padrao = _classificar_padrao(he_valores, at_valores, dt_valores, faltas_valores)
    
    # Risco individual
    risco = _calcular_risco_servidor(stats, anomalias, padrao)
    
    return {
        'estatisticas': stats,
        'anomalias': anomalias,
        'padrao': padrao,
        'risco': risco,
        'dias_com_dados': len(rows_servidor)
    }


def _classificar_padrao(he, at, dt, faltas):
    """Classifica tipo de comportamento do servidor"""
    
    média_he = mean(he) if he else 0
    média_at = mean(at) if at else 0
    média_faltas = mean(faltas) if faltas else 0
    
    tipos = []
    
    if média_he > 5:
        tipos.append("trabalhador_extra")
    
    if média_at > 1:
        tipos.append("frequente_atestado")
    
    if média_faltas > 0.5:
        tipos.append("faltas_comuns")
    
    if len(he) > 0 and len([x for x in he if x > 0]) > len(he) * 0.8:
        tipos.append("extras_constantes")
    
    if len(at) > 0 and sum(1 for x in at if x > 0) > len(at) * 0.5:
        tipos.append("atestados_concentrados")
    
    if not tipos:
        tipos.append("comportamento_normal")
    
    return tipos


def _calcular_risco_servidor(stats: dict, anomalias: list, padrao: list) -> dict:
    """Calcula score de risco para um servidor"""
    
    score = 0
    avisos = []
    
    # Anomalias
    score += len([a for a in anomalias if a['severidade'] == 'crítica']) * 15
    score += len([a for a in anomalias if a['severidade'] == 'alta']) * 8
    
    if len(anomalias) > 3:
        avisos.append(f"{len(anomalias)} anomalias detectadas")
    
    # Horas extras acima do normal
    if 'he' in stats and stats['he']['media'] > 8:
        score += 10
        avisos.append(f"Média de {stats['he']['media']}h extras/mês")
    
    # Variabilidade alta
    if 'he' in stats and stats['he']['desvio_padrao'] > stats['he']['media']:
        score += 5
        avisos.append("Padrão de horas extras muito irregular")
    
    # Atestados concentrados
    if 'at' in stats and stats['at']['total'] > 10:
        score += 8
        avisos.append(f"{int(stats['at']['total'])} dias de atestado")
    
    # Padrão suspeito
    if "atestados_concentrados" in padrao:
        score += 5
        avisos.append("Atestados tendem a se concentrar")
    
    if "faltas_comuns" in padrao:
        score += 7
        avisos.append("Faltas frequentes")
    
    score = min(100, score)
    
    return {
        'score': score,
        'nivel': 'baixo' if score < 20 else 'médio' if score < 50 else 'alto',
        'avisos': avisos
    }


def _agrupar_servidores_similares(rows_por_servidor: dict) -> list[dict]:
    """Agrupa servidores com comportamento similar"""
    
    grupos = defaultdict(list)
    
    for servidor_id, rows in rows_por_servidor.items():
        if not rows:
            continue
        
        # Calcular assinatura
        he_media = mean([r.he or 0 for r in rows]) if rows else 0
        at_total = sum([r.at or 0 for r in rows]) if rows else 0
        
        if he_media > 8 and at_total < 2:
            grupo = "trabalhadores_extras"
        elif at_total > 8:
            grupo = "atestados_frequentes"
        elif sum(1 for r in rows if r.faltas) > len(rows) * 0.3:
            grupo = "com_faltas"
        else:
            grupo = "normal"
        
        grupos[grupo].append({
            'servidor_id': servidor_id,
            'he_media': round(he_media, 1),
            'at_total': at_total
        })
    
    resultado = []
    for grupo_nome, servidores in grupos.items():
        resultado.append({
            'tipo': grupo_nome,
            'quantidade': len(servidores),
            'servidores': servidores
        })
    
    return resultado


@router.get("/fechamentos/{fechamento_id}/analise-profunda")
def analise_profunda_ia(
    fechamento_id: int,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh", "admin", "coordinator")),
):
    """Análise profunda com IA para cada servidor"""
    
    fechamento = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.id == fechamento_id
    ).first()
    
    if not fechamento:
        raise HTTPException(status_code=404)
    
    rows = fechamento.rows or []
    
    # Agrupar por servidor
    por_servidor = defaultdict(list)
    for row in rows:
        por_servidor[row.employee_id].append(row)
    
    # Analisar cada servidor
    analises = {}
    servidores_risco_alto = []
    
    for servidor_id, rows_srv in por_servidor.items():
        row_exemplo = rows_srv[0]
        analise = _analisar_padroes_servidor(rows_srv)
        analises[row_exemplo.employee_name] = analise
        
        if analise.get('risco', {}).get('score', 0) >= 50:
            servidores_risco_alto.append({
                'servidor': row_exemplo.employee_name,
                'score': analise['risco']['score'],
                'avisos': analise['risco']['avisos']
            })
    
    # Agrupar similares
    grupos = _agrupar_servidores_similares(por_servidor)
    
    # Recomendações
    recomendacoes = _gerar_recomendacoes(
        servidores_risco_alto,
        grupos,
        len(por_servidor)
    )
    
    return {
        'fechamento_id': fechamento_id,
        'competence': fechamento.competence,
        'total_servidores': len(por_servidor),
        'servidores_risco_alto': sorted(
            servidores_risco_alto,
            key=lambda x: x['score'],
            reverse=True
        ),
        'grupos_comportamento': grupos,
        'analise_servidores': analises,
        'recomendacoes': recomendacoes,
    }


def _gerar_recomendacoes(risco_alto: list, grupos: list, total: int) -> list[dict]:
    """Gera recomendações baseadas nas análises"""
    
    rec = []
    
    # Risco alto
    if len(risco_alto) > 0:
        pct = (len(risco_alto) / total) * 100
        rec.append({
            'tipo': 'revisar_servidores',
            'prioridade': 'alta',
            'mensagem': f"{len(risco_alto)} servidores ({pct:.0f}%) com padrões anormais",
            'acao': 'Revisar manualmente antes de aprovar'
        })
    
    # Grupo de atestados
    grupo_at = next((g for g in grupos if g['tipo'] == 'atestados_frequentes'), None)
    if grupo_at and grupo_at['quantidade'] > 2:
        rec.append({
            'tipo': 'monitorar_atestados',
            'prioridade': 'média',
            'mensagem': f"{grupo_at['quantidade']} servidores com atestados frequentes",
            'acao': 'Solicitar comprovação de atestados médicos'
        })
    
    # Grupo de extras
    grupo_he = next((g for g in grupos if g['tipo'] == 'trabalhadores_extras'), None)
    if grupo_he and grupo_he['quantidade'] > 3:
        rec.append({
            'tipo': 'revisar_demanda',
            'prioridade': 'média',
            'mensagem': f"{grupo_he['quantidade']} servidores com muitas horas extras",
            'acao': 'Avaliar se há sobrecarga de trabalho na unidade'
        })
    
    # Achados gerais
    if len(risco_alto) == 0:
        rec.append({
            'tipo': 'aprovacao_rapida',
            'prioridade': 'baixa',
            'mensagem': 'Nenhuma anomalia crítica detectada',
            'acao': 'Pode aprovar fechamento com confiança'
        })
    
    return rec


@router.get("/unidade/{unit_id}/tendencias")
def tendencias_unidade(
    unit_id: int,
    meses: int = 6,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh", "admin")),
):
    """Identifica tendências e padrões ao longo de meses"""
    
    fechamentos = db.query(Fechamentos).options(joinedload(Fechamentos.rows)).filter(
        Fechamentos.unit_id == unit_id
    ).all()
    
    tendencias = defaultdict(lambda: {
        'meses': [],
        'he_media': [],
        'at_total': [],
        'faltas_total': [],
        'servidores_com_problema': []
    })
    
    for fecha in fechamentos[-meses:]:
        rows = fecha.rows or []
        
        if rows:
            he_m = mean([r.he or 0 for r in rows])
            at_t = sum([r.at or 0 for r in rows])
            faltas_t = sum([r.faltas or 0 for r in rows])
            
            tendencias['geral']['meses'].append(fecha.competence)
            tendencias['geral']['he_media'].append(round(he_m, 1))
            tendencias['geral']['at_total'].append(at_t)
            tendencias['geral']['faltas_total'].append(faltas_t)
    
    # Calcular tendência (aumento/diminuição)
    def calcular_tendencia(valores):
        if len(valores) < 2:
            return 0
        return round((valores[-1] - valores[0]) / valores[0] * 100 if valores[0] != 0 else 0, 1)
    
    return {
        'unit_id': unit_id,
        'periodo_meses': meses,
        'dados': {
            'meses': tendencias['geral']['meses'],
            'he_media': tendencias['geral']['he_media'],
            'at_total': tendencias['geral']['at_total'],
            'faltas_total': tendencias['geral']['faltas_total'],
        },
        'tendencias': {
            'he_media': calcular_tendencia(tendencias['geral']['he_media']),
            'at_total': calcular_tendencia(tendencias['geral']['at_total']),
            'faltas_total': calcular_tendencia(tendencias['geral']['faltas_total']),
        }
    }