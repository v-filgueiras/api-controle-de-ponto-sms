from pydantic import BaseModel, Field


class PointRowIn(BaseModel):
    matricula: str = Field(max_length=20)
    nome: str = Field(max_length=150)
    cargo: str = Field(max_length=100)
    periodo: str = Field(max_length=30)
    dt: int = Field(default=0, ge=0)
    bh: int = Field(default=0, ge=0)
    he: int = Field(default=0, ge=0)
    an: int = Field(default=0, ge=0)
    gr: int = Field(default=0, ge=0)
    ins: int = Field(default=0, ge=0)
    at: int = Field(default=0, ge=0)
    faltas: int = Field(default=0, ge=0)
    observacao: str = Field(default="Sem observação", max_length=500)


class PointRowOut(PointRowIn):
    id: int

    class Config:
        from_attributes = True