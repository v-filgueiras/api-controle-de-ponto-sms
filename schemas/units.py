from datetime import datetime

from pydantic import BaseModel, Field

class UnitCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)

class UnitOut(BaseModel):
    id: int
    name: str
    created_at: datetime

    class Config:
        from_attributes = True