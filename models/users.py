from database.connect import Base
from datetime import datetime

from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
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
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    unit = relationship("Units", back_populates="users")