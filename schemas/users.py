from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field

Perfil = Literal["admin", "rh", "coordinator"]

class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8)
    perfil: Perfil
    unit_id: Optional[int] = None  # obrigatório apenas quando perfil == "coordinator"

class UserUpdate(BaseModel):
    name: Optional[str] = None
    perfil: Optional[Perfil] = None
    unit_id: Optional[int] = None
    status: Optional[bool] = None

class UserOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    perfil: str
    unit_id: Optional[int]
    status: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True