CREATE TABLE units (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  nome VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  perfil VARCHAR(20) NOT NULL CHECK (perfil IN ('admin','rh','coordinator')),
  unidade_id BIGINT REFERENCES units(id),
  status VARCHAR(20) NOT NULL DEFAULT 'Ativo',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  size_bytes INTEGER NOT NULL,
  uploaded_by_id BIGINT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE fechamentos (
  id BIGSERIAL PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES units(id),
  competence VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho','pendente','aprovado','correcao','rejeitado','nao_enviado')),
  document_id BIGINT REFERENCES documents(id),
  signature_method VARCHAR(20)
    CHECK (signature_method IN ('govbr','certificado','manual','outro')),
  submitted_at TIMESTAMP,
  submitted_by_id BIGINT REFERENCES users(id),
  rh_note TEXT,
  rh_decision_at TIMESTAMP,
  rh_decision_by_id BIGINT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (unit_id, competence)
);

CREATE TABLE point_rows (
  id BIGSERIAL PRIMARY KEY,
  fechamento_id BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE CASCADE,
  matricula VARCHAR(20) NOT NULL,
  nome VARCHAR(150) NOT NULL,
  cargo VARCHAR(100) NOT NULL,
  periodo VARCHAR(30) NOT NULL,
  dt SMALLINT NOT NULL DEFAULT 0 CHECK (dt >= 0),
  bh SMALLINT NOT NULL DEFAULT 0 CHECK (bh >= 0),
  he SMALLINT NOT NULL DEFAULT 0 CHECK (he >= 0),
  an SMALLINT NOT NULL DEFAULT 0 CHECK (an >= 0),
  gr SMALLINT NOT NULL DEFAULT 0 CHECK (gr >= 0),
  ins SMALLINT NOT NULL DEFAULT 0 CHECK (ins >= 0),
  at SMALLINT NOT NULL DEFAULT 0 CHECK (at >= 0),
  faltas SMALLINT NOT NULL DEFAULT 0 CHECK (faltas >= 0),
  observacao VARCHAR(500) NOT NULL DEFAULT 'Sem observação'
);

CREATE TABLE history_log (
  id BIGSERIAL PRIMARY KEY,
  "timestamp" TIMESTAMP NOT NULL DEFAULT now(),
  user_id BIGINT NOT NULL REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  fechamento_id BIGINT REFERENCES fechamentos(id),
  unit_id BIGINT REFERENCES units(id),
  status_snapshot VARCHAR(20)
);