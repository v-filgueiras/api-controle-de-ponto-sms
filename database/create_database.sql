CREATE TABLE public.units (
  id integer NOT NULL DEFAULT nextval('units_id_seq'::regclass),
  name character varying NOT NULL UNIQUE,
  created_at timestamp without time zone,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT units_pkey PRIMARY KEY (id)
);

CREATE TABLE public.users (
  id integer NOT NULL DEFAULT nextval('users_id_seq'::regclass),
  name character varying NOT NULL,
  email character varying NOT NULL UNIQUE,
  hash_passwd character varying NOT NULL,
  perfil character varying NOT NULL,
  unit_id integer,
  status boolean,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  profile_photo bytea,
  profile_photo_mime character varying,
  approval_status character varying NOT NULL DEFAULT 'pendente'::character varying,
  approved_by_id integer,
  approved_at timestamp without time zone,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id),
  CONSTRAINT users_approved_by_id_fkey FOREIGN KEY (approved_by_id) REFERENCES public.users(id)
);

CREATE TABLE public.documents (
  id integer NOT NULL DEFAULT nextval('documents_id_seq'::regclass),
  filename character varying NOT NULL,
  storage_path character varying NOT NULL,
  mime_type character varying NOT NULL,
  size_bytes integer NOT NULL,
  uploaded_by_id integer NOT NULL,
  uploaded_at timestamp without time zone,
  CONSTRAINT documents_pkey PRIMARY KEY (id),
  CONSTRAINT documents_uploaded_by_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id)
);

CREATE TABLE public.fechamentos (
  id integer NOT NULL DEFAULT nextval('fechamentos_id_seq'::regclass),
  unit_id integer NOT NULL,
  competence character varying NOT NULL,
  status character varying NOT NULL CHECK (status::text = ANY (ARRAY['rascunho'::character varying, 'pendente'::character varying, 'aprovado'::character varying, 'correcao'::character varying, 'rejeitado'::character varying, 'nao_enviado'::character varying]::text[])),
  document_id integer,
  signature_method character varying CHECK (signature_method::text = ANY (ARRAY['govbr'::character varying, 'certificado'::character varying, 'manual'::character varying, 'outro'::character varying]::text[])),
  submitted_at timestamp without time zone,
  submitted_by_id integer,
  rh_note text,
  rh_decision_at timestamp without time zone,
  rh_decision_by_id integer,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT fechamentos_pkey PRIMARY KEY (id),
  CONSTRAINT fechamentos_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id),
  CONSTRAINT fechamentos_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id),
  CONSTRAINT fechamentos_submitted_by_id_fkey FOREIGN KEY (submitted_by_id) REFERENCES public.users(id),
  CONSTRAINT fechamentos_rh_decision_by_id_fkey FOREIGN KEY (rh_decision_by_id) REFERENCES public.users(id)
);

CREATE TABLE public.history_log (
  id integer NOT NULL DEFAULT nextval('history_log_id_seq'::regclass),
  timestamp timestamp without time zone NOT NULL,
  user_id integer NOT NULL,
  action character varying NOT NULL,
  fechamento_id integer,
  unit_id integer,
  status_snapshot character varying,
  CONSTRAINT history_log_pkey PRIMARY KEY (id),
  CONSTRAINT history_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT history_log_fechamento_id_fkey FOREIGN KEY (fechamento_id) REFERENCES public.fechamentos(id),
  CONSTRAINT history_log_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id)
);

CREATE TABLE public.point_rows (
  id integer NOT NULL DEFAULT nextval('point_rows_id_seq'::regclass),
  fechamento_id integer NOT NULL,
  matricula character varying NOT NULL,
  nome character varying NOT NULL,
  cargo character varying NOT NULL,
  periodo character varying NOT NULL,
  dt smallint NOT NULL CHECK (dt >= 0),
  bh smallint NOT NULL CHECK (bh >= 0),
  he smallint NOT NULL CHECK (he >= 0),
  an smallint NOT NULL CHECK (an >= 0),
  gr smallint NOT NULL CHECK (gr >= 0),
  ins smallint NOT NULL CHECK (ins >= 0),
  at smallint NOT NULL CHECK (at >= 0),
  observacao character varying NOT NULL,
  faltas smallint NOT NULL DEFAULT 0 CHECK (faltas >= 0),
  CONSTRAINT point_rows_pkey PRIMARY KEY (id),
  CONSTRAINT point_rows_fechamento_id_fkey FOREIGN KEY (fechamento_id) REFERENCES public.fechamentos(id)
);

CREATE TABLE public.edit_requests (
  id integer NOT NULL DEFAULT nextval('edit_requests_id_seq'::regclass),
  fechamento_id integer NOT NULL,
  requested_by_id integer NOT NULL,
  reason text NOT NULL,
  status character varying NOT NULL DEFAULT 'pendente'::character varying CHECK (status::text = ANY (ARRAY['pendente'::character varying, 'aprovado'::character varying, 'rejeitado'::character varying]::text[])),
  decided_by_id integer,
  decision_note text,
  decided_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT edit_requests_pkey PRIMARY KEY (id),
  CONSTRAINT edit_requests_fechamento_id_fkey FOREIGN KEY (fechamento_id) REFERENCES public.fechamentos(id),
  CONSTRAINT edit_requests_requested_by_id_fkey FOREIGN KEY (requested_by_id) REFERENCES public.users(id),
  CONSTRAINT edit_requests_decided_by_id_fkey FOREIGN KEY (decided_by_id) REFERENCES public.users(id)
);

CREATE TABLE public.mensagens (
  id integer NOT NULL DEFAULT nextval('mensagens_id_seq'::regclass),
  unit_id integer NOT NULL,
  sender_id integer NOT NULL,
  sender_perfil character varying NOT NULL,
  body text NOT NULL,
  created_at timestamp without time zone NOT NULL,
  read_at timestamp without time zone,
  CONSTRAINT mensagens_pkey PRIMARY KEY (id)
);

CREATE TABLE public.email_verifications (
  id integer NOT NULL DEFAULT nextval('email_verifications_id_seq'::regclass),
  user_id integer NOT NULL,
  verified boolean NOT NULL,
  verified_at timestamp without time zone,
  token_hash character varying,
  token_expires_at timestamp without time zone,
  last_sent_at timestamp without time zone,
  CONSTRAINT email_verifications_pkey PRIMARY KEY (id),
  CONSTRAINT email_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE TABLE public.password_reset_tokens (
  id integer NOT NULL DEFAULT nextval('password_reset_tokens_id_seq'::regclass),
  user_id integer NOT NULL,
  token_hash character varying NOT NULL,
  created_at timestamp without time zone NOT NULL,
  expires_at timestamp without time zone NOT NULL,
  used_at timestamp without time zone,
  CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);