# Command Center

Painel PWA para tablet Android (fullscreen, paisagem): hardware, rede, segurança (Sentinel), câmeras e automações.
Front-end estático no Render + agente Python na sua rede.

## Estrutura

```
command-center/
├── render.yaml              # Render Blueprint (site estático + headers de segurança/CSP)
├── .gitignore
├── web/                     # FRONT-END (publish dir do Render)
│   ├── index.html           # meta tags PWA, 5 abas, diálogo de configurações
│   ├── manifest.json        # display fullscreen, landscape, tema #090C12, ícones, atalhos
│   ├── sw.js                # Service Worker (cache do shell, offline, instalação)
│   ├── css/style.css
│   ├── js/config.js         # padrões (hosts, clima, câmeras)
│   ├── js/app.js            # núcleo: cards, ping, terminal, automações, mixer, alertas
│   ├── js/sentinel.js       # cibersegurança: radar, tripwires, score, lockdown
│   ├── js/settings.js       # ⚙ configurações (endpoint, token, câmeras)
│   ├── js/pwa.js            # SW, instalar app, tela cheia, wake lock
│   └── icons/               # raio neon: SVG + PNG 192/512/maskable/apple-touch
└── agent/                   # AGENTE (roda no PC e no notebook)
    ├── agent.py
    ├── requirements.txt
    ├── .env.example
    ├── peripherals.example.json
    └── devices.example.json
```

## 1. GitHub + Render (front-end)

1. `git init && git add . && git commit -m "Command Center" ` e suba no GitHub.
2. Render → **New + → Blueprint** → escolha o repositório (usa o `render.yaml`).
   Ou **New → Static Site**, Publish Directory = `web`, Build Command vazio.
3. Abra a URL `https://….onrender.com` no Chrome do tablet → menu ⋮ → **Instalar app**.
   (Ou ⚙ → **Instalar app**.) Abre em tela cheia, paisagem, com a tela sempre ligada.

## 2. Agente Python

```bash
cd agent
python -m venv .venv && .venv\Scripts\activate      # Windows (Linux/macOS: source .venv/bin/activate)
pip install -r requirements.txt
python agent.py
```

No primeiro start ele imprime um **TOKEN**. Cole em ⚙ → Agentes → Token, junto com o endpoint da máquina.
Sem agente (ou com agente fora do ar) o painel cai sozinho para dados **simulados**, sempre rotulados na tela.

Opcionais (veja `.env.example`): `peripherals.json` (bateria de celular/relógio/fones), `devices.json` (nomes por MAC),
`CC_LHM_URL` (temperatura de CPU no Windows via LibreHardwareMonitor), mixer por processo, tripwires, lockdown.

## 3. HTTPS e mixed content (leia, isso decide se funciona)

O painel no Render é **HTTPS**. O Chrome **bloqueia** chamadas dessa página para `http://192.168.x.x:5000`
(mixed content), então um agente em HTTP puro não conecta e o painel fica simulado. Três caminhos:

- **Tailscale (recomendado):** instale nos PCs e no tablet; no PC rode `tailscale serve --bg 5000` e use o endereço
  `https://nome-do-pc.seu-tailnet.ts.net` no ⚙. Certificado válido, funciona fora de casa, nada exposto à internet.
  (O agente fala HTTP local; o `tailscale serve` entrega HTTPS.)
- **mkcert:** gere um certificado para o IP/nome do PC, instale a CA no tablet, defina `CC_SSL_CERT` e `CC_SSL_KEY`.
- **Painel servido localmente:** abrir o front em `http://` na LAN funciona com o agente em HTTP, mas aí não há
  Service Worker nem Battery API (ambos exigem HTTPS), ou seja, sem instalação PWA.

Câmeras têm a mesma regra: feed `http://` em página HTTPS é bloqueado. RTSP não toca no navegador;
converta com **go2rtc** ou **MediaMTX** para MJPEG/HLS e sirva por HTTPS.

## 4. Segurança do próprio projeto

- Agente exige token em tudo (menos `/api/health`); comparação em tempo constante; ações só executam comandos fixos no código/.env.
- O token fica no localStorage do tablet. Use só em aparelho seu.
- `render.yaml` aplica CSP (sem script inline), nosniff, DENY de frame e Permissions-Policy.
- Antes de publicar prints/vídeos: borre IPs, MACs, nomes de dispositivos, Wi-Fi e coordenadas.

## 5. Sentinel (aba Segurança)

| Recurso | Como funciona |
|---|---|
| Radar de confiança | Centro = gateway. Quanto mais longe, menos confiável. Tocar num ponto mostra IP/MAC e permite confiar. "Aprender rede atual" cria o baseline. |
| Dispositivo novo | Diff da tabela ARP; MAC aleatório (bit "localmente administrado") é sinalizado, pois é o padrão de Android/iOS. |
| Tripwires | O agente abre portas-isca (padrão 2222 e 2323). Qualquer conexão vira alerta, o ponto de origem pulsa no radar e a tela inteira ganha moldura vermelha. A isca fecha a conexão sem responder nada. **Teste:** do celular, abra `http://IP-DO-PC:2323`. |
| ARP spoofing | Guarda o MAC do gateway (`.state.json`); se mudar, alerta crítico. Se foi troca do roteador, apague o arquivo. |
| Superfície exposta | Portas em escuta em todas as interfaces; destaca RDP, SMB, VNC, Telnet, Redis, Docker API etc. |
| Postura | Pontuação 0–100 heurística com cada fator explicado. **Não substitui auditoria.** |
| Lockdown | Segurar 1,5 s. Executa os comandos de `CC_LOCKDOWN_ON` (vazio = só registra), libera sozinho após o TTL e ao fechar o agente. |
| Demo | "Simular intrusão" cria um dispositivo e um tripwire fictícios, marcados DEMO, para gravar vídeo sem precisar de ataque. |

## 6. O que NÃO foi testado

Testei no Linux: agente (auth, métricas, tripwire, lockdown em modo registro) e o painel em Chromium headless.
**Não testei em Windows/Android reais:** pycaw (mixer), leitura do LibreHardwareMonitor, `netsh`
(firewall e comandos de lockdown), instalação do PWA no Chrome do tablet e Battery API no tablet.
Se algo falhar nesses pontos, o resto continua funcionando e o painel cai para simulado.

## 7. Frota · telemetria Zero-Trust (novo)

Aba **Frota**: cada agente envia heartbeats assinados (HMAC) a um **hub** e o painel recebe o estado em tempo real
(Online / Degradado / Offline / Fantasma + alertas de spoofing, replay e relógio). Arquitetura, payload, deploy e hardening em
[`docs/TELEMETRIA.md`](docs/TELEMETRIA.md). Pastas novas: `hub/` (API) e `agent/telemetry/` (módulo do agente).

## 8. Jarvis (tela inicial, voz, Smart Life, Alexa)

A tela principal agora é o HUD do Jarvis (rede + aparelhos + comando de voz) e o agente também serve o painel. Guia completo em [`docs/JARVIS.md`](docs/JARVIS.md). O painel anterior está em `legado.html`.
