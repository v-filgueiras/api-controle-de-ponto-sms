from datetime import datetime

from pydantic import BaseModel

class DocumentOut(BaseModel):
    id: int
    filename: str
    mime_type: str
    size_bytes: int
    uploaded_by_id: int
    uploaded_at: datetime

    class Config:
        from_attributes = True