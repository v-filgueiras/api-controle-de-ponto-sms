import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from database.connect import get_db
from deps import get_current_user
from models import Documents, Fechamentos, Users
from schemas.documents import DocumentOut

router = APIRouter(prefix="/documentos", tags=["documentos"])


def _documento_com_acesso(document_id: int, db: Session, user: Users) -> Documents:
    documento = db.query(Documents).filter(Documents.id == document_id).first()
    if not documento:
        raise HTTPException(status_code=404, detail="Documento não encontrado.")

    if user.perfil == "coordinator":
        fechamento = (
            db.query(Fechamentos)
            .filter(
                Fechamentos.document_id == document_id,
                Fechamentos.unit_id == user.unit_id,
            )
            .first()
        )
        if not fechamento:
            raise HTTPException(status_code=403, detail="Você não tem acesso a este documento.")

    return documento


@router.get("/{document_id}", response_model=DocumentOut)
def obter_documento(
    document_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    return _documento_com_acesso(document_id, db, user)


@router.get("/{document_id}/download")
def baixar_documento(
    document_id: int,
    db: Session = Depends(get_db),
    user: Users = Depends(get_current_user),
):
    documento = _documento_com_acesso(document_id, db, user)
    if not os.path.isfile(documento.storage_path):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado no armazenamento.")

    return FileResponse(
        path=documento.storage_path,
        media_type=documento.mime_type,
        filename=documento.filename,
    )
