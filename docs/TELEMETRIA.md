# Telemetria e Saúde Zero-Trust (aba **Frota**)

## 1. Arquitetura

```
 PC / Notebook (rede local)                      Internet (TLS)                    Tablet (PWA)
┌──────────────────────────────┐   POST /api/v1/heartbeat    ┌────────────────┐   SSE /api/v1/stream   ┌──────────────┐
│ agent/telemetry  (Python)    │ ──────────────────────────▶ │  hub (Flask)   │ ─────────────────────▶ │ aba "Frota"  │
│  coletor → buffer → sender   │  HMAC-SHA256 + ts + nonce   │  valida, dedup │  Bearer (só leitura)   │ web/js/fleet │
│  (store-and-forward)         │ ◀────────────────────────── │  classifica    │ ◀── fallback: polling  └──────────────┘
└──────────────────────────────┘   ack assinado (X-CC-Ack)   │  alerta        │      GET /api/v1/fleet
                                                              └────────────────┘
```

* **Push, não pull:** o agente só faz conexões de SAÍDA. Nenhuma porta aberta no PC.
* **Três credenciais separadas:** chave por agente (escreve só o próprio heartbeat), token de leitura do painel,
  chave-mestra (só no hub; dela se *derivam* as chaves dos agentes, então o hub não guarda segredo por agente).
* **Estados:** Online · Degradado (heartbeat atrasado >2×, CPU/RAM/disco ≥90 %, serviço caído, latência ≥500 ms,
  versão antiga, relógio fora, alerta de segurança) · Offline (>3× o intervalo) · Fantasma (offline >10 min ou nunca visto) · Aguardando.

## 2. Agente (`agent/telemetry/`)

| Arquivo | Papel |
|---|---|
| `config.py` | Lê `.env`, valida, **falha fechada** (HTTP puro recusado, chave inválida recusada). Chave nunca aparece em `repr`/log. |
| `collectors.py` | CPU/RAM/disco/uptime/load, serviços (porta ou processo), RSS do próprio agente. `cpu_percent(None)` não bloqueia. |
| `buffer.py` | Fila limitada (240 amostras ≈ 1 h), commit por id, persistência atômica opcional em disco. |
| `transport.py` | TLS verificado ≥1.2, pinning opcional, assinatura CC1, **verifica o ack do hub**, 1 thread dedicado, timeouts curtos. |
| `heartbeat.py` | `sampler` + `sender` assíncronos; backoff exponencial c/ jitter; trata auth/TLS/429/422 de forma distinta. |
| `jsonlog.py` | Log JSON em uma linha por evento (sem segredos, sem corpo). |

Rodar: `python -m telemetry` (standalone, só `psutil`) ou definir `CC_HUB_URL` e subir o `agent.py` (já embute).

## 3. Payload e validação

```json
POST /api/v1/heartbeat
X-CC-Agent: pc-principal
X-CC-Timestamp: 1763160000
X-CC-Nonce: 9f2c1e7a4b8d40f1a3c6e5d7b2910483
X-CC-Signature: base64url(HMAC-SHA256(chave_do_agente, "CC1\nPOST\n/api/v1/heartbeat\npc-principal\n1763160000\n<nonce>\n<sha256(corpo)>"))

{"v":1,"agent_id":"pc-principal","agent_version":"4.0.0","interval_s":15,
 "host":{"hostname":"DESKTOP-01","os":"Windows 11","python":"3.12.4"},
 "samples":[{"boot_id":"3f9a…","seq":1042,"ts":1763159998.4,"flags":[],
   "metrics":{"cpu":12.5,"ram":48.1,"disk":61.0,"rtt_ms":23.4,"uptime_s":93211,"load1":null,
              "ram_total_gb":31.9,"disk_total_gb":476.0,"disk_free_gb":185.6,"agent_rss_mb":24.8},
   "services":[{"name":"Docker","ok":true,"critical":false}]}]}
```

Ordem de validação no hub (barato → caro; qualquer falha de identidade devolve o **mesmo** 401):
1. forma dos cabeçalhos · 2. agente cadastrado e não revogado (HMAC com chave falsa p/ desconhecidos: sem oráculo de timing) ·
3. assinatura em tempo constante · 4. janela de ±60 s + **nonce de uso único** (anti-replay) · 5. taxa por agente ·
6. JSON estrito (sem NaN/Infinity, tipos e faixas, strings por regex, lista branca de campos, `agent_id` do corpo = o assinado) ·
7. ingestão idempotente por `(boot_id, seq)` (reenvio após ack perdido não duplica) · 8. resposta com `X-CC-Ack` assinado.

## 4. Painel (`web/js/fleet.js`)

Consome `/api/v1/stream` com `fetch` + leitor de stream (permite `Authorization`, que o `EventSource` não permite). Watchdog de 35 s
(o hub dá ping a cada 15 s), reconexão com backoff, polling de 5 s como plano B, e integração com o alerta de borda vermelha do painel.
Sem hub configurado aparece **DEMO** rotulado. Todo texto vindo do hub passa por `esc()`.

## 5. Hardening — 3 pontos críticos

1. **TLS verificado + autenticação mútua (anti-MITM).** O agente recusa HTTP, valida certificado/hostname e verifica a assinatura
   da *resposta* do hub (`X-CC-Ack`, amarrada ao nonce). Em rede hostil use `CC_HUB_CA_FILE` (CA privada) ou `CC_HUB_PIN_SHA256`
   (fingerprint do certificado) e, no hub, HSTS (já enviado) com TLS terminado por Render/Tailscale/Caddy.
2. **Identidade forte por agente + anti-replay (anti-spoofing).** Chave única por agente derivada da mestra, timestamp ±60 s,
   nonce descartável, revogação imediata (`CC_REVOKED`) e rotação (`id@2` em `CC_AGENTS` + novo `enroll`). Tentativas inválidas
   viram alerta crítico no painel; 20 falhas/min por IP => 429. Mantenha o relógio dos agentes sincronizado (NTP).
3. **Menor privilégio e superfície mínima.** Token de leitura do painel separado das chaves dos agentes (nenhuma chave de agente vai
   ao front-end); CORS só para a origem do painel; hub sem `/static`, sem rota que revele a frota sem token, corpo ≤64 KB; agente roda
   como usuário comum, só saída. Próximo passo se o risco subir: mTLS com certificados por agente (Caddy/Cloudflare) e/ou Ed25519
   no lugar de HMAC (um vazamento do hub não exporia as chaves dos agentes).

## Implantação rápida

```bash
cd hub && pip install -r requirements.txt
python -m cc_hub gen-secrets                     # CC_MASTER_KEY e CC_VIEWER_TOKEN  (hub/.env ou variáveis do Render)
python -m cc_hub enroll pc-principal --name "PC Principal"   # imprime CC_AGENT_ID e CC_AGENT_KEY p/ o agent/.env
python -m cc_hub run                             # local;  produção: gunicorn (veja render.yaml)
python -m unittest discover -s tests -v          # 21 testes
```
No painel: ⚙ → **Hub de telemetria** → URL do hub + `CC_VIEWER_TOKEN`.

## Limites conhecidos

* Estado da frota em memória: reiniciar o hub zera o histórico (os agentes reaparecem no próximo heartbeat).
* Render *free* dorme sem tráfego e não garante 24/7. Instância única de propósito (1 worker).
* Não testado: Windows real, Render real, pinning contra certificado real, instalação do PWA atualizado no tablet.
