"""Envio de e-mail (SMTP) e checagem de domínio real para cadastro.

Variáveis de ambiente necessárias:
  SMTP_HOST, SMTP_PORT (padrão 587), SMTP_USER, SMTP_PASSWORD,
  SMTP_FROM (padrão = SMTP_USER), SMTP_USE_TLS (padrão "true"),
  FRONTEND_URL (padrão "http://localhost:5500") — usado para montar os
  links de confirmação/redefinição enviados por e-mail.

Requer o pacote "email-validator" (pip install email-validator) para a
checagem de domínio (consulta registros MX, detecta domínios inexistentes
e a maior parte dos e-mails inventados/com erro de digitação).
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from email_validator import EmailNotValidError, validate_email

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() != "false"
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5500")


def email_tem_dominio_real(email: str) -> tuple[bool, str | None]:
    """Confere formato + existência do domínio (registro MX).

    Não garante que a caixa específica existe (isso só se confirma com o
    clique no link enviado por e-mail), mas já barra domínios inventados,
    com erro de digitação óbvio, ou sem servidor de e-mail configurado.
    """
    try:
        validate_email(email, check_deliverability=True)
        return True, None
    except EmailNotValidError as exc:
        return False, str(exc)


def _enviar(destinatario: str, assunto: str, corpo_html: str) -> None:
    if not SMTP_HOST or not SMTP_USER:
        raise RuntimeError(
            "Configuração de e-mail ausente: defina SMTP_HOST, SMTP_USER e SMTP_PASSWORD."
        )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = assunto
    msg["From"] = SMTP_FROM
    msg["To"] = destinatario
    msg.attach(MIMEText(corpo_html, "html", "utf-8"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
        if SMTP_USE_TLS:
            server.starttls()
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_FROM, [destinatario], msg.as_string())


def enviar_email_confirmacao(destinatario: str, nome: str, token: str) -> None:
    link = f"{FRONTEND_URL}/confirmar-email?token={token}"
    corpo_html = f"""
    <p>Olá, {nome}.</p>
    <p>Confirme seu e-mail para ativar seu acesso ao Controle de Ponto:</p>
    <p><a href="{link}">Confirmar e-mail</a></p>
    <p>Se o botão não funcionar, copie e cole este link no navegador:<br>{link}</p>
    <p>Este link expira em 24 horas. Se você não reconhece este cadastro, ignore esta mensagem.</p>
    """
    _enviar(destinatario, "Confirme seu e-mail - Controle de Ponto", corpo_html)


def enviar_email_redefinicao_senha(destinatario: str, nome: str, token: str) -> None:
    link = f"{FRONTEND_URL}/redefinir-senha?token={token}"
    corpo_html = f"""
    <p>Olá, {nome}.</p>
    <p>Recebemos uma solicitação para redefinir sua senha no Controle de Ponto.</p>
    <p><a href="{link}">Redefinir senha</a></p>
    <p>Se o botão não funcionar, copie e cole este link no navegador:<br>{link}</p>
    <p>Este link expira em 1 hora. Se você não solicitou, ignore esta mensagem — sua senha atual continua válida.</p>
    """
    _enviar(destinatario, "Redefinição de senha - Controle de Ponto", corpo_html)