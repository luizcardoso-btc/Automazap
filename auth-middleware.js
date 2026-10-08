const jwt = require('jsonwebtoken');

// Protege rotas de revendedor: exige um token válido gerado no login/cadastro.
function requireReseller(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente. Faça login novamente.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'reseller') throw new Error('tipo inválido');
    req.resellerId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

// Protege rotas de admin (o fornecedor).
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente. Faça login novamente.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('tipo inválido');
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

module.exports = { requireReseller, requireAdmin };
