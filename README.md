# Automação de DMs

Robô de respostas por palavra-chave. Hoje: **Instagram**. O motor (`engine.js`) não depende do canal, então o **WhatsApp oficial (Cloud API)** entra como um arquivo novo, no mesmo molde de `instagram.js`.

| Arquivo | O que faz |
|---|---|
| `engine.js` | Palavras-chave (sem acento/caixa, frases, prioridade), pausa por atendente, limites, resposta padrão |
| `instagram.js` | Webhook assinado, envio de texto/botão/respostas rápidas, resposta privada a comentário, renovação do token |
| `routes-api.js`, `panel.html` | Painel: fluxos, conversas, simulador, configurações |
| `prospeccao.js` | Prospecção: busca empresas no Google (Places API) por região, nota de oportunidade, funil de vendas, histórico e script de vendas personalizado (aba **Prospecção** do painel). Precisa de `GOOGLE_PLACES_API_KEY`. |
| `whatsapp.js` | WhatsApp pela Evolution API: conversas com empresas (roteiros de venda, histórico na Prospecção), disparos programados para grupos e limite diário de primeiras mensagens (aba **WhatsApp**). Guia: **SETUP-WHATSAPP.md** |
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


## Prospecção grátis (OpenStreetMap)
A busca usa por padrão o mapa livre (Nominatim + Overpass): sem chave, sem cartão. Traz nome, endereço, telefone, site e Instagram quando cadastrados no mapa. **Não traz nota/avaliações** nem cobre 100% das empresas: use o link grátis "Ver nota no Google" e digite a nota na ficha. O Google Places continua opcional (`GOOGLE_PLACES_API_KEY`). Variáveis opcionais: `OVERPASS_URLS`, `NOMINATIM_BASE`.

### Varredura da cidade
Em Prospecção → **Varrer a cidade** você marca vários nichos (barbearia, tatuagem, ótica, padaria, roupas masculinas/femininas, calçados, restaurantes, academias, clínicas e mais ~30) e o sistema procura em **toda a cidade**, mostrando quantas empresas existem em cada nicho (com telefone, sem site) e a dica do que oferecer. Depois é só marcar as de oportunidade alta e salvar. Usa o OpenStreetMap (grátis); nichos pequenos podem aparecer incompletos.


## Funil de vendas (preço na conversa)
Instale em Visão geral → **Instalar funil de vendas** (os fluxos atuais são desligados, não apagados).
- Faixas iguais às do site (mínimo lido do NexTap). A pessoa pode tocar na faixa ou digitar o número ("20").
- O robô mostra preço por placa, total, quanto ela recebe revendendo (Configurações → preço de revenda) e o lucro.
  Variáveis: `{{qtd}} {{preco}} {{total}} {{preco_venda}} {{receita}} {{lucro}} {{minimo}} {{link_pedido}}`.
- `{{link_pedido}}` abre o site já com o pedido montado e leva o código do lead. Com `NEXTAP_WEBHOOK_SECRET` nos dois
  serviços, o site avisa cadastro, pedido e pagamento: etiquetas CADASTROU, INICIOU PEDIDO e VENDA (com valor) sozinhas.
- Follow-ups por etapa; o último convida a pessoa a mandar o WhatsApp. Quem manda o número vai para a aba WhatsApp.
- Se o token do Instagram cair, o painel mostra o alerta e o Telegram avisa (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID).


## Funil 3 toques (v5), fluxograma e teste A/B
- Visão geral → **Instalar funil 3 toques**: entrada → quantidade (5 a 10 · 11 a 49 · 50 ou mais) → **uma** mensagem de oferta
  com preço, lucro e o botão do pedido montado (o vídeo só abre se a pessoa tocar em "VER FUNCIONANDO"). No máximo 2 follow-ups
  por pessoa (3h e 20h). Quem escolhe 50+ vai para o comercial com prioridade alta.
- Aba **Fluxos**: os fluxos ficam agrupados por funil e aparecem como fluxograma (setas = para onde cada botão leva), com o
  acompanhamento em trilhas por etapa. "Usar este funil" liga o funil inteiro e desliga os outros (os avulsos não mudam).
- **Teste A/B**: qualquer fluxo pode ganhar uma variante B (botão no editor). Cada pessoa é sorteada uma vez e sempre vê o mesmo
  lado. O painel mostra, por lado, quem recebeu, abriu o pedido, criou conta e comprou, e a confiança da diferença; "A venceu" /
  "B venceu" encerra o teste. O v5 já vem com a oferta em teste: A = lucro em destaque, B = "com {{payback}} placas vendidas você
  paga o pedido".
- **Notificações no celular**: Configurações → Notificações no celular. Instale o painel na tela inicial (iPhone: Safari →
  Compartilhar → Adicionar à Tela de Início; Android: Chrome → ⋮ → Adicionar à tela inicial) e ligue. Cada aparelho escolhe o
  que recebe: lead quente, lead grande, pediu atendente, mandou o WhatsApp, cadastro/pedido no site, venda, mensagem no WhatsApp,
  robô parado. Tocar no aviso abre a conversa. As chaves (VAPID) são criadas sozinhas e ficam no banco.


## Pausa inteligente (robô sempre ligado)
- O robô responde todo mundo, o tempo todo. Ele só fica quieto numa conversa enquanto alguém da equipe está falando com a pessoa.
- Pediu atendente: o robô pausa só por alguns minutos (Configurações → padrão 15). Se ninguém da equipe responder nesse tempo,
  ele volta e manda "Nossa equipe já foi avisada…" (fluxo automático "Equipe não respondeu a tempo").
- Alguém da equipe respondeu, pelo painel ou **pelo app do Instagram** (o robô reconhece pelo eco da mensagem): o robô volta
  sozinho X horas depois da última resposta da equipe (padrão 2h).
- "Parar" continua silenciando a pessoa de vez.
- **Contas de teste** (Configurações): o robô nunca pausa para elas. Na lista de Conversas aparece "⏸ até 18:40" e o botão
  "Religar agora".


## Promoção do site nas mensagens (Black NexTap)
- O robô lê a promoção ativa do NexTap (`/api/public/promocao`) junto com os preços, a cada 10 min.
- Enquanto ela está ativa: linha da promoção na entrada, "de R$ X por R$ Y" e validade na oferta (igual nas versões A e B do
  teste), aviso do prazo no último follow-up e "Últimas horas" nas 48h finais. "BLACK", "black friday" e "promoção" abrem o robô.
- Quando a promoção acaba no site, as linhas somem sozinhas e o preço volta ao normal. Variáveis: `{{black}}`,
  `{{preco_de_por}}`, `{{black_oferta}}`, `{{black_final}}`.
