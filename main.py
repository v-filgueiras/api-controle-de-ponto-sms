from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from config import CORS_ORIGINS, CSP_MODE
from database.connect import Base, engine

# Importar os models registra todas as tabelas em Base.metadata.
import models  # noqa: F401

from routes.auth import router as auth_router
from routes.auth_extra import router as auth_extra_router
from routes.users import router as users_router
from routes.units import router as units_router
from routes.fechamentos import router as fechamentos_router
from routes.documents import router as documents_router
from routes.history_log import router as history_log_router
from routes.dashboard import router as dashboard_router
from routes.mensagens import router as mensagens_router
from routes.audit import router as audit_router


app = FastAPI(
    title="Sistema de Controle de Ponto - SMS",
    version="1.0.0",
)

Base.metadata.create_all(bind=engine)


app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-src 'self' blob:",
    "object-src 'self' blob:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.middleware("http")
async def cabecalhos_de_seguranca(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")

    # A documentação interativa (/docs, /redoc) carrega scripts de CDN.
    if CSP_MODE != "off" and not request.url.path.startswith(("/docs", "/redoc")):
        nome = (
            "Content-Security-Policy"
            if CSP_MODE == "enforce"
            else "Content-Security-Policy-Report-Only"
        )
        response.headers.setdefault(nome, CSP)

    return response


app.include_router(auth_router)
app.include_router(auth_extra_router)
app.include_router(users_router)
app.include_router(units_router)
app.include_router(fechamentos_router)
app.include_router(documents_router)
app.include_router(history_log_router)
app.include_router(dashboard_router)
app.include_router(mensagens_router)
app.include_router(audit_router)


# Arquivos do frontend
app.mount(
    "/static",
    StaticFiles(directory="frontend"),
    name="static",
)


@app.get("/health", include_in_schema=False)
def health():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def home():
    return FileResponse("frontend/index.html")


# Links enviados por e-mail: o frontend lê o token da URL e conclui o fluxo.
@app.get("/confirmar-email", include_in_schema=False)
@app.get("/redefinir-senha", include_in_schema=False)
def paginas_de_email():
    return FileResponse("frontend/index.html")
