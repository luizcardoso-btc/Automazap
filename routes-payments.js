const express = require('express');
const pedidos = require('./pedidos.js');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const db = require('./database.js');
const { requireReseller } = require('./auth-middleware.js');

const router = express.Router();

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// Endereço público do backend (usado no webhook e no retorno do cartão).
// Usa PUBLIC_BACKEND_URL se for https; senão, deduz do próprio pedido (Railway já entrega https).
function baseUrl(req) {
  const b = (process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(b)) return b;
  return `${req.protocol}://${req.get('host')}`;
}

// Transforma o erro do SDK do Mercado Pago em texto para o log (sem vazar o token).
function descreverErroMP(err) {
  const causa = Array.isArray(err?.cause) ? err.cause : (err?.cause ? [err.cause] : []);
  return JSON.stringify({
    status: err?.status,
    error: err?.error,
    message: err?.message,
    cause: causa.map(c => ({ code: c?.code, description: c?.description })),
  });
}

// Traduz os erros mais comuns em (a) o que mostrar ao cliente e (b) o que fazer, para o log.
function interpretarErroMP(err) {
  const texto = descreverErroMP(err).toLowerCase();
  const status = Number(err?.status);
  if (texto.includes('invalid users involved') || texto.includes('2034') || texto.includes('same user')) {
    return { cliente: 'Use um e-mail diferente do e-mail da conta do Mercado Pago que recebe os pagamentos.',
             dica: 'O e-mail do pagador é igual ao da conta que recebe (ou mistura conta de teste com real).' };
  }
  if (texto.includes('key enabled') || texto.includes('13253') || texto.includes('without key')) {
    return { cliente: 'Pix indisponível no momento. Tente pagar com cartão ou fale com o suporte.',
             dica: 'A conta do Mercado Pago não tem chave Pix cadastrada. Cadastre uma chave Pix na conta que gera o token.' };
  }
  if (status === 401 || status === 403 || texto.includes('invalid_token') || texto.includes('unauthorized') || texto.includes('invalid access token')) {
    return { cliente: 'Pagamentos indisponíveis no momento. Fale com o suporte.',
             dica: 'MP_ACCESS_TOKEN inválido ou sem permissão. Use o Access Token de PRODUÇÃO (começa com APP_USR-).' };
  }
  if (texto.includes('identification') || texto.includes('cpf')) {
    return { cliente: 'Informe um CPF válido para gerar o Pix.', dica: 'Mercado Pago recusou o CPF/identificação do pagador.' };
  }
  if (texto.includes('notification_url')) {
    return { cliente: 'Não foi possível iniciar o pagamento. Tente novamente em instantes.',
             dica: 'notification_url inválida. Confira PUBLIC_BACKEND_URL (https://... sem barra no final).' };
  }
  return { cliente: 'Não foi possível iniciar o pagamento. Tente novamente em instantes.', dica: null };
}


// Lê e valida o endereço de entrega enviado no checkout.
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
function lerEntrega(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const t = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const d = {
    name: t(e.name), phone: String(e.phone ?? '').replace(/\D/g, '').slice(0, 13),
    cep: String(e.cep ?? '').replace(/\D/g, ''), street: t(e.street), number: t(e.number, 20),
    complement: t(e.complement, 60), district: t(e.district), city: t(e.city), state: t(e.state, 2).toUpperCase(),
  };
  if (!d.name) return { erro: 'Informe o nome de quem vai receber a entrega.' };
  if (d.phone.length < 10) return { erro: 'Informe um telefone/WhatsApp com DDD para a entrega.' };
  if (d.cep.length !== 8) return { erro: 'CEP inválido. Informe os 8 números do CEP.' };
  if (!d.street) return { erro: 'Informe a rua/avenida da entrega.' };
  if (!d.number) return { erro: 'Informe o número (ou S/N se não houver).' };
  if (!d.district) return { erro: 'Informe o bairro da entrega.' };
  if (!d.city) return { erro: 'Informe a cidade da entrega.' };
  if (!UFS.includes(d.state)) return { erro: 'Informe o estado (UF) da entrega, por exemplo BA.' };
  return { dados: d };
}

