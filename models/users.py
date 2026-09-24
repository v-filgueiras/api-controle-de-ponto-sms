from database.connect import Base
from datetime import datetime

from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, LargeBinary
from sqlalchemy.orm import relationship

class Users(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    name = Column(String(150), nullable=False)
    email = Column(String(150), nullable=False, unique=True)
    hash_passwd = Column(String(255), nullable=False)
    perfil = Column(String(20), nullable=False)  # "admin" | "rh" | "coordinator"
    unit_id = Column(Integer, ForeignKey("units.id"), nullable=True)
    status = Column(Boolean, default=True)

    # Aprovação de acesso: separada da verificação de e-mail (email_verifications)
    # e separada de "status" (que representa ativo/inativo após já aprovado).
    # "pendente" | "aprovado" | "rejeitado"
    approval_status = Column(String(20), nullable=False, default="pendente")
    approved_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)

    profile_photo = Column(LargeBinary, nullable=True)
    profile_photo_mime = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    unit = relationship("Units", back_populates="users")
    approved_by = relationship("Users", remote_side=[id])