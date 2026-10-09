import os
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from config import MESES, UPLOAD_DIR
from database.connect import get_db
from deps import get_current_user, require_role
from history import registrar_evento
from models import Fechamentos, Documents, EditRequests, PointRows, Units, Users
from schemas.fechamentos import DecisionIn, FechamentoOut, FechamentoRowsUpdate, FechamentoSubmit

router = APIRouter(tags=["fechamentos"])

# Limite de tamanho para o documento de fechamento (PDF assinado).
MAX_DOCUMENT_SIZE = 15 * 1024 * 1024  # 15 MB

PDF_MAGIC_BYTES = b"%PDF-"


def competencia_atual() -> str:
    agora = datetime.now()
    return f"{MESES[agora.month - 1]}/{agora.year}"


def registrar_historico(db: Session, user: Users, action: str, fechamento: Fechamentos):
    registrar_evento(db, user.id, action, fechamento=fechamento)


def _checar_acesso_unidade(user: Users, unit_id: int):
    if user.perfil == "coordinator" and user.unit_id != unit_id:
        raise HTTPException(status_code=403, detail="Você só pode acessar a própria unidade.")


def _buscar_fechamento_atual(db: Session, unit_id: int, competence: str) -> Fechamentos | None:
    return (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.document))
        .filter(Fechamentos.unit_id == unit_id, Fechamentos.competence == competence)
        .first()
    )


def _obter_fechamento_atual(db: Session, unit_id: int, criar: bool) -> Fechamentos:
    """Devolve o fechamento da competência atual.

    Só cria o rascunho quando `criar` é verdadeiro (coordenador da própria
    unidade); para os demais perfis a consulta nunca grava nada.
    """
    competence = competencia_atual()
    fechamento = _buscar_fechamento_atual(db, unit_id, competence)
    if fechamento:
        return fechamento

    if not criar:
        raise HTTPException(
            status_code=404,
            detail="A unidade ainda não iniciou o fechamento desta competência.",
        )

    if not db.query(Units).filter(Units.id == unit_id, Units.active.is_(True)).first():
        raise HTTPException(status_code=404, detail="Unidade não encontrada ou inativa.")

    db.add(Fechamentos(unit_id=unit_id, competence=competence, status="rascunho"))
    try:
        db.commit()
    except IntegrityError:
        # Outra requisição criou o mesmo fechamento ao mesmo tempo
        # (constraint única unit_id + competence): usa o que já existe.
        db.rollback()

    return _buscar_fechamento_atual(db, unit_id, competence)


