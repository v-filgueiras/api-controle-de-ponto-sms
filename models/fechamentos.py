from database.connect import Base
from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, CheckConstraint, UniqueConstraint
from sqlalchemy.orm import relationship

class Fechamentos(Base):
    __tablename__ = "fechamentos"

    id = Column(Integer, primary_key=True)
    unit_id = Column(Integer, ForeignKey("units.id"), nullable=False)
    competence = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, default="rascunho")
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=True)
    signature_method = Column(String(20), nullable=True)
    submitted_at = Column(DateTime, nullable=True)
    submitted_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    rh_note = Column(Text, nullable=True)
    rh_decision_at = Column(DateTime, nullable=True)
    rh_decision_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        UniqueConstraint("unit_id", "competence", name="uq_fechamento_unidade_competencia"),
        CheckConstraint(
            "status IN ('rascunho','pendente','aprovado','correcao','rejeitado','nao_enviado')",
            name="ck_fechamento_status"
        ),
        CheckConstraint(
            "signature_method IN ('govbr','certificado','manual','outro')",
            name="ck_fechamento_signature_method"
        ),
    )

    unit = relationship("Units", back_populates="fechamentos")
    document = relationship("Documents")
    submitted_by = relationship("Users", foreign_keys=[submitted_by_id])
    rh_decision_by = relationship("Users", foreign_keys=[rh_decision_by_id])
    rows = relationship("PointRows", back_populates="fechamento", cascade="all, delete-orphan")
    edit_requests = relationship("EditRequests", back_populates="fechamento", cascade="all, delete-orphan")