from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from schemas.documents import DocumentOut
from schemas.point_rows import PointRowIn, PointRowOut

Status = Literal["rascunho", "pendente", "aprovado", "correcao", "rejeitado", "nao_enviado"]
FormaAssinatura = Literal["govbr", "certificado", "manual", "outro"]

class FechamentoOut(BaseModel):
    id: int
    unit_id: int
    competence: str
    status: str
    document: Optional[DocumentOut]
    signature_method: Optional[str]
    submitted_at: Optional[datetime]
    rh_note: Optional[str]
    rh_decision_at: Optional[datetime]
    rows: List[PointRowOut]

    class Config:
        from_attributes = True

class FechamentoRowsUpdate(BaseModel):
    rows: List[PointRowIn] = Field(min_length=1)

class FechamentoSubmit(BaseModel):
    signature_method: FormaAssinatura

class DecisionIn(BaseModel):
    decision: Literal["approved", "correction", "rejected"]
    note: Optional[str] = None

    def validar_nota_obrigatoria(self):
        if self.decision != "approved" and not (self.note and self.note.strip()):
            raise ValueError("A observação é obrigatória para correção ou rejeição.")