@router.get("/unidades/{unit_id}/fechamento-atual", response_model=FechamentoOut)
def obter_fechamento_atual(
    unit_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    _checar_acesso_unidade(user, unit_id)
    return _obter_fechamento_atual(db, unit_id, criar=user.perfil == "coordinator")


_CAMPOS_LINHA = (
    "nome", "cargo", "periodo", "dt", "bh", "he", "an", "gr", "ins", "at", "faltas", "observacao"
)


def _resumir_alteracao_linhas(linhas_atuais, novas: list[dict]) -> str:
    antes = {l.matricula: {c: getattr(l, c) for c in _CAMPOS_LINHA} for l in linhas_atuais}
    depois = {n["matricula"]: {c: n[c] for c in _CAMPOS_LINHA} for n in novas}

    incluidos = len(depois.keys() - antes.keys())
    removidos = len(antes.keys() - depois.keys())
    alterados = sum(1 for m in depois.keys() & antes.keys() if depois[m] != antes[m])

    return f"{len(novas)} servidor(es): +{incluidos} -{removidos} ~{alterados}"


@router.put("/fechamentos/{fechamento_id}/rows", response_model=FechamentoOut)
def atualizar_linhas(
    fechamento_id: int,
    payload: FechamentoRowsUpdate,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator")),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    if fechamento.status in ("pendente", "aprovado"):
        raise HTTPException(status_code=409, detail="Este fechamento está bloqueado para edição.")

    novas = [linha.model_dump() for linha in payload.rows]
    resumo = _resumir_alteracao_linhas(fechamento.rows, novas)

    db.query(PointRows).filter(PointRows.fechamento_id == fechamento_id).delete()
    for linha in novas:
        db.add(PointRows(fechamento_id=fechamento_id, **linha))

    registrar_historico(db, user, f"Atualizou linhas do ponto ({resumo})", fechamento)
    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.post("/fechamentos/{fechamento_id}/documento", response_model=FechamentoOut)
async def enviar_documento(
    fechamento_id: int,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator")),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    if fechamento.status in ("pendente", "aprovado"):
        raise HTTPException(status_code=409, detail="Este fechamento está bloqueado para edição.")
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=422, detail="Apenas arquivos PDF são aceitos.")

    conteudo = await file.read(MAX_DOCUMENT_SIZE + 1)

    if not conteudo:
        raise HTTPException(status_code=422, detail="O arquivo enviado está vazio.")

    if len(conteudo) > MAX_DOCUMENT_SIZE:
        raise HTTPException(status_code=413, detail="O documento deve ter no máximo 15 MB.")

    if not conteudo.startswith(PDF_MAGIC_BYTES):
        raise HTTPException(
            status_code=422,
            detail="O conteúdo do arquivo não corresponde a um PDF válido.",
        )

    # Nome original só é preservado como metadado (exibição/download). O
    # nome físico em disco é sempre gerado pelo servidor para evitar path
    # traversal ou sobrescrita de arquivos a partir de um filename malicioso
    # vindo do cliente.
    nome_original = os.path.basename(file.filename or "documento.pdf")
    nome_seguro = f"{uuid.uuid4().hex}.pdf"

    pasta = os.path.join(UPLOAD_DIR, str(fechamento.unit_id), fechamento.competence.replace("/", "-"))
    os.makedirs(pasta, exist_ok=True)
    caminho = os.path.join(pasta, nome_seguro)
    with open(caminho, "wb") as buffer:
        buffer.write(conteudo)

    documento = Documents(
        filename=nome_original,
        storage_path=caminho,
        mime_type=file.content_type,
        size_bytes=len(conteudo),
        uploaded_by_id=user.id,
    )
    db.add(documento)
    db.flush()  # gera documento.id sem precisar commitar ainda

    substituiu = fechamento.document_id
    fechamento.document_id = documento.id
    registrar_historico(
        db,
        user,
        "Anexou documento assinado"
        + (f" (substituiu o documento #{substituiu})" if substituiu else ""),
        fechamento,
    )
    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.post("/fechamentos/{fechamento_id}/submeter", response_model=FechamentoOut)
def submeter_fechamento(
    fechamento_id: int,
    payload: FechamentoSubmit,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator")),
):
    fechamento = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows))
        .filter(Fechamentos.id == fechamento_id)
        .first()
    )
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    if fechamento.status not in ("rascunho", "correcao", "rejeitado"):
        raise HTTPException(status_code=409, detail="Este fechamento não pode ser submetido neste status.")
    if not fechamento.rows:
        raise HTTPException(status_code=422, detail="Adicione ao menos um servidor antes de submeter.")
    if not fechamento.document_id:
        raise HTTPException(status_code=422, detail="Anexe o documento assinado antes de submeter.")

    fechamento.status = "pendente"
    fechamento.signature_method = payload.signature_method
    fechamento.submitted_at = datetime.now()
    fechamento.submitted_by_id = user.id
    fechamento.rh_note = None

    registrar_historico(db, user, "Submeteu fechamento", fechamento)
    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.get("/aprovacoes", response_model=list[FechamentoOut])
def listar_aprovacoes(
    status: str | None = None,
    limit: int = 1000,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    query = db.query(Fechamentos).options(joinedload(Fechamentos.rows), joinedload(Fechamentos.document))
    query = query.filter(Fechamentos.status != "rascunho")
    if status:
        query = query.filter(Fechamentos.status == status)
    limit = max(1, min(limit, 2000))
    return query.order_by(Fechamentos.id.desc()).offset(max(0, offset)).limit(limit).all()


@router.get("/fechamentos/{fechamento_id}", response_model=FechamentoOut)
def obter_fechamento(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.document))
        .filter(Fechamentos.id == fechamento_id)
        .first()
    )
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    return fechamento


@router.post("/fechamentos/{fechamento_id}/decisao", response_model=FechamentoOut)
def decidir_fechamento(
    fechamento_id: int,
    payload: DecisionIn,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("admin", "rh")),
):
    try:
        payload.validar_nota_obrigatoria()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    if fechamento.status != "pendente":
        raise HTTPException(status_code=409, detail="Só é possível decidir fechamentos com status 'pendente'.")

    novo_status = {
        "approved": "aprovado",
        "correction": "correcao",
        "rejected": "rejeitado",
    }[payload.decision]

    fechamento.status = novo_status
    fechamento.rh_note = None if payload.decision == "approved" else payload.note
    fechamento.rh_decision_at = datetime.now()
    fechamento.rh_decision_by_id = user.id

    acao = {
        "approved": "Aprovou fechamento",
        "correction": "Solicitou correção",
        "rejected": "Rejeitou fechamento",
    }[payload.decision]
    registrar_historico(db, user, acao, fechamento)

    db.commit()
    db.refresh(fechamento)
    return fechamento
