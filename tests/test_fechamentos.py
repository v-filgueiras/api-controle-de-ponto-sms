from conftest import login

PDF = b"%PDF-1.4\n%conteudo de teste\n"
LINHA = {
    "matricula": "123", "nome": "Servidor Um", "cargo": "Enfermeiro", "periodo": "01 a 30",
    "dt": 0, "bh": 0, "he": 0, "an": 0, "gr": 0, "ins": 0, "at": 0, "faltas": 0,
    "observacao": "Sem observação",
}


def _fechamento_atual(client, headers, unit_id):
    r = client.get(f"/unidades/{unit_id}/fechamento-atual", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _submeter(client, headers, fid):
    assert client.put(f"/fechamentos/{fid}/rows", headers=headers, json={"rows": [LINHA]}).status_code == 200
    r = client.post(
        f"/fechamentos/{fid}/documento",
        headers=headers,
        files={"file": ("ponto.pdf", PDF, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    return client.post(
        f"/fechamentos/{fid}/submeter", headers=headers, json={"signature_method": "govbr"}
    )


def test_fluxo_completo_submissao_e_aprovacao(client, cenario):
    coord = login(client, cenario["coord1"])
    rh = login(client, cenario["rh"])

    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]
    r = _submeter(client, coord, fid)
    assert r.status_code == 200
    assert r.json()["status"] == "pendente"

    # bloqueado para edição enquanto pendente
    r = client.put(f"/fechamentos/{fid}/rows", headers=coord, json={"rows": [LINHA]})
    assert r.status_code == 409

    r = client.post(f"/fechamentos/{fid}/decisao", headers=rh, json={"decision": "approved"})
    assert r.status_code == 200
    assert r.json()["status"] == "aprovado"

    # decidir de novo não é permitido
    r = client.post(f"/fechamentos/{fid}/decisao", headers=rh, json={"decision": "approved"})
    assert r.status_code == 409


def test_correcao_exige_nota_e_libera_nova_submissao(client, cenario):
    coord = login(client, cenario["coord1"])
    rh = login(client, cenario["rh"])
    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]
    _submeter(client, coord, fid)

    r = client.post(f"/fechamentos/{fid}/decisao", headers=rh, json={"decision": "correction", "note": "  "})
    assert r.status_code == 422

    r = client.post(
        f"/fechamentos/{fid}/decisao", headers=rh, json={"decision": "correction", "note": "Revisar faltas"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "correcao"

    r = client.post(f"/fechamentos/{fid}/submeter", headers=coord, json={"signature_method": "govbr"})
    assert r.status_code == 200


def test_rh_e_admin_nao_escrevem_no_fechamento(client, cenario):
    coord = login(client, cenario["coord1"])
    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]

    for quem in ("rh", "admin"):
        h = login(client, cenario[quem])
        assert client.put(f"/fechamentos/{fid}/rows", headers=h, json={"rows": [LINHA]}).status_code == 403
        r = client.post(
            f"/fechamentos/{fid}/documento", headers=h,
            files={"file": ("p.pdf", PDF, "application/pdf")},
        )
        assert r.status_code == 403
        r = client.post(f"/fechamentos/{fid}/submeter", headers=h, json={"signature_method": "govbr"})
        assert r.status_code == 403


def test_coordenador_nao_acessa_outra_unidade(client, cenario):
    coord1 = login(client, cenario["coord1"])
    coord2 = login(client, cenario["coord2"])
    fid2 = _fechamento_atual(client, coord2, cenario["u2"])["id"]

    assert client.get(f"/unidades/{cenario['u2']}/fechamento-atual", headers=coord1).status_code == 403
    assert client.get(f"/fechamentos/{fid2}", headers=coord1).status_code == 403
    assert client.put(f"/fechamentos/{fid2}/rows", headers=coord1, json={"rows": [LINHA]}).status_code == 403


def test_get_do_rh_nao_cria_fechamento(client, cenario):
    rh = login(client, cenario["rh"])
    r = client.get(f"/unidades/{cenario['u1']}/fechamento-atual", headers=rh)
    assert r.status_code == 404

    coord = login(client, cenario["coord1"])
    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]
    r = client.get(f"/unidades/{cenario['u1']}/fechamento-atual", headers=rh)
    assert r.status_code == 200
    assert r.json()["id"] == fid


def test_upload_rejeita_arquivo_que_nao_e_pdf(client, cenario):
    coord = login(client, cenario["coord1"])
    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]
    r = client.post(
        f"/fechamentos/{fid}/documento", headers=coord,
        files={"file": ("x.pdf", b"nao sou um pdf", "application/pdf")},
    )
    assert r.status_code == 422


def test_historico_registra_edicao_de_linhas_e_download(client, cenario, db):
    from models import HistoryLog

    coord = login(client, cenario["coord1"])
    rh = login(client, cenario["rh"])
    fid = _fechamento_atual(client, coord, cenario["u1"])["id"]
    _submeter(client, coord, fid)

    doc_id = client.get(f"/fechamentos/{fid}", headers=rh).json()["document"]["id"]
    nome = "Fechamento março — Centro.pdf"
    from models import Documents
    db.query(Documents).filter(Documents.id == doc_id).update({"filename": nome})
    db.commit()

    r = client.get(f"/documentos/{doc_id}/download", headers=rh)
    assert r.status_code == 200
    assert r.content == PDF

    acoes = [h.action for h in db.query(HistoryLog).all()]
    assert any(a.startswith("Atualizou linhas do ponto") for a in acoes)
    assert "Visualizou documento assinado" in acoes
    assert any(a.startswith("Anexou documento assinado") for a in acoes)
