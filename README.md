# Automação de DMs

Robô de respostas por palavra-chave. Hoje: **Instagram**. O motor (`engine.js`) não depende do canal, então o **WhatsApp oficial (Cloud API)** entra como um arquivo novo, no mesmo molde de `instagram.js`.

| Arquivo | O que faz |
|---|---|
| `engine.js` | Palavras-chave (sem acento/caixa, frases, prioridade), pausa por atendente, limites, resposta padrão |
| `instagram.js` | Webhook assinado, envio de texto/botão/respostas rápidas, resposta privada a comentário, renovação do token |
| `routes-api.js`, `panel.html` | Painel: fluxos, conversas, simulador, configurações |
| `seed.js` | Fluxos iniciais da NexTap (preço, NFC, prazo, nota fiscal, atendente, parar) |
| `db.js` | SQLite com migrações só-aditivas e backup diário |
| `test.js` | Testes automáticos (`npm test`) |

Guia de ligação com a Meta: **SETUP-INSTAGRAM.md**. Variáveis: `.env.example`.

Rodar local: `npm install && ADMIN_PASSWORD=uma-senha-longa npm start` e abrir http://localhost:3000.

## Funil v2 da NexTap
Entrada → REVENDER / MEU NEGÓCIO → quantidade (1–10, 11–49, 50–299, 300+) → vídeo de demonstração → calculadora (link rastreado) → QUERO AJUDA / JÁ VOU COMPRAR → follow-ups.
- Follow-ups por etapa, sempre dentro da janela de 24h do Instagram (horas contadas da última mensagem da pessoa):
  - Revenda, não escolheu a quantidade: 2h (pergunta de novo, com os botões) e final 20h.
  - Revenda, viu o preço e não abriu a calculadora: 2h (link da calculadora), 8h (preço de revenda) e final 20h.
  - Revenda, abriu a calculadora: 3h, 9h, 16h e final 22h.
  - Meu negócio: 2h (demonstração/modelos) e final 20h.
  - A sequência continua de onde parou quando a pessoa responde e só recomeça numa conversa nova (depois de 24h). Ao avançar de etapa, começa a sequência da etapa nova. Se o robô ficou parado, envia só o follow-up mais recente que já venceu, então a mensagem final não se perde.
  - `{{quantidade}}` nos textos vira a faixa escolhida ("11 a 49", "mais de 300"; sem faixa: "algumas").
  - Visão geral mostra, por follow-up: quantos receberam, responderam e compraram (etiqueta VENDA).
  - Quem já tinha o funil instalado recebe as sequências novas automaticamente na próxima subida, uma única vez (se apagar pelo painel, não voltam).
- Etiquetas: NOVO LEAD → REVENDEDOR → QUANTIDADE → VIU DEMO → VIU PREÇO → ABRIU CHECKOUT → QUENTE → VENDA → FOLLOW-UP (mais INTENÇÃO DE COMPRA, LEAD GRANDE, MEU NEGÓCIO). VENDA é marcada à mão na aba Conversas.
- 50+ placas: entra na fila humana com prioridade alta na hora (o robô continua a conversa). Com TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID você recebe aviso.
- Em Configurações, preencha o link do vídeo (.mp4, https) e confira o endereço público. No painel, "Instalar funil novo" desliga os fluxos antigos (não apaga).
- Rodar testes: STEP_DELAY_MS=0 CLICK_DELAY_MS=0 npm test
