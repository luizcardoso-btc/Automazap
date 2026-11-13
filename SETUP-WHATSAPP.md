# WhatsApp no painel (Evolution API)

A aba **WhatsApp** do painel tem três partes:
- **Conversas:** fale com as empresas da Prospecção pelo painel, com os roteiros de abordagem, objeções e fechamento a um clique. Cada envio e cada resposta entram no histórico da empresa, e quem estava "Novo" passa a "Abordado".
- **Disparos:** mensagens programadas para o seu grupo de vendas (ou um número), uma vez ou repetindo nos dias da semana. Horário de Brasília.
- **Conexão:** QR Code para ligar o número, status e limite diário de primeiras mensagens.

> A conexão é feita pela **Evolution API**, um serviço gratuito que liga um WhatsApp comum por QR Code (como o WhatsApp Web).
> **Não é a API oficial da Meta.** O WhatsApp pode bloquear números que mandam mensagens em massa para quem não conhece.
> Use um **número só para isso** e mantenha o limite diário baixo.
> Os formatos da Evolution foram escritos a partir da documentação pública da versão 2 e testados com uma Evolution simulada; se algo recusar, o erro aparece no painel.

## 1. Colocar a Evolution API no ar (Railway)
1. No mesmo projeto do Railway, crie um serviço novo a partir do template **Evolution API** (ele já traz o banco de dados).
2. Nas variáveis do serviço da Evolution, anote o valor de **AUTHENTICATION_API_KEY** (crie uma senha longa se estiver vazia).
3. Gere um domínio público para o serviço da Evolution (Settings → Networking).

## 2. Ligar o painel à Evolution
No serviço **Automazap** → Variables:
- `EVOLUTION_URL` = o endereço público da Evolution (ex.: `https://evolution-production-xxxx.up.railway.app`)
- `EVOLUTION_API_KEY` = o mesmo valor de `AUTHENTICATION_API_KEY`
- `EVOLUTION_INSTANCE` (opcional) = nome do "aparelho"; padrão `nextap`

## 3. Conectar o número
1. Painel → **WhatsApp → Conexão → Gerar QR Code**.
2. No celular do número que vai ser usado: **WhatsApp → Aparelhos conectados → Conectar um aparelho** e leia o QR Code.
3. O painel configura sozinho o recebimento das mensagens (webhook). Se as respostas não aparecerem, use **Reconfigurar recebimento de mensagens**.

## Regras que o painel já segue
- Nada é enviado sozinho para empresas: cada mensagem é revisada e enviada por você.
- **Limite diário de primeiras mensagens** (padrão 30) para números que nunca responderam. Conversas respondidas e grupos não contam.
- Intervalo de alguns segundos entre envios.
- Mensagens de grupos não entram na caixa de entrada (só os disparos que você programa).
