from datetime import datetime

from database.connect import Base
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship


class EditRequests(Base):
    __tablename__ = "edit_requests"

    id = Column(Integer, primary_key=True)
    fechamento_id = Column(
        Integer,
        ForeignKey("fechamentos.id", ondelete="CASCADE"),
        nullable=False,
    )
    requested_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    reason = Column(Text, nullable=False)

    status = Column(String(20), nullable=False, default="pendente")
    decided_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    decision_note = Column(Text, nullable=True)
    decided_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.now)

    fechamento = relationship("Fechamentos", back_populates="edit_requests")
    requested_by = relationship("Users", foreign_keys=[requested_by_id])
    decided_by = relationship("Users", foreign_keys=[decided_by_id])