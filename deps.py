import os
from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database.connect import get_db
from models import Users

# A rota usada para obter o token.
# Se sua rota de login tiver outro caminho, altere aqui.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY não configurada. Defina a variável de ambiente SECRET_KEY "
        "antes de iniciar o sistema (nunca use um valor padrão em produção)."
    )
ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> Users:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Não foi possível validar as credenciais.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        # Aceita tokens que salvem o ID como "sub" ou "user_id".
        user_id = payload.get("sub") or payload.get("user_id")

        if user_id is None:
            raise credentials_exception

        user_id = int(user_id)

    except (JWTError, ValueError, TypeError):
        raise credentials_exception

    user = db.query(Users).filter(Users.id == user_id).first()

    if user is None:
        raise credentials_exception

    if not user.status:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Usuário inativo.",
        )

    if user.approval_status != "aprovado":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seu cadastro ainda não foi aprovado pelo RH ou administração.",
        )

    return user


def require_role(*allowed_roles: str) -> Callable:
    def dependency(
        current_user: Users = Depends(get_current_user),
    ) -> Users:
        if current_user.perfil not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Você não possui permissão para executar esta ação.",
            )

        return current_user

    return dependency