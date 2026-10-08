# Conversational API Test MCP

[English](README.md)

**Uma bancada de testes de API que o seu agente de IA sabe operar — e um QA chamado Vander para operá-la.**

A maioria das ferramentas de API pressupõe um humano no teclado. Esta pressupõe um agente: você descreve a API uma vez em YAML, e o agente executa requests, encadeia chamadas e revisa endpoints por uma heurística de teste, enquanto o servidor cumpre três promessas que o agente não consegue cumprir sozinho — o request enviado é exatamente o declarado, a resposta custa poucos tokens, e suas credenciais nunca entram na conversa.

É um servidor [MCP](https://modelcontextprotocol.io) via stdio. Funciona com Cursor, VS Code + GitHub Copilot, Claude Code e qualquer outro cliente MCP stdio.

## Como é uma sessão

Uma execução real, gravada em 07/10/2026 contra o [httpbin.org](https://httpbin.org) com a definição de [`examples/httpbin.example.yaml`](examples/httpbin.example.yaml). Só métodos seguros foram enviados.

> **Você:** `/vander` `.mcp/api/httpbin.yaml` `whoami`
>
> **Vander:** Vander aqui. Revisando `GET /bearer` no httpbin.org. O plano tem 13 verificações automáticas; 4 delas enviariam POST, PUT, PATCH ou DELETE, então deixei essas de fora.
>
> 8 passaram, 1 falhou, 4 puladas.
>
> - **V** ✅ `OPTIONS` → `200`. POST / PUT / PATCH / DELETE não enviados.
> - **A** ❌ Sem credencial → `401`, como deve ser. Mas `Bearer vander-invalid-token` → `200` com `"authenticated": true`.
> - **N** ⚪ Nada a negar: sem body, sem parâmetros de query, sem id no caminho.
> - **D** ✅ Base `200`, `application/json` com corpo JSON, `$.authenticated` presente.
> - **E** ✅ Nenhum `5xx`, e nada vazou no `401`.
> - **R** ✅ 196 ms para um limite de 1000 ms. Uma amostra, não um teste de carga.
>
> Um achado: o endpoint aceita qualquer bearer token. Ele verifica que existe um token, não que o token é válido. Para um serviço de eco como o httpbin isso é esperado; em uma API real, é a diferença entre autenticação e checagem de header.
>
> Não testado: os quatro verbos que alteram estado, token expirado, token de outro usuário, rate limiting.

<details>
<summary>A saída da tool por trás dessa resposta (<code>run_vander_checks</code>, literal)</summary>

```text
endpoint:
  id: whoami
  method: GET
  path: /bearer
summary:
  pass: 8
  fail: 1
  skipped: 4
  manual: 6
checks[13]{id,result,detail}:
  V-options,pass,status 200 in 655ms
  V-post,skipped,state-changing (POST)
  V-put,skipped,state-changing (PUT)
  V-patch,skipped,state-changing (PATCH)
  V-delete,skipped,state-changing (DELETE)
  A-none,pass,status 401 in 605ms
  A-invalid,fail,status 200 in 605ms
  D-baseline,pass,status 200 in 142ms
  D-content-type,pass,"content-type \"application/json\", body is JSON"
  D-captures,pass,""
  E-no-5xx,pass,""
  E-no-leak,pass,""
  R-duration,pass,142ms
failures[1]{id,title,expected,actual,note}:
  A-invalid,Request with an invalid token is rejected,"status in [401, 403]",status 200 in 605ms,"{\"authenticated\":true,\"token\":\"[REDACTED]\"}"
hint: "4 state-changing probes not sent; ask the user, then rerun with includeDestructive: true"
```

</details>

Como foi gravado: um script operou o servidor compilado via MCP stdio e salvou a saída da tool mostrada acima, sem edição. A resposta do Vander foi então escrita pelo Claude a partir dessa saída, seguindo o prompt `vander`. Todo número da resposta vem da saída; os tempos serão outros na sua máquina.

## Três apostas

**1. O agente escolhe; o servidor executa.** O agente escolhe um `requestId`, e o servidor monta e envia o request a partir do YAML. Não há `curl` escrito à mão no chat para sair sutilmente errado, e a mesma chamada gera o mesmo request amanhã.

**2. Tokens são orçamento.** `responseDetail`, `jsonPathSelect` e `maxBodyChars` decidem quanto da resposta volta; `execute_api_flow` roda um cenário inteiro em uma chamada; os resultados são codificados em [TOON](https://github.com/toon-format/spec) em vez de JSON.

**3. Uma heurística vale mais que uma personalidade.** O Vander é uma persona, mas o que ele faz é fixo: um checklist montado por código e veredictos calculados a partir de status e tempos. Pesquisa sobre personas em prompts mostrou que elas, sozinhas, não tornam o modelo mais preciso ([fontes](#de-onde-vêm-as-ideias)); por isso a personalidade serve à conversa e o rigor mora em `run_vander_checks`.

## Como funciona

Você testa uma API conversando com o seu agente. Três peças tornam isso possível:

| Peça | Onde | O que é | Se você conhece o Postman |
|------|------|---------|---------------------------|
| **Definições** | `.mcp/api/*.yaml` | Seus requests, descritos uma vez e versionados junto com o código. | A collection |
| **Segredos e ambientes** | `.env.mcp.local` | URLs base, tokens e senhas. Fica só na sua máquina. | O environment |
| **A conversa** | Seu cliente MCP | Você pede em linguagem natural; o agente chama este servidor; o servidor envia o request. | O Send, o Runner e a aba Tests |

## Primeiros passos

Requer **Node.js ≥ 20**.

**1. Compile o servidor e registre no seu cliente MCP.**

```bash
npm ci
npm run build
```

```json
{
  "servers": {
    "conversational-api-test-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/absoluto/para/conversational-api-test-mcp/dist/index.js"]
    }
  }
}
```

**2. Abra o projeto cuja API você quer testar e diga `oi Vander`.**

Ele explica a configuração, confere quais peças o seu projeto já tem e se oferece para criar as que faltam. Ao aceitar, ele roda `init_workspace`, que escreve os três itens abaixo e nunca sobrescreve um arquivo existente. Você também pode criá-los na mão.

**3. A pasta `.mcp/api/` e o seu primeiro YAML.** Um arquivo por serviço. Cada request tem um `id`, que é como você e o agente se referem a ele.

```yaml
# .mcp/api/weather.yaml
version: "1"
service: weather
base_url: "{{BASE_URL}}"
endpoints:
  - id: get_token
    method: POST
    path: /oauth/token
    form:
      grant_type: client_credentials
      client_id: "{{CLIENT_ID}}"
      client_secret: "{{CLIENT_SECRET}}"
    capture:
      TOKEN: $.access_token
  - id: forecast
    method: GET
    path: /forecast
    params:
      city: lisbon
    auth: Bearer {{TOKEN}}
    auth_dependency: get_token
flows:
  smoke:
    steps:
      - requestId: forecast
        assert:
          status: 200
          jsonPathExists: $.days
```

Raramente você precisa escrever isso na mão. **Cole um comando cURL, cole uma collection inteira do Postman (o JSON exportado) ou aponte para um arquivo OpenAPI / Insomnia, e o servidor escreve o YAML para você.** Os tokens que vierem junto vão para o `.env.mcp.local` e são trocados por `{{VARIAVEL}}`, então o YAML continua seguro para commitar.

**4. O arquivo `.env.mcp.local`.** Crie na raiz do projeto, ao lado de `.mcp/`. Ele guarda o que cada `{{...}}` significa. **É você quem preenche, ele precisa estar no `.gitignore`, e os valores nunca vão para o chat.**

```dotenv
# .env.mcp.local
BASE_URL=https://api.example.com/v1
CLIENT_ID=...
CLIENT_SECRET=...
STAGING_BASE_URL=https://staging.example.com/v1
```

Um prefixo transforma um YAML em vários ambientes: depois de "usa staging", `{{BASE_URL}}` lê `STAGING_BASE_URL` primeiro e cai para `BASE_URL`.

**5. Peça.** Ainda sem nada para escrever? O `init_workspace` coloca uma demonstração contra o httpbin.org que roda sem nenhum segredo, e [`examples/`](examples/) tem mais três para copiar para `.mcp/api/`.

## O que dá para pedir

Cada linha é algo que você faria na mão em um cliente de API.

| Você diz | O que acontece | No Postman você faria |
|----------|----------------|------------------------|
| "Aqui está minha collection do Postman" + o JSON, ou o caminho do arquivo | Converte uma collection, uma spec OpenAPI ou um export do Insomnia para YAML. | Import |
| "Transforma este cURL em um request" + o comando | Cria o request em um YAML; qualquer token que vier vai para o `.env.mcp.local`. | Import → Raw text |
| "Roda o `forecast`" | Envia aquele request e resume a resposta. | Clicar em Send |
| "Roda o fluxo smoke" | Executa os requests de um fluxo em ordem, parando na primeira falha. | Collection Runner |
| "Faz login e lista os pedidos" | Roda o login antes, guarda o token, usa, e refaz o login em um `401`. | Pre-request script |
| "Cria um post e depois busca pelo id que voltou" | Captura um valor de uma resposta e usa no request seguinte. | `pm.environment.set` na aba Tests |
| "Usa staging" | Troca o ambiente ativo para os próximos requests. | Seletor de environment |
| "Confere se retorna 200 e tem o campo `days`" | Faz asserção de status e de um JSONPath. | `pm.test` na aba Tests |
| "Inicia a exportação e espera ficar pronta" | Repete um request até um campo aparecer. | Laço com `setNextRequest` |
| "Mostra o que o `forecast` enviaria" | Monta o request sem enviar, com as credenciais ocultas. | Console |
| "Adiciona um request que cria um pedido com estes campos" | Escreve uma nova entrada no YAML, mostrando uma prévia antes. | New request |
| "Rode o eval smoke do assistente" | Envia cada pergunta várias vezes e aprova pela taxa de acerto; confere respostas, citações e latência por código. | — |
| "Vander, o `forecast` está sólido?" | Revisa o endpoint em seis eixos e relata as evidências. | — |

## Tools

| Tool | Para quê |
|------|----------|
| `list_api_definitions` | Lista os YAMLs em `.mcp/api/` (glob, paginação, ordenação, projeção de campos). |
| `summarize_api_definition` | Triagem barata: ids de endpoints, chaves de variáveis, nomes de fluxos. |
| `read_api_definition` | Definição completa e validada. |
| `execute_api_request` | Executa um endpoint. |
| `execute_api_flow` | Executa vários endpoints em uma chamada — `steps` inline ou um `flowName` declarado no YAML. |
| `dry_run_request` | Mostra o request que seria enviado, sem enviar. |
| `assert_response` | Asserção sobre a última resposta: status, latência e verificações de valor. |
| `run_eval` | Avalia um endpoint cuja resposta varia (LLM / RAG / busca): casos × repetições, taxa de acerto e, opcionalmente, amostras para o agente julgar. |
| `set_environment` | Seleciona o ambiente ativo (`CURRENT_ENV`). |
| `set_environment_variable` / `get_environment_variable` | Variáveis de sessão. |
| `explain_request_context` | Quais chaves de variável estão disponíveis e de onde vêm. |
| `init_workspace` | Cria `.mcp/api/`, uma definição de demonstração, o modelo de `.env.mcp.local` e a linha no `.gitignore`. |
| `upsert_canonical_api_definition` | Cria / acrescenta definições (dry-run por padrão). |
| `reorganize_mcp_api_definitions` | Funde vários YAMLs em menos arquivos (planeja, depois aplica). |
| `summon_vander` | Entrega ao agente a persona Vander quando você o chama pelo nome. |
| `plan_vander_checks` / `run_vander_checks` | Revisão VANDER de um endpoint: checklist e, depois, execução automática — uma linha por verificação, com o eixo no prefixo do id. |
| `import_curl` | Transforma um comando `curl` colado em um request dentro de um YAML. |
| `discover_legacy_api_sources` / `convert_legacy_to_canonical` | Importa Postman, OpenAPI ou Insomnia — de um arquivo ou de texto colado. |

Ordem recomendada: `list_api_definitions` → `summarize_api_definition` → `set_environment` (se preciso) → `execute_api_request` ou `execute_api_flow`.

## Vander

O **Vander** é uma persona entregue como prompt MCP: um QA sênior de APIs com quem você conversa, em vez de disparar as tools na mão. Nos clientes que expõem prompts MCP ele aparece como comando (por exemplo `/vander`), opcionalmente com o caminho da definição e o id do endpoint. Ele revisa um endpoint pela heurística **VANDER**:

| Eixo | Pergunta | Verificado automaticamente |
|------|----------|----------------------------|
| **V**erbs | O que o caminho faz com métodos que não declara? | Métodos não declarados são rejeitados (405/404/501); `OPTIONS` não dá erro. |
| **A**uthorization | Quem pode chamar? | Sem credencial e com token inválido é rejeitado (401/403). |
| **N**egative | O que acontece com entrada ruim? | Cada campo de primeiro nível do body, removido um por vez, é rejeitado (4xx). |
| **D**ata | A resposta diz o que deveria? | O request base funciona, o `Content-Type` bate com o corpo, os JSONPaths capturados existem. |
| **E**rrors | Falha bem? | JSON malformado é erro de cliente; nenhuma sonda causa 5xx nem vaza stack trace. |
| **R**esponsiveness | É rápido o bastante? | O request base responde dentro de `maxDurationMs` (padrão 1000). |

Cada eixo também traz ideias `manual` (token de outro usuário, valores de limite, idempotência, rate limiting…) que o Vander explora com as tools normais.

Em clientes sem suporte a prompts — ou quando você preferir só conversar — chame pelo nome: "oi Vander, revisa o `whoami`". As instruções do servidor mandam o agente chamar `summon_vander`, que entrega o mesmo roteiro.

As tools de verificação funcionam sem a persona também:

- `plan_vander_checks` devolve o checklist de um `requestId` e não envia nada.
- `run_vander_checks` executa as verificações automáticas e devolve pass / fail / skipped por verificação (o prefixo do id é o eixo), com o detalhe das falhas à parte. As sondas nunca capturam variáveis. Tudo que envia `POST`, `PUT`, `PATCH` ou `DELETE` é **pulado, a menos que `includeDestructive: true`**, então revisar um endpoint de escrita é uma decisão explícita.

VANDER parte da heurística VADER, de Stuart Ashman, e acrescenta um eixo Negative explícito — veja [de onde vêm as ideias](#de-onde-vêm-as-ideias).

## Definições

### Variáveis e ambientes

`{{CHAVE}}` é resolvida a partir de, em prioridade crescente: `variables` do YAML → `.env.mcp.local` → variáveis de sessão (capturas e `set_environment_variable`).

- Depois de `set_environment` (ex.: `STAGING`), `{{BASE_URL}}` resolve `STAGING_BASE_URL` primeiro e cai para `BASE_URL`.
- Placeholders não resolvidos ficam literais (`{{CHAVE}}`) para o problema ficar visível.
- Macros: `{{$uuid}}`, `{{$timestamp}}`, `{{$date}}`, `{{$date:YYYY-MM-DD HH:mm:ss}}`.
- `{{env.NOME}}` lê o `process.env` do servidor, mas só para nomes listados em `MCP_API_ENV_PASSTHROUGH`.

### Requests

- `base_url` pode ter prefixo de caminho (`https://host/api/v1`); o `path` é anexado a ele. Um `path` absoluto substitui o `base_url`.
- `params` vai como query string; `headers`, `body` (JSON) e `form` (URL-encoded) são interpolados.
- `capture` mapeia um nome de variável de sessão para um JSONPath da resposta; `assert` verifica status, latência e valores — veja [verificações de valor](#verificações-de-valor).

### Autenticação

- `auth: Bearer {{TOKEN}}` define o header `Authorization`.
- `auth_dependency: <id do endpoint>` roda aquele endpoint antes quando faltam as variáveis que ele captura, e de novo após um `401` (desligue com `auth_retry_on_401: false`).
- `digest_auth: { username, password }` faz HTTP Digest.

### Fluxos

Cada passo é um id de endpoint ou um objeto:

```yaml
flows:
  create_and_wait:
    steps:
      - create_job
      - requestId: get_job
        poll: { untilJsonPath: "$.finishedAt", maxAttempts: 10, delayMs: 2000 }
        retry: { max: 3, delayMs: 500 }
        acceptStatus: [200]
        assert: { status: 200, jsonPathExists: "$.result" }
        optional: false
```

### Verificações de valor

O `assert` (num request, num passo de fluxo ou pelo `assert_response`) aceita `status`, `jsonPathExists`, `maxDurationMs` e uma lista de `checks`. Cada check lê o valor de um JSONPath em `path` — ou o corpo inteiro como texto, quando `path` é omitido — e todos os operadores nele precisam valer. Todas as verificações que falham são relatadas, não só a primeira.

| Operador | Vale quando |
|----------|-------------|
| `contains` / `containsAny` / `notContains` | O texto tem todas / alguma / nenhuma das strings dadas. |
| `matches` | O texto casa com a expressão regular. |
| `ignoreCase` | Torna os quatro acima insensíveis a maiúsculas. |
| `equals` | O valor é exatamente este (qualquer valor JSON). |
| `min` / `max` | O número está dentro dos limites. |
| `minLength` / `maxLength` | A string ou lista tem essa quantidade de caracteres / itens. |
| `includesAll` / `includesAny` | A lista em `path` contém todos / algum destes valores. Com `minRatio`, o `includesAll` exige só essa fração — é o recall da recuperação. |
| `subsetOf` | Todo valor em `path` também aparece neste outro JSONPath — citações entre os documentos recuperados. |

Um operador que o servidor não conhece é erro na leitura do YAML, nunca uma aprovação silenciosa.

### Evals: endpoints cuja resposta varia

Um request para um LLM, um RAG ou uma busca pode voltar diferente a cada vez, então uma execução verde prova pouco. Um eval envia um request sobre vários **casos**, cada um **repetido**, e aprova o caso pela **taxa de acerto**:

```yaml
evals:
  smoke:
    requestId: ask
    repeat: 3          # cada caso é enviado 3 vezes
    passRate: 0.66     # e passa quando 2 das 3 execuções atendem ao `expect`
    expect:            # aplicado a todo caso
      status: 200
      maxDurationMs: 8000
      checks:
        - path: $.citations
          subsetOf: $.sources[*].id      # nenhuma citação inventada
    judge:             # opcional: amostras para o agente avaliar
      answerPath: $.answer
      contextPath: $.sources[*].text
      questionVariable: question
    cases:
      - name: refund_window
        variables: { question: How many days do I have to ask for a refund? }
        reference: 30 days from delivery.
        expect:
          checks:
            - { path: $.answer, contains: "30" }
            - { path: $.sources[*].id, includesAll: [policy-refunds, faq-returns], minRatio: 0.5 }
      - name: out_of_scope
        variables: { question: Who will win the next election? }
        expect:
          checks:
            - { path: $.answer, matches: "(don't|do not|cannot) (know|answer)", ignoreCase: true }
            - { path: $.citations, maxLength: 0 }
```

Rode com "rode o eval smoke" (`run_eval` + `evalName`), ou passe `requestId` e `cases` inline. O resultado traz uma linha por caso (`passed: 2/3`, latência, quantas respostas diferentes voltaram), as falhas distintas com a frequência de cada uma e a latência p50 / p95.

Saem dele dois tipos de veredito, mantidos separados:

- **Verificado por código** — tudo que está em `expect`. Mesma entrada, mesmo veredito: status, latência, palavras que devem ou não aparecer, recusa para perguntas fora de escopo, documentos esperados entre os recuperados, citações que apontam para documentos recuperados.
- **Avaliado pelo agente** — com `judge`, o resultado leva uma amostra por caso (pergunta, resposta, trechos recuperados, referência) e uma rubrica: `faithfulness`, `relevance`, `context_relevance`, `correctness`, ou critérios nas suas palavras. O servidor não chama modelo nenhum; quem avalia é o agente com quem você está conversando, então o veredito depende desse modelo e é relatado como julgamento.

O que vale saber:

- Cada execução é um request de verdade, em geral pago. O `run_eval` se recusa a começar quando casos × repetições passa de `maxRequests` (padrão 30).
- As execuções de um eval não capturam variáveis nem substituem a última resposta da sessão; o `auth_dependency` continua fazendo login quando preciso.
- Uma resposta em streaming (`text/event-stream`) é dobrada em `{ text, eventCount, events }`: `$.text` é a resposta e `events` guarda o que não era pedaço de texto (fontes, uso, motivo de parada). Use `sse.textPath` no request quando o pedaço de texto estiver num lugar incomum.
- [`examples/rag.example.yaml`](examples/rag.example.yaml) é um ponto de partida completo.

## Mantendo a saída pequena

- `responseDetail: "minimal"` devolve só status, duração e capturas; `"summary"` (padrão) acrescenta o corpo, limitado a 8.000 caracteres, e os headers que costumam importar (`content-type`, `location`, `retry-after`, rate limit…); `"full"` devolve todos os headers e sobe o limite para 50.000.
- O corpo volta uma vez só: `bodyJson` para JSON, `bodyPreview` para texto. Os dois juntos só quando o JSON passa do limite (preview truncado mais `topLevelKeys`).
- `jsonPathSelect` projeta o corpo antes de serializar. Num step do `execute_api_flow` ele devolve o corpo daquele step, sem precisar de uma segunda chamada.
- `execute_api_flow` troca N chamadas de tool por uma.
- Definições parseadas e o `.env.mcp.local` ficam em cache na memória, invalidado pelo `mtime` do arquivo.

## Modelo de segurança

O servidor roda localmente com os seus privilégios e é dirigido por um LLM; trate respostas de API e definições como entrada não confiável.

- **Redação.** Headers de autenticação, valores sob chaves JSON com cara de credencial (`password`, `token`, `secret`, `api_key`, …), strings com formato de JWT, parâmetros de query com credenciais e credenciais capturadas voltam como `[REDACTED]`. Os valores reais continuam na sessão e seguem sendo usados nos requests seguintes. A redação se baseia em nome e formato: é uma rede de segurança, não uma garantia.
- **Sem acesso implícito ao ambiente.** O `process.env` não faz parte do contexto de interpolação; só os nomes listados em `MCP_API_ENV_PASSTHROUGH` são alcançáveis, via `{{env.NOME}}`.
- **Respostas são dados.** Valores capturados de uma resposta são inseridos literalmente e nunca reexpandidos como template.
- **Escritas ficam confinadas.** As tools de definição escrevem só em `.mcp/api/` e são dry-run por padrão. O `init_workspace` também cria o `.env.mcp.local` e o adiciona ao `.gitignore`, e nunca sobrescreve um arquivo existente. As tools de importação acrescentam ao `.env.mcp.local` as credenciais que extraem, sem nunca substituir uma chave que já exista.
- **Allowlist de hosts opcional.** `MCP_API_ALLOWED_HOSTS` restringe os requests — inclusive cada salto de redirect — aos hostnames listados. Vem desligada e não é uma defesa completa contra SSRF (não verifica faixas privadas nem DNS rebinding).

| Variável de ambiente | Efeito |
|----------------------|--------|
| `MCP_WORKSPACE_ROOT` | `workspaceRoot` padrão quando a chamada da tool omite. Sem ela, o servidor reusa o último `workspaceRoot` recebido e, na falta, o diretório em que foi iniciado, se ali já existir `.mcp/api/`. |
| `MCP_API_ALLOWED_HOSTS` | Hostnames permitidos, separados por vírgula. Sem valor = qualquer host. |
| `MCP_API_ENV_PASSTHROUGH` | Nomes de variáveis de ambiente (`*` no fim = prefixo) expostos a `{{env.NOME}}`. Sem valor = nenhum. |
| `MCP_API_MAX_RESPONSE_BYTES` | Limite de tamanho da resposta. Padrão 10 MB. |
| `MCP_API_REVEAL_SECRETS` | `true` desliga a redação. Só para depuração local. |

## De onde vêm as ideias

Nada aqui foi inventado do zero. Isto é o que o projeto toma emprestado, de quem, e o que ele muda.

| Ideia no projeto | Fonte | O que foi aproveitado e o que mudou |
|------------------|-------|--------------------------------------|
| Os eixos do VANDER | Stuart Ashman, [*VADER – a REST API test heuristic*](https://qa-matters.com/2016/07/30/vader-a-rest-api-test-heuristic/) (QA Matters, 2016) | Os cinco eixos originais — Verbs, Authorization, Data, Errors, Responsiveness — são dele. Este projeto acrescenta **N**egative como sexto e transforma parte de cada eixo em verificações executáveis. |
| O eixo Negative | BINMEN, de Gwen Diagram e Ash Winter (Boundary, Invalid entries, NULL, Method, Empty, Negative), conforme o [*Test Heuristics Cheat Sheet*](https://www.ministryoftesting.com/articles/ab1cd85c) do Ministry of Testing | A ideia de tratar entrada negativa como preocupação própria. Hoje só "campo faltando" é automatizado; o resto vem como ideia manual. |
| Separar preocupações de entrada e de saída | POISED, de Amber Race (Parameters, Output, Interop, Security, Errors, Data), mesmo cheat sheet | Orienta as ideias manuais de Data e Negative. |
| Quais sondas são "destrutivas" | [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) §9.2.1 (métodos seguros) | `GET`, `HEAD` e `OPTIONS` são enviados livremente; qualquer outro método exige `includeDestructive`. |
| Status esperados | RFC 9110 §15.5.6 (`405`), §15.6.2 (`501`), §15.5.2 (`401`), §15.5.4 (`403`) | Método não declarado deve receber `405` ou `501` (`404` também é aceito); credencial ausente ou inválida deve receber `401` ou `403`. |
| O que o eixo Authorization procura | [OWASP API Security Top 10 – 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), API2 Broken Authentication | Automatizado: sem credencial e token inválido. API1 e API5 (autorização em nível de objeto e de função) exigem uma segunda identidade, então ficam manuais. |
| Allowlist de hosts, limite de tamanho da resposta | OWASP API7 (Server Side Request Forgery) e API4 (Unrestricted Resource Consumption) | Aplicados ao próprio servidor, já que ele faz requests em nome de um agente. |
| O Vander como prompt MCP | [Especificação MCP, Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) | Prompts são "user-controlled": o usuário os escolhe explicitamente, tipicamente como um comando de barra. Por isso a persona é opcional, e não embutida em toda conversa. |
| Persona para o tom, código para os veredictos | Zheng et al., [*When "A Helpful Assistant" Is Not Really Helpful*](https://arxiv.org/abs/2311.10054) (Findings of EMNLP 2024) | Eles relatam que adicionar uma persona ao system prompt não melhorou a acurácia em relação a não usar persona. Por isso nada do que o Vander afirma depende da persona. |
| Saída em TOON | [Especificação TOON](https://github.com/toon-format/spec) | Usada como está nos resultados das tools. Os autores relatam a maior economia em arrays uniformes e pouca ou nenhuma em dados muito aninhados; este projeto não fez benchmark próprio. |

VANDER é o nome que este projeto dá à heurística estendida e não tem afiliação com os autores acima.

## Problemas comuns

| Sintoma | O que verificar |
|---------|-----------------|
| Lista de definições vazia | O `workspaceRoot` é absoluto e está correto? Existe `.mcp/api/` com arquivos `.yaml`? |
| `401` | `set_environment`, o `auth_dependency` do endpoint, capturas, `.env.mcp.local`. |
| `{{CHAVE}}` enviada literalmente | Nome da chave, prefixo do ambiente (`STAGING_*`) ou — para variáveis do shell — `MCP_API_ENV_PASSTHROUGH`. |
| Um valor aparece como `[REDACTED]` | Esperado para credenciais. Ele continua sendo usado nos requests. |

## Desenvolvimento

| Comando | Descrição |
|---------|-----------|
| `npm run build` | Compila TypeScript para `dist/`. |
| `npm run dev` | Roda do código-fonte com `tsx`. |
| `npm test` | Roda a suíte de testes (`vitest`). |
| `npm run lint` | ESLint. |

## Licença

[MIT](LICENSE)
