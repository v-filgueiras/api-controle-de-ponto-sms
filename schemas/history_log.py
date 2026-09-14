from datetime import datetime
from typing import Optional

from pydantic import BaseModel

class HistoryLogOut(BaseModel):
    id: int
    timestamp: datetime
    user_id: int
    action: str
    fechamento_id: Optional[int]
    unit_id: Optional[int]
    status_snapshot: Optional[str]

    class Config:
        from_attributes = True