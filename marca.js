// Identidade visual do painel: nome, frase, cor e logo (guardados no banco; sobrevivem a deploys se houver Volume).
const { getSetting } = require('./db.js');

const LOGO_PADRAO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="28" fill="#15803d"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-width="9"><path d="M38 78a32 32 0 0 1 0-36"/><path d="M52 70a18 18 0 0 1 0-20"/></g><rect x="64" y="34" width="26" height="52" rx="7" fill="#fff"/><circle cx="77" cy="77" r="3.5" fill="#15803d"/></svg>`;

const cor = () => (/^#[0-9a-fA-F]{6}$/.test(getSetting('brand_color') || '') ? getSetting('brand_color') : '#15803d');
function publica() {
  return {
    nome: getSetting('brand_name') || 'NexTap',
    frase: getSetting('brand_tagline') || 'Atendimento automático no Instagram',
    cor: cor(),
    logo: '/logo?v=' + (getSetting('logo_v') || '0'),
  };
}
function servirLogo(req, res) {
  const d = getSetting('logo_data') || '';
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(d);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (!m || req.query.default !== undefined) return res.type('image/svg+xml').send(LOGO_PADRAO.replace(/#15803d/g, cor()));
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
}
module.exports = { publica, servirLogo };
