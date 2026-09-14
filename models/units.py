from datetime import datetime
from database.connect import Base
from sqlalchemy import Column, DateTime, Integer, String
from sqlalchemy.orm import relationship

class Units(Base):
    __tablename__ = "units"

    id = Column(Integer, primary_key=True)
    name = Column(String(150), unique=True, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    users = relationship("Users", back_populates="unit")
    fechamentos = relationship("Fechamentos", back_populates="unit")