# Controle de Ponto - SMS

API (FastAPI + PostgreSQL) e frontend estático para fechamento e aprovação de ponto das unidades da Secretaria Municipal de Saúde.

Perfis: **coordinator** (preenche e submete o fechamento da própria unidade), **rh** (aprova, pede correção ou rejeita) e **admin** (gerencia usuários e unidades).

## Rodando localmente

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # preencha DATABASE_URL, SECRET_KEY e BOOTSTRAP_TOKEN
uvicorn main:app --reload
```

Acesse http://localhost:8000. A documentação interativa fica em `/docs`.

### Primeiro administrador

Com o banco vazio, crie o primeiro admin (exige o `BOOTSTRAP_TOKEN` do `.env`):

```bash
curl -X POST localhost:8000/auth/bootstrap-admin -H 'Content-Type: application/json' \
  -d '{"name":"Admin","email":"admin@saude.gov.br","password":"********","bootstrap_token":"..."}'
```

## Banco de dados

`Base.metadata.create_all()` cria as tabelas que ainda não existem, mas **não altera** tabelas existentes. Em bancos já em uso, aplique as migrations de `database/migrations/` manualmente (leia o cabeçalho de cada arquivo antes). Adotar o Alembic é o próximo passo natural.

## Testes

```bash
pip install -r requirements-dev.txt
pytest
```

Os testes usam SQLite temporário; não tocam no seu banco.

## Produção - checklist

- Rodar atrás de HTTPS, com `uvicorn --proxy-headers` (para o rate limit enxergar o IP real).
- O rate limit é em memória, por processo. Com mais de um worker, complemente no proxy (nginx).
- `CSP_MODE=report-only` por padrão: abra o sistema, confira o console do navegador (inclusive a abertura de PDFs) e, sem avisos, mude para `enforce`.
- Backup do banco **e** da pasta `UPLOAD_DIR`.
- Remova `BOOTSTRAP_TOKEN` depois de criar o primeiro admin.
- Endpoint de saúde para monitoramento: `GET /health`.
