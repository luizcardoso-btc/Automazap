# Ligar o robô ao Instagram (@nextapbr)

> **Leia primeiro:** a documentação oficial da Meta pede login e não pôde ser conferida enquanto este código foi escrito.
> Os formatos de mensagem e webhook seguem o que guias de 2026 descrevem. Os nomes de menus da Meta mudam com frequência.
> Por isso o painel tem o **Simulador** (testa tudo sem a Meta) e as respostas de erro aparecem em **Conversas**.
> Se algo recusar, o erro da Meta aparece lá, e é com ele que se ajusta.

## 0. Publicar o robô (Railway)
1. Crie um repositório no GitHub só para esta pasta e suba os arquivos (sem `node_modules`).
2. Railway → New Project → Deploy from GitHub → escolha o repositório.
3. **Volume:** serviço → Settings → Volumes → montar em `/data`. Sem isso os fluxos somem a cada deploy.
4. **Variables:** `ADMIN_PASSWORD`, `SITE_URL`, `META_VERIFY_TOKEN` (invente um texto). As outras três vêm da Meta (passos abaixo).
5. Settings → Networking → gere o domínio (ou use um subdomínio seu, como `bot.nextapbrasil.com.br`).
6. Abra o endereço, entre com a senha e teste no **Simulador**: "qual o preço?", "quanto custa a nextap?", "NFC", "quero".

## 1. Conta do Instagram
- Precisa ser **Profissional** (Comercial ou Criador). Pessoal não tem API.
- No app do Instagram: Configurações → Mensagens e respostas de stories → Controles de mensagens → **Ferramentas conectadas** → permitir acesso às mensagens.

## 2. App na Meta
1. developers.facebook.com → **Criar app** (tipo Business/Empresa).
2. Adicione o produto **Instagram** e escolha **API do Instagram com login do Instagram** (*API setup with Instagram login*).
3. Adicione a conta @nextapbr ao app e **gere o token de acesso**. Copie para `IG_ACCESS_TOKEN` no Railway.
4. Configurações do app → Básico → copie o **Chave secreta do app** (App Secret) para `META_APP_SECRET`.
5. Permissões necessárias: mensagens (`instagram_business_manage_messages`) e comentários (`instagram_business_manage_comments`, só se for usar "comente QUERO").

## 3. Webhook
Na mesma tela do produto Instagram → **Configurar webhooks**:
- **URL de retorno:** `https://SEU-DOMINIO/webhook/instagram` (o painel mostra em Configurações)
- **Token de verificação:** o mesmo texto de `META_VERIFY_TOKEN`
- Assine os campos **messages**, **messaging_postbacks** e (se quiser) **comments**.
- Se a Meta pedir para ativar a assinatura da conta, ative para @nextapbr.

O servidor só aceita eventos com a assinatura correta (`X-Hub-Signature-256`, feita com o `META_APP_SECRET`), então sem o segredo certo ele recusa tudo.

## 4. Testar de verdade
- Em modo de desenvolvimento, só funcionam contas **com função no app** (Administrador, Desenvolvedor ou Testador). Use um segundo Instagram seu e dê uma função a ele.
- Desse segundo perfil, mande "qual o preço?" para o @nextapbr. Em segundos devem chegar o botão e as respostas rápidas.
- Veja o resultado em **Conversas**. Se der erro, a mensagem da Meta aparece na própria conversa.
- Se o envio por `me` for recusado, coloque o ID numérico da conta em `IG_USER_ID`.

## 5. Antes de trocar do Youze para este robô
**Desligue a automação do Youze no @nextapbr.** Os dois ligados ao mesmo tempo respondem em dobro.

## Regras do Instagram que o robô já respeita
- Só responde a quem escreveu e **dentro de 24 horas** da última mensagem dela. Não existe mensagem fria.
- Comentário em post: **uma** mensagem privada por comentário, em até 7 dias (em texto, com o link).
- Limite de 8 respostas por pessoa por hora (ajustável) e uma só resposta padrão por período, para nunca entrar em laço.
- Quem pedir atendente ou "parar" deixa o robô em silêncio por esta pessoa.

## Token e backup
- O token do Instagram vale cerca de 60 dias. Em Configurações → **Renovar token**, copie o novo valor para `IG_ACCESS_TOKEN`. Marque uma data para renovar.
- Em Configurações → **Backup do banco** baixe uma cópia de vez em quando (o Volume protege de deploy, não de apagar o serviço).

## Para vender a outros negócios (próxima etapa, não incluída)
Este pacote atende **uma conta**. Para atender clientes, a Meta exige **Advanced Access**: revisão do app (com vídeo), verificação do negócio e, para enviar em nome de terceiros, status de **Tech Provider**. Isso leva semanas.
Além disso, o código precisaria virar multi-cliente: cada cliente com sua conta, token, fluxos e conversas separados, mais login do cliente (OAuth da Meta) e cobrança.

## Conferir a conexão pelo painel
Aba **Instagram** do painel: mostra quais variáveis faltam, testa o token (mostra o @ da conta), tem o botão "Ativar eventos desta conta" e lista os últimos eventos recebidos (inclusive os recusados, com o motivo). Para trocar logo, nome e cor: aba Configurações → Identidade visual.
