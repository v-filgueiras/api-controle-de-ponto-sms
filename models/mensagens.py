from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text

from database.connect import Base


class Mensagens(Base):
    __tablename__ = "mensagens"

    id = Column(Integer, primary_key=True, index=True)
    unit_id = Column(Integer, ForeignKey("units.id"), nullable=False)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    sender_perfil = Column(String(20), nullable=False)  # "coordinator" | "rh"
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    # None = ainda não lida pelo outro lado da conversa
    read_at = Column(DateTime, nullable=True)

    __table_args__ = (Index("ix_mensagens_unit_id_id", "unit_id", "id"),)
