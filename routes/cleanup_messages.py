from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session
from database.connect import SessionLocal
from routes.mensagens import Mensagens

scheduler = BackgroundScheduler()

def limpar_mensagens_antigas():
    """Deleta mensagens com mais de 12 horas"""
    db = SessionLocal()
    try:
        limite = datetime.now() - timedelta(hours=12)
        deletadas = db.query(Mensagens).filter(
            Mensagens.created_at < limite
        ).delete()
        db.commit()
        if deletadas > 0:
            print(f"[CLEANUP] {deletadas} mensagens deletadas")
    except Exception as e:
        print(f"[CLEANUP ERROR] {e}")
    finally:
        db.close()

def iniciar_limpeza():
    """Inicia scheduler de limpeza a cada 1 hora"""
    scheduler.add_job(
        limpar_mensagens_antigas,
        'interval',
        hours=1,
        id='cleanup_messages',
        replace_existing=True
    )
    if not scheduler.running:
        scheduler.start()
    print("[CLEANUP] Scheduler iniciado - limpeza a cada 1 hora")

def parar_limpeza():
    """Para o scheduler"""
    if scheduler.running:
        scheduler.shutdown()
    print("[CLEANUP] Scheduler parado")