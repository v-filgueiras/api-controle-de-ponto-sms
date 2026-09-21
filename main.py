from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database.connect import Base, engine

from models import (
    Users,
    Units,
    Fechamentos,
    Documents,
    PointRows,
    HistoryLog,
)

from routes.auth import router as auth_router
from routes.users import router as users_router
from routes.units import router as units_router
from routes.fechamentos import router as fechamentos_router
from routes.documents import router as documents_router
from routes.history_log import router as history_log_router
from routes.dashboard import router as dashboard_router
from routes.mensagens import router as mensagens_router


app = FastAPI(
    title="Sistema de Controle de Ponto - SMS",
    version="1.0.0",
)

Base.metadata.create_all(bind=engine)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(auth_router)
app.include_router(users_router)
app.include_router(units_router)
app.include_router(fechamentos_router)
app.include_router(documents_router)
app.include_router(history_log_router)
app.include_router(dashboard_router)
app.include_router(mensagens_router)


# Arquivos do frontend
app.mount(
    "/static",
    StaticFiles(directory="frontend"),
    name="static",
)


@app.get("/", include_in_schema=False)
def home():
    return FileResponse("frontend/index.html")