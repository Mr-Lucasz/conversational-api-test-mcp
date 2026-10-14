# Legenda — LinkedIn

Nos últimos meses estive cozinhando uma ferramenta.

De tanto usar Postman e Apidog, e de tanto usar agentes e MCP no dia a dia, em um momento de estudo nasceu o Conversational API Test MCP.

A proposta é muito simples: testar API conversando com o seu copiloto.

Precisa de um GET? Ele faz.
POST, PUT, PATCH? Faz também.
Automatizar o token? Faz.
Gerar massa de dados bem complexa? Opa, é pra já.
Asserções de teste? Flows inteiros? Também.

Ele substitui uma ferramenta de teste de API. E, modéstia à parte, virou vício: uso no trabalho, em projetos pessoais, em cursos e minicursos, e a cada uso me impressiono mais com o potencial.

O que tem por baixo:

→ Suas requisições ficam descritas em YAML, versionadas junto com o código. O agente escolhe o que rodar; quem monta e envia o request é o servidor, sempre do mesmo jeito.
→ Suas credenciais ficam na sua máquina e nunca entram na conversa.
→ As respostas voltam enxutas, para não queimar tokens à toa.
→ Já tem coleção no Postman, Insomnia ou OpenAPI? Ele converte. Tem só um curl? Importa também.

E tem o Vander. 😄

Vander é uma brincadeira minha: o QA sênior que mora dentro da ferramenta. O nome vem da heurística VADER, do Stuart Ashman, para teste de API REST: Verbs, Authorization, Data, Errors, Responsiveness. Eu coloquei um N de Negative no meio, e o VADER virou VANDER.

Você pede uma revisão e ele passa o endpoint por esses eixos, com veredictos calculados por código, não por opinião.

No vídeo, uma execução real contra o httpbin.org: 13 verificações, e o Vander apontou um endpoint que aceitava qualquer bearer token.

Funciona com Cursor, VS Code + GitHub Copilot, Claude Code e qualquer cliente MCP via stdio. É open source (MIT).

Repositório: https://github.com/Mr-Lucasz/conversational-api-test-mcp

Se você testa API todo dia, experimenta e me conta o que achou.

#MCP #TesteDeAPI #QA #IA #OpenSource