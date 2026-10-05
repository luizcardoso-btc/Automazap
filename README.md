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
