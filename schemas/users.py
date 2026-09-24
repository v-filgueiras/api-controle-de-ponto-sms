from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    perfil: Literal["admin", "rh", "coordinator"]
    unit_id: int | None = None


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    email: EmailStr | None = None
    perfil: Literal["admin", "rh", "coordinator"] | None = None
    unit_id: int | None = None
    status: bool | None = None


class UserOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    perfil: str
    unit_id: int | None
    status: bool
    approval_status: str
    approved_by_id: int | None = None
    approved_at: datetime | None = None
    created_at: datetime | None = None

    class Config:
        from_attributes = True