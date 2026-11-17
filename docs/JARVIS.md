# Jarvis · guia rápido

## Arquitetura
```
Tablet (Chrome) ──HTTP(S)──► agent.py (PC, porta 5000) ──► ping / TCP / ARP  → aparelhos da rede local
 index.html + HUD            serve o painel + API         ──► nuvem Tuya      → Smart Life (luz, tomada, cenas/IR)
 voz: Web Speech pt-BR       aparelhos.json (CRUD)        ──► webhooks        → Alexa (Voice Monkey / IFTTT / URL)
```
O navegador nunca chama Tuya/Alexa direto (CORS e segredos): tudo passa pelo agente.

## Rodar
1. `cd agent && pip install -r requirements.txt && python agent.py` (anote o TOKEN impresso).
2. No tablet abra o endereço **PAINEL** que o agente imprime (ex.: `http://192.168.0.10:5000/`).
3. Primeira tela pede o token (Configurações › Conexão). Depois cadastre os aparelhos (Configurações › Aparelhos).

## Microfone (obrigatório ler)
O Chrome só libera o microfone em HTTPS ou localhost. Opções:
- **Mais simples:** no Chrome do tablet abra `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, adicione `http://IP-DO-PC:5000`, ative e reinicie o Chrome.
- **Correto:** `tailscale serve --bg 5000` (HTTPS válido) ou certificado mkcert (`CC_SSL_CERT`/`CC_SSL_KEY`).
- Painel no Render (HTTPS): informe em Conexão um endpoint HTTPS do agente.

## Smart Life (Tuya)
1. iot.tuya.com › Cloud › Create project (Smart Home, região do seu app; Brasil costuma ser *Western America* = `us`).
2. Devices › Link App Account › escaneie o QR no app Smart Life. Copie o ID de cada aparelho.
3. Em `agent/.env`: `CC_TUYA_ID`, `CC_TUYA_SECRET`, `CC_TUYA_REGION`.
4. No aparelho: "Como acionar" = Smart Life/Tuya e cole o ID. Para infravermelho (controle de TV/ar), crie uma **cena** no Smart Life com o comando IR e use "cena ou automação" (ID da cena).
O estado real vem da nuvem (a cada `CC_TUYA_POLL` s, 1 chamada em lote). Cada leitura conta na cota da sua conta Tuya.

## Alexa (rotinas)
1. Voice Monkey: crie um *Monkey* por ação e, no app Alexa, uma rotina "Quando Monkey X for acionado › …". Coloque `CC_VOICEMONKEY_TOKEN` no `.env`.
2. No aparelho: "Webhook / rotina Alexa" e `voicemonkey:ID_DO_MONKEY` (ligar) e outro para desligar. Categoria **Rotina** cria um botão de disparo (aparece na faixa da tela inicial e responde a "Jarvis, executar rotina boa noite").
3. IFTTT: `CC_IFTTT_KEY` e `ifttt:nome_do_evento`. Qualquer outra URL http(s) também funciona (prefixo `POST ` troca o método).
Webhooks não devolvem o estado: o painel mostra "último comando", não "confirmado".

## Comandos de voz (exemplos)
"Jarvis" · "ligar a luz da sala" · "desligar todas as luzes" · "executar rotina boa noite" · "status da rede" · "verificar dispositivos" · "que horas são".
Toque no núcleo para falar uma vez; "Escuta contínua" (Configurações › Jarvis) mantém o microfone aberto esperando "Jarvis".

## Como o status é medido (sem dados falsos)
Por aparelho com IP: ping → conexão TCP (aceita ou recusada prova que o host está vivo) → tabela ARP. O método aparece no card. Sem resposta = Offline, com o motivo.

## Painel antigo
Sentinel, Frota, Câmeras e métricas continuam em `legado.html` (arquivos `app.js`, `sentinel.js`, `fleet.js`… intactos).