// E-mail da conta que recebe (descoberto no boot). O Mercado Pago recusa pagador = recebedor.
let collectorEmail = null;

// Roda no boot: confere se o token do Mercado Pago funciona e deixa o resultado nos logs do Railway.
async function diagnose() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return;
  const tipo = token.startsWith('TEST-') ? 'TESTE' : token.startsWith('APP_USR-') ? 'PRODUÇÃO' : 'DESCONHECIDO';
  console.log(`[MP] Tipo de token: ${tipo}`);
  if (tipo === 'TESTE') console.warn('[MP] AVISO: token de TESTE. Para receber pagamentos reais use o Access Token de produção (APP_USR-...).');
  const pub = (process.env.PUBLIC_BACKEND_URL || '').trim();
  if (!/^https:\/\/[^/]+$/i.test(pub.replace(/\/+$/, ''))) {
    console.warn(`[MP] AVISO: PUBLIC_BACKEND_URL ausente ou fora do padrão ("${pub}"). Vou deduzir o endereço pela requisição.`);
  }
  try {
    const r = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      console.error(`[MP] TOKEN RECUSADO pelo Mercado Pago (HTTP ${r.status}). Gere/cole novamente o Access Token de produção.`);
      return;
    }
    const u = await r.json();
    collectorEmail = (u.email || '').toLowerCase() || null;
    console.log(`[MP] Token OK — conta ${u.nickname || u.id} (${u.email || 'sem e-mail'}), país ${u.site_id}. Não use esse e-mail como pagador nos testes.`);
  } catch (e) {
    console.warn('[MP] Não consegui validar o token agora:', e.message);
  }
}

function unitPrice(qty) {
  const tiers = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all();
  const t = tiers.find(t => qty >= t.min_qty && qty <= t.max_qty);
  if (t) return t.unit_price;
  if (!tiers.length) return 25; // fallback se a tabela de preços estiver vazia
  // acima da última faixa vale o preço da última (nunca cai para o preço da primeira); abaixo da primeira, o da primeira
  return qty > tiers[tiers.length - 1].max_qty ? tiers[tiers.length - 1].unit_price : tiers[0].unit_price;
}

