from database.connect import Base

from sqlalchemy import Column, Integer, String, SmallInteger, ForeignKey, CheckConstraint
from sqlalchemy.orm import relationship

class PointRows(Base):
    __tablename__ = "point_rows"

    id = Column(Integer, primary_key=True)
    fechamento_id = Column(Integer, ForeignKey("fechamentos.id", ondelete="CASCADE"), nullable=False)
    matricula = Column(String(20), nullable=False)
    nome = Column(String(150), nullable=False)
    cargo = Column(String(100), nullable=False)
    periodo = Column(String(30), nullable=False)
    dt = Column(SmallInteger, nullable=False, default=0)
    bh = Column(SmallInteger, nullable=False, default=0)
    he = Column(SmallInteger, nullable=False, default=0)
    an = Column(SmallInteger, nullable=False, default=0)
    gr = Column(SmallInteger, nullable=False, default=0)
    ins = Column(SmallInteger, nullable=False, default=0)
    at = Column(SmallInteger, nullable=False, default=0)
    observacao = Column(String(500), nullable=False, default="Sem observação")

    __table_args__ = (
        CheckConstraint("dt >= 0", name="ck_point_rows_dt"),
        CheckConstraint("bh >= 0", name="ck_point_rows_bh"),
        CheckConstraint("he >= 0", name="ck_point_rows_he"),
        CheckConstraint("an >= 0", name="ck_point_rows_an"),
        CheckConstraint("gr >= 0", name="ck_point_rows_gr"),
        CheckConstraint("ins >= 0", name="ck_point_rows_ins"),
        CheckConstraint("at >= 0", name="ck_point_rows_at"),
    )

    fechamento = relationship("Fechamentos", back_populates="rows")