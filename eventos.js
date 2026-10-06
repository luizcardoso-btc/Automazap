// Registro em memória dos últimos eventos recebidos no webhook (ajuda a achar o que falta na conexão real).
const lista = [];
function registrar(tipo, resultado, detalhe) {
  lista.unshift({ at: Date.now(), tipo, resultado, detalhe: detalhe ? String(detalhe).slice(0, 200) : '' });
  if (lista.length > 40) lista.length = 40;
}
module.exports = { registrar, lista };
