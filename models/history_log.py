from database.connect import Base
from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship

class HistoryLog(Base):
    __tablename__ = "history_log"

    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime, nullable=False, default=datetime.now)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    action = Column(String(100), nullable=False)
    fechamento_id = Column(Integer, ForeignKey("fechamentos.id"), nullable=True)
    unit_id = Column(Integer, ForeignKey("units.id"), nullable=True)
    status_snapshot = Column(String(20), nullable=True)

    user = relationship("Users")
    fechamento = relationship("Fechamentos")
    unit = relationship("Units")