// Cria o pedido + inicia o pagamento.
// method: "pix" ou "credit_card"
// Para "pix" respondemos já com o QR Code (copia e cola + imagem).
// Para "credit_card" respondemos com o link de Checkout Pro do Mercado Pago.
router.post('/checkout', requireReseller, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Pagamentos indisponíveis no momento.' });
  }
  const body = req.body || {};
  const method = body.method;
  const payer = body.payer;
  const qty_azul = Number(body.qty_azul ?? 0);
  const qty_preta = Number(body.qty_preta ?? 0);
  if (!Number.isInteger(qty_azul) || !Number.isInteger(qty_preta) || qty_azul < 0 || qty_preta < 0) {
    return res.status(400).json({ error: 'Quantidades inválidas.' });
  }
  const qty = qty_azul + qty_preta;
  if (qty < 1) return res.status(400).json({ error: 'Escolha ao menos 1 placa.' });
  const minimo = db.prepare('SELECT MIN(min_qty) AS m FROM price_tiers').get().m || 1;
  if (qty < minimo) return res.status(400).json({ error: `O pedido mínimo é de ${minimo} placas (azuis, pretas ou as duas juntas). Você escolheu ${qty}.` });
  if (qty > 100000) return res.status(400).json({ error: 'Quantidade acima do permitido.' });
  if (!['pix', 'credit_card'].includes(method)) return res.status(400).json({ error: 'Forma de pagamento inválida.' });
  if (!payer || !payer.email || !payer.first_name) {
    return res.status(400).json({ error: 'Informe nome e e-mail para o pagamento.' });
  }

  if (collectorEmail && String(payer.email).toLowerCase().trim() === collectorEmail) {
    return res.status(400).json({ error: 'Use um e-mail diferente do e-mail da conta do Mercado Pago que recebe os pagamentos.' });
  }
  const cpf = String(payer.cpf || '').replace(/\D/g, '');
  if (cpf && cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido. Informe os 11 números ou deixe em branco.' });

  const entrega = lerEntrega(body.shipping);
  if (entrega.erro) return res.status(400).json({ error: entrega.erro });
  const ship = entrega.dados;

  const price = unitPrice(qty);
  const frete = db.freteFixo();                                  // frete fixo por pedido
  const subtotal = Math.round(price * qty * 100) / 100;           // só as placas
  const total = Math.round((subtotal + frete) * 100) / 100;       // o que o cliente paga
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.resellerId);

  const orderInfo = db.prepare(
    `INSERT INTO orders (reseller_id, qty_azul, qty_preta, unit_price, total, status, payment_method, shipping_fee,
       ship_name, ship_phone, ship_cep, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state)
     VALUES (?, ?, ?, ?, ?, 'aguardando_pagamento', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.resellerId, qty_azul, qty_preta, price, total, method, frete,
        ship.name, ship.phone, ship.cep, ship.street, ship.number, ship.complement, ship.district, ship.city, ship.state);
  const orderId = orderInfo.lastInsertRowid;
  // Guarda como endereço padrão do revendedor (o próximo checkout já vem preenchido).
  db.prepare(`UPDATE resellers SET addr_cep=?, addr_street=?, addr_number=?, addr_complement=?, addr_district=?, addr_city=?, addr_state=? WHERE id=?`)
    .run(ship.cep, ship.street, ship.number, ship.complement, ship.district, ship.city, ship.state, req.resellerId);

  const base = baseUrl(req);
  try {
    if (method === 'pix') {
      const payment = new Payment(client);
      const result = await payment.create({
        body: {
          transaction_amount: total,
          description: `NexTap — ${qty} placa(s)${frete ? ' + frete' : ''} para ${reseller.name}`,
          payment_method_id: 'pix',
          payer: {
            email: String(payer.email).trim(),
            first_name: payer.first_name,
            last_name: payer.last_name || payer.first_name,
            ...(cpf ? { identification: { type: 'CPF', number: cpf } } : {}),
          },
          ...(base.startsWith('https://') ? { notification_url: `${base}/api/payments/webhook` } : {}),
          external_reference: String(orderId),
        },
        requestOptions: { idempotencyKey: `nextap-pix-${orderId}` },
      });

      const txData = result.point_of_interaction?.transaction_data;
      db.prepare(`UPDATE orders SET mp_payment_id=?, pix_qr_code=?, pix_qr_base64=? WHERE id=?`)
        .run(String(result.id), txData?.qr_code || '', txData?.qr_code_base64 || '', orderId);

      return res.json({
        order_id: orderId,
        payment_id: result.id,
        status: result.status, // "pending" até o pagamento cair
        pix_qr_code: txData?.qr_code || null,
        pix_qr_base64: txData?.qr_code_base64 || null,
        ticket_url: txData?.ticket_url || null,
        total, subtotal, frete,
      });
    }

    // credit_card via Checkout Pro: devolvemos um link para o revendedor pagar
    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [
          { title: `NexTap — ${qty} placa(s) NFC`, quantity: 1, unit_price: subtotal, currency_id: 'BRL' },
          ...(frete > 0 ? [{ title: 'Frete (envio pelos Correios)', quantity: 1, unit_price: frete, currency_id: 'BRL' }] : []),
        ],
        payer: { email: String(payer.email).trim(), name: payer.first_name },
        external_reference: String(orderId),
        ...(base.startsWith('https://') ? { notification_url: `${base}/api/payments/webhook` } : {}),
        back_urls: {
          success: `${base}/revendedor/?pedido=${orderId}&status=aprovado`,
          pending: `${base}/revendedor/?pedido=${orderId}&status=pendente`,
          failure: `${base}/revendedor/?pedido=${orderId}&status=falhou`,
        },
        ...(base.startsWith('https://') ? { auto_return: 'approved' } : {}),
      },
    });

    db.prepare('UPDATE orders SET mp_preference_id=?, checkout_url=? WHERE id=?').run(result.id, result.init_point || null, orderId);
    return res.json({ order_id: orderId, checkout_url: result.init_point, total, subtotal, frete});

  } catch (err) {
    const { cliente, dica } = interpretarErroMP(err);
    console.error(`[MP] Falha ao criar pagamento (${method}, pedido ${orderId}): ${descreverErroMP(err)}`);
    if (dica) console.error(`[MP] O QUE FAZER: ${dica}`);
    // Nenhum pagamento foi criado, então descarta a tentativa (não fica pedido "cancelado" sujando a lista).
    db.prepare('DELETE FROM orders WHERE id=? AND mp_payment_id IS NULL').run(orderId);
    return res.status(502).json({ error: cliente });
  }
});

// O revendedor consulta o status do pedido (o painel atualiza sozinho enquanto aguarda o Pix).
// Se ainda está pendente, confere direto no Mercado Pago (no máximo a cada 15 segundos) — não depende do webhook.
router.get('/orders/:id/status', requireReseller, async (req, res) => {
  let order = db.prepare('SELECT * FROM orders WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status === 'aguardando_pagamento') {
    const ultima = order.mp_checked_at ? new Date(order.mp_checked_at.replace(' ', 'T') + 'Z').getTime() : 0;
    if (Date.now() - ultima > 15000) {
      try { await pedidos.conferirPedido(order.id, 'painel-revendedor'); } catch (e) { console.error('[PAGAMENTO] conferência falhou:', e.message); }
      order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    }
  }
  res.json(pedidos.decorar(order));
});

// Reabrir o pagamento de um pedido que ainda está aguardando (Pix ou link do cartão).
router.get('/orders/:id/pagamento', requireReseller, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'aguardando_pagamento') return res.status(409).json({ error: 'Este pedido não está mais aguardando pagamento.', status: o.status });
  res.json({ order_id: o.id, metodo: o.payment_method, total: o.total, pix_qr_code: o.pix_qr_code || null,
             pix_qr_base64: o.pix_qr_base64 || null, checkout_url: o.checkout_url || null });
});

// Webhook do Mercado Pago: ele chama esta URL quando o status de um pagamento muda.
// Precisa estar public (PUBLIC_BACKEND_URL) e cadastrada no seu app do Mercado Pago.
router.post('/webhook', express.json(), async (req, res) => {
  // O Mercado Pago manda dois formatos: novo (?type=payment&data.id=…) e antigo/IPN (?topic=payment&id=…).
  const topic = req.query.type || req.query.topic || req.body?.type || req.body?.topic;
  const paymentId = req.query['data.id'] || req.body?.data?.id || (topic === 'payment' ? (req.query.id || req.body?.id) : null);
  if (topic !== 'payment' || !paymentId) return res.sendStatus(200); // outros avisos (ex.: merchant_order) não interessam
  try {
    await pedidos.processarNotificacao(paymentId);
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err?.message || err);
    pedidos.registrarEvento({ origem: 'webhook', payment_id: paymentId, resultado: 'erro', detalhe: String(err?.message || err).slice(0, 200) });
    // Erro de verdade (rede, banco ocupado…): responde 500 para o Mercado Pago TENTAR DE NOVO mais tarde.
    // (Antes respondia sempre 200 e a notificação se perdia — o pedido pago ficava "pendente".)
    res.sendStatus(500);
  }
});

router.diagnose = diagnose;
module.exports = router;
