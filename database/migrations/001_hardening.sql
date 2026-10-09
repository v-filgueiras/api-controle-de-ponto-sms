-- 001 - Endurecimento do banco (rodar UMA vez em bancos já existentes).
-- O create_all() só cria tabelas novas; ele não altera as que já existem,
-- então estas constraints (já declaradas nos models) precisam ser aplicadas
-- manualmente. Faça backup antes e rode dentro de uma transação:
--   psql "$DATABASE_URL" -1 -f database/migrations/001_hardening.sql

-- 0) Conferir ANTES se há dados que violam as constraints (todas as consultas
--    abaixo devem retornar 0 linhas; se retornarem, corrija os dados primeiro).
--
--    SELECT unit_id, competence, count(*) FROM fechamentos
--      GROUP BY unit_id, competence HAVING count(*) > 1;
--    SELECT id, perfil FROM users WHERE perfil NOT IN ('admin','rh','coordinator');
--    SELECT id, approval_status FROM users
--      WHERE approval_status NOT IN ('pendente','aprovado','rejeitado');
--    SELECT id FROM mensagens WHERE unit_id NOT IN (SELECT id FROM units)
--      OR sender_id NOT IN (SELECT id FROM users);

-- 1) Um único fechamento por unidade/competência (evita duplicidade em
--    requisições simultâneas).
ALTER TABLE public.fechamentos
  ADD CONSTRAINT uq_fechamento_unidade_competencia UNIQUE (unit_id, competence);

-- 2) Domínio fechado para perfil e approval_status.
ALTER TABLE public.users
  ADD CONSTRAINT ck_users_perfil CHECK (perfil IN ('admin','rh','coordinator'));
ALTER TABLE public.users
  ADD CONSTRAINT ck_users_approval_status
  CHECK (approval_status IN ('pendente','aprovado','rejeitado'));

-- 3) Chaves estrangeiras que faltavam em mensagens.
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.units(id);
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);
