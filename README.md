# Automação de DMs

Robô de respostas por palavra-chave. Hoje: **Instagram**. O motor (`engine.js`) não depende do canal, então o **WhatsApp oficial (Cloud API)** entra como um arquivo novo, no mesmo molde de `instagram.js`.

| Arquivo | O que faz |
|---|---|
| `engine.js` | Palavras-chave (sem acento/caixa, frases, prioridade), pausa por atendente, limites, resposta padrão |
| `instagram.js` | Webhook assinado, envio de texto/botão/respostas rápidas, resposta privada a comentário, renovação do token |
| `routes-api.js`, `panel.html` | Painel: fluxos, conversas, simulador, configurações |
| `seed.js` | Fluxos iniciais da NexTap (preço, NFC, prazo, nota fiscal, atendente, parar) |
| `db.js` | SQLite com migrações só-aditivas e backup diário |
| `test.js` | 51 testes (`npm test`) |

Guia de ligação com a Meta: **SETUP-INSTAGRAM.md**. Variáveis: `.env.example`.

Rodar local: `npm install && ADMIN_PASSWORD=uma-senha-longa npm start` e abrir http://localhost:3000.

## Funil v2 da NexTap
Entrada → REVENDER / MEU NEGÓCIO → quantidade (1–10, 11–49, 50–299, 300+) → vídeo de demonstração → calculadora (link rastreado) → QUERO AJUDA / JÁ VOU COMPRAR → follow-ups 1–3 + final (3h, 9h, 16h e 22h após a última mensagem da pessoa, sempre dentro da janela de 24h do Instagram).
- Etiquetas: NOVO LEAD → REVENDEDOR → QUANTIDADE → VIU DEMO → VIU PREÇO → ABRIU CHECKOUT → QUENTE → VENDA → FOLLOW-UP (mais INTENÇÃO DE COMPRA, LEAD GRANDE, MEU NEGÓCIO). VENDA é marcada à mão na aba Conversas.
- 50+ placas: entra na fila humana com prioridade alta na hora (o robô continua a conversa). Com TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID você recebe aviso.
- Em Configurações, preencha o link do vídeo (.mp4, https) e confira o endereço público. No painel, "Instalar funil novo" desliga os fluxos antigos (não apaga).
- Rodar testes: STEP_DELAY_MS=0 CLICK_DELAY_MS=0 npm test
