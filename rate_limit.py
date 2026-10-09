"""Limitação de tentativas em memória (janela deslizante).

Vale para um único processo. Com vários workers/instâncias, cada um conta
separado — nesse caso, complemente com limite no proxy reverso (nginx etc.).
Atrás de proxy, rode o uvicorn com --proxy-headers para o IP do cliente ser
o real e não o do proxy.
"""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from config import RATE_LIMIT_ENABLED

_MAX_CHAVES = 10_000


class JanelaDeslizante:
    def __init__(self, maximo: int, janela_segundos: int):
        self.maximo = maximo
        self.janela = janela_segundos
        self._eventos: dict[str, deque[float]] = defaultdict(deque)

    def _limpar(self, chave: str, agora: float) -> deque[float] | None:
        fila = self._eventos.get(chave)
        if fila is None:
            return None
        while fila and agora - fila[0] > self.janela:
            fila.popleft()
        if not fila:
            del self._eventos[chave]
            return None
        return fila

    def _compactar(self, agora: float) -> None:
        if len(self._eventos) > _MAX_CHAVES:
            for chave in list(self._eventos):
                self._limpar(chave, agora)

    def bloqueado(self, chave: str) -> bool:
        fila = self._limpar(chave, time.monotonic())
        return fila is not None and len(fila) >= self.maximo

    def registrar(self, chave: str) -> None:
        agora = time.monotonic()
        self._compactar(agora)
        self._limpar(chave, agora)
        self._eventos[chave].append(agora)

    def limpar(self, chave: str) -> None:
        self._eventos.pop(chave, None)


def _erro_429() -> HTTPException:
    return HTTPException(
        status_code=429,
        detail="Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    )


def limite_por_ip(maximo: int, janela_segundos: int):
    """Dependência FastAPI: conta toda requisição ao endpoint por IP."""
    janela = JanelaDeslizante(maximo, janela_segundos)

    def dependency(request: Request) -> None:
        if not RATE_LIMIT_ENABLED:
            return
        ip = request.client.host if request.client else "desconhecido"
        if janela.bloqueado(ip):
            raise _erro_429()
        janela.registrar(ip)

    return dependency


# Falhas de login por (IP, e-mail): 5 erros em 15 minutos bloqueiam novas
# tentativas daquela combinação. Incluir o IP evita que um atacante trave a
# conta de outra pessoa só digitando o e-mail dela.
falhas_de_login = JanelaDeslizante(maximo=5, janela_segundos=15 * 60)


def chave_login(request: Request, email: str) -> str:
    ip = request.client.host if request.client else "desconhecido"
    return f"{ip}|{email}"
