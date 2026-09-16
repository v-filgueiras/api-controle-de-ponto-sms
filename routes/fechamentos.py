import os
import shutil
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from database.connect import get_db
from deps import get_current_user, require_role
from models import Fechamentos, Documents, EditRequests, PointRows, Units, Users, HistoryLog
from schemas.fechamentos import DecisionIn, FechamentoOut, FechamentoRowsUpdate, FechamentoSubmit

router = APIRouter(tags=["fechamentos"])

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")

MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
]


def competencia_atual() -> str:
    agora = datetime.now()
    return f"{MESES[agora.month - 1]}/{agora.year}"


def registrar_historico(db: Session, user: Users, action: str, fechamento: Fechamentos):
    db.add(HistoryLog(
        user_id=user.id,
        action=action,
        fechamento_id=fechamento.id,
        unit_id=fechamento.unit_id,
        status_snapshot=fechamento.status,
    ))


def _checar_acesso_unidade(user: Users, unit_id: int):
    if user.perfil == "coordinator" and user.unit_id != unit_id:
        raise HTTPException(status_code=403, detail="Você só pode acessar a própria unidade.")


def _obter_ou_criar_fechamento(db: Session, unit_id: int) -> Fechamentos:
    competence = competencia_atual()
    fechamento = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.rows), joinedload(Fechamentos.document))
        .filter(Fechamentos.unit_id == unit_id, Fechamentos.competence == competence)
        .first()
    )
    if fechamento:
        return fechamento

    if not db.query(Units).filter(Units.id == unit_id, Units.active.is_(True)).first():
        raise HTTPException(status_code=404, detail="Unidade não encontrada ou inativa.")

    fechamento = Fechamentos(unit_id=unit_id, competence=competence, status="rascunho")
    db.add(fechamento)
    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.get("/unidades/{unit_id}/fechamento-atual", response_model=FechamentoOut)
def obter_fechamento_atual(
    unit_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    _checar_acesso_unidade(user, unit_id)
    return _obter_ou_criar_fechamento(db, unit_id)


@router.put("/fechamentos/{fechamento_id}/rows", response_model=FechamentoOut)
def atualizar_linhas(
    fechamento_id: int,
    payload: FechamentoRowsUpdate,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    if fechamento.status in ("pendente", "aprovado"):
        raise HTTPException(status_code=409, detail="Este fechamento está bloqueado para edição.")

    db.query(PointRows).filter(PointRows.fechamento_id == fechamento_id).delete()
    for linha in payload.rows:
        db.add(PointRows(fechamento_id=fechamento_id, **linha.model_dump()))

    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.post("/fechamentos/{fechamento_id}/documento", response_model=FechamentoOut)
def enviar_documento(
    fechamento_id: int,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    fechamento = db.query(Fechamentos).filter(Fechamentos.id == fechamento_id).first()
    if not fechamento:
        raise HTTPException(status_code=404, detail="Fechamento não encontrado.")
    _checar_acesso_unidade(user, fechamento.unit_id)
    if fechamento.status in ("pendente", "aprovado"):
        raise HTTPException(status_code=409, detail="Este fechamento está bloqueado para edição.")
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=422, detail="Apenas arquivos PDF são aceitos.")

    pasta = os.path.join(UPLOAD_DIR, str(fechamento.unit_id), fechamento.competence.replace("/", "-"))
    os.makedirs(pasta, exist_ok=True)
    caminho = os.path.join(pasta, file.filename)
    with open(caminho, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    documento = Documents(
        filename=file.filename,
        storage_path=caminho,
        mime_type=file.content_type,
        size_bytes=os.path.getsize(caminho),
        uploaded_by_id=user.id,
    )
    db.add(documento)
    db.flush()  # gera documento.id sem precisar commitar ainda

    fechamento.document_id = documento.id
    db.commit()
    db.refresh(fechamento)
    return fechamento


@router.post("/fechamentos/{fechamento_id}/submeter", response_model=FechamentoOut)
def submeter_fechamento(
    fechamento_id: int,
    payload: FechamentoSubmit,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
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
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("admin", "rh")),
):
    query = db.query(Fechamentos).options(joinedload(Fechamentos.rows), joinedload(Fechamentos.document))
    query = query.filter(Fechamentos.status != "rascunho")
    if status:
        query = query.filter(Fechamentos.status == status)
    return query.all()


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
    payload.validar_nota_obrigatoria()

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


def edit_request_to_dict(req: EditRequests, db: Session):
    fechamento = (
        db.query(Fechamentos)
        .options(joinedload(Fechamentos.unit))
        .filter(Fechamentos.id == req.fechamento_id)
        .first()
    )
    requester = db.query(Users).filter(Users.id == req.requested_by_id).first()
    decided_by = (
        db.query(Users).filter(Users.id == req.decided_by_id).first()
        if req.decided_by_id
        else None
    )

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

    return edit_request_to_dict(req, db)


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

    return edit_request_to_dict(req, db) if req else None


@router.get("/solicitacoes-edicao")
def listar_solicitacoes_edicao(
    status: str | None = None,
    db: Session = Depends(get_db),
    _: Users = Depends(require_role("rh")),
):
    query = db.query(EditRequests)

    if status:
        query = query.filter(EditRequests.status == status)

    requests = query.order_by(EditRequests.created_at.desc()).all()
    return [edit_request_to_dict(req, db) for req in requests]


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