class EditRequestCreate(BaseModel):
    reason: str = Field(min_length=5, max_length=1000)


class EditRequestDecision(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str | None = Field(default=None, max_length=1000)


def edit_request_to_dict(req: EditRequests):
    fechamento = req.fechamento
    requester = req.requested_by
    decided_by = req.decided_by

    return {
        "id": req.id,
        "fechamento_id": req.fechamento_id,
        "unit_id": fechamento.unit_id if fechamento else None,
        "unit_name": fechamento.unit.name if fechamento and fechamento.unit else "—",
        "competence": fechamento.competence if fechamento else "—",
        "fechamento_status": fechamento.status if fechamento else None,
        "requested_by_id": req.requested_by_id,
        "requested_by_name": requester.name if requester else "Usuário",
        "reason": req.reason,
        "status": req.status,
        "decision_note": req.decision_note,
        "decided_by_id": req.decided_by_id,
        "decided_by_name": decided_by.name if decided_by else None,
        "created_at": req.created_at,
        "decided_at": req.decided_at,
    }


@router.post("/fechamentos/{fechamento_id}/solicitar-edicao", status_code=201)
def solicitar_edicao(
    fechamento_id: int,
    payload: EditRequestCreate,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("coordinator")),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")

    if user.unit_id is None or user.unit_id != fechamento.unit_id:
        raise HTTPException(status_code=403, detail="Você não tem acesso a este fechamento.")

    if fechamento.status not in ("pendente", "aprovado"):
        raise HTTPException(
            status_code=409,
            detail="Só é necessário solicitar edição para fechamentos enviados ou aprovados.",
        )

    pendente = (
        db.query(EditRequests)
        .filter(
            EditRequests.fechamento_id == fechamento.id,
            EditRequests.status == "pendente",
        )
        .first()
    )
    if pendente:
        raise HTTPException(
            status_code=409,
            detail="Já existe uma solicitação de edição aguardando decisão do RH.",
        )

    req = EditRequests(
        fechamento_id=fechamento.id,
        requested_by_id=user.id,
        reason=payload.reason.strip(),
        status="pendente",
    )
    db.add(req)

    registrar_historico(db, user, "Solicitou edição do fechamento", fechamento)

    db.commit()
    db.refresh(req)

    return edit_request_to_dict(req)


@router.get("/fechamentos/{fechamento_id}/solicitacao-edicao")
def obter_solicitacao_edicao_do_fechamento(
    fechamento_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")

    _checar_acesso_unidade(user, fechamento.unit_id)

    req = (
        db.query(EditRequests)
        .filter(EditRequests.fechamento_id == fechamento_id)
        .order_by(EditRequests.created_at.desc())
        .first()
    )

    return edit_request_to_dict(req) if req else None


@router.get("/solicitacoes-edicao")
def listar_solicitacoes_edicao(
    status: str | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh")),
):
    query = db.query(EditRequests).options(
        joinedload(EditRequests.fechamento).joinedload(Fechamentos.unit),
        joinedload(EditRequests.requested_by),
        joinedload(EditRequests.decided_by),
    )

    if status:
        query = query.filter(EditRequests.status == status)

    requests = query.order_by(EditRequests.created_at.desc()).all()
    return [edit_request_to_dict(req) for req in requests]


@router.post("/solicitacoes-edicao/{request_id}/decisao")
def decidir_solicitacao_edicao(
    request_id: int,
    payload: EditRequestDecision,
    db: Session = Depends(get_db),
    user: Users = Depends(require_role("rh")),
):
    req = db.query(EditRequests).filter(EditRequests.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

    if req.status != "pendente":
        raise HTTPException(status_code=409, detail="Esta solicitação já foi decidida.")

    fechamento = db.query(Fechamentos).filter(Fechamentos.id == req.fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")

    req.status = "aprovado" if payload.decision == "approved" else "rejeitado"
    req.decision_note = payload.note.strip() if payload.note else None
    req.decided_by_id = user.id
    req.decided_at = datetime.now()

    if payload.decision == "approved":
        fechamento.status = "correcao"
        fechamento.rh_note = (
            req.decision_note
            or f"Edição autorizada pelo RH. Motivo informado pelo coordenador: {req.reason}"
        )
        fechamento.rh_decision_at = datetime.now()
        fechamento.rh_decision_by_id = user.id
        registrar_historico(db, user, "Autorizou edição solicitada pelo coordenador", fechamento)
    else:
        registrar_historico(db, user, "Negou solicitação de edição do coordenador", fechamento)

    db.commit()

    return {
        "message": (
            "Edição autorizada. O fechamento foi liberado para correção."
            if payload.decision == "approved"
            else "Solicitação de edição negada."
        )
    }