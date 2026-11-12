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

Esse é o formato do VS Code. O Cursor e o Claude Code leem a mesma entrada em `"mcpServers"` no lugar de `"servers"`, sem a linha `"type"`.

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

## Vindo do Postman

Você não refaz os seus requests. Você entrega o que já tem — um comando cURL ou uma collection exportada — e segue trabalhando pelo chat. Tudo abaixo foi executado no servidor compilado; as saídas são as que ele devolveu.

**Onde cada coisa fica.** Tudo fica no projeto cuja API você está testando, não neste repositório:

```text
seu-projeto/
├── .mcp/
│   └── api/
│       ├── orders.yaml              # um YAML por serviço: pode commitar
│       └── shop.yaml
├── .env.mcp.local                   # URLs base, tokens, senhas: nunca commite
├── .gitignore                       # contém .env.mcp.local
└── shop.postman_collection.json     # o seu export: só é lido, nunca alterado
```

### Cole um cURL

> **Você:** transforma isto em um request chamado `create_order`, em `orders.yaml`
>
> ```bash
> curl -X POST "https://httpbin.org/anything/orders?source=app" \
>   -H "Authorization: Bearer demo-token-123" \
>   -H "Content-Type: application/json" \
>   -d '{"item":"notebook","quantity":2}'
> ```

O agente chama `import_curl`, que responde:

```text
definition: .mcp/api/orders.yaml
created: true
requestId: create_order
method: POST
url: "https://httpbin.org/anything/orders"
secretsMovedToEnvFile[1]: CREATE_ORDER_TOKEN
```

e escreve este arquivo. A query string virou `params`, o corpo JSON virou `body`, e o token não está mais nele:

```yaml
# .mcp/api/orders.yaml
version: "1"
base_url: https://httpbin.org
endpoints:
  - id: create_order
    method: POST
    path: /anything/orders
    headers:
      Content-Type: application/json
    params:
      source: app
    body:
      item: notebook
      quantity: 2
    auth: Bearer {{CREATE_ORDER_TOKEN}}
```

O token em si foi acrescentado ao `.env.mcp.local` como `CREATE_ORDER_TOKEN=...`, e o `.env.mcp.local` entrou no `.gitignore` se ainda não estava. Daqui em diante é "roda o `create_order`".

### Entregue uma collection

Exporte a collection no Postman (*Export → Collection v2.1*) e deixe o JSON no projeto ou cole o conteúdo no chat.

> **Você:** aqui está minha collection do Postman, `shop.postman_collection.json`. Converte para `shop.yaml`.

O agente chama `convert_legacy_to_canonical`, que responde:

```text
outputPath: .mcp/api/shop.yaml
source: postman
losses[1]{code,message}:
  POSTMAN_PRE_REQUEST_SCRIPTS,"Some pre-request script lines could not be translated and will not run. Requests: Create order."
endpointCount: 2
```

```yaml
# .mcp/api/shop.yaml
version: "1"
service: Shop
base_url: "{{base_url}}"
variables:
  base_url: https://httpbin.org
  rid: "{{$uuid}}"              # de pm.environment.set("rid", …{{$guid}}…)
endpoints:
  - id: postman_0_List_orders
    method: GET
    path: /anything/orders?status=open
    description: List orders
    headers:
      X-Request-Id: "{{rid}}"
    assert:                      # dos blocos pm.test
      status: 200
      maxDurationMs: 1000
      checks:
        - path: $.args.status
          equals: open
  - id: postman_1_Create_order
    method: POST
    path: /anything/orders
    description: Create order
    body:
      item: notebook
      quantity: 2
    headers:
      Content-Type: application/json
    assert:
      status: 200
    capture:                     # de pm.environment.set("orderItem", pm.response.json().json.item)
      orderItem: $.json.item
```

Cada request da collection, inclusive os de pastas, agora é um endpoint. A lista `losses` é o servidor dizendo o que ficou para trás, e a conversão pede alguns minutos de acabamento — peça ao agente, ele mostra uma prévia de cada mudança antes de escrever:

| O que você tinha no Postman | O que a importação faz | Como terminar |
|-----------------------------|------------------------|---------------|
| O host em cada URL | Vira o `base_url`, tirado da variável da collection usada como host (`{{baseUrl}}/orders`) ou da primeira URL absoluta. Sem nenhuma das duas, o `base_url` fica vazio e `losses` traz `POSTMAN_BASE_URL_UNRESOLVED`. | Nada, quando foi encontrado. Senão, "define o `base_url` como `https://api.exemplo.com`", ou coloque `BASE_URL=...` no `.env.mcp.local` e use `{{BASE_URL}}`. |
| A aba **Authorization** (collection, pasta ou request) | Convertida por request, seguindo a herança do Postman (`inherit`, `noauth`): Bearer e Basic viram `auth`, Digest vira `digest_auth`, API Key vira header ou param. Credenciais literais vão para o `.env.mcp.local`. Outros tipos (OAuth 2.0, AWS, …), e Basic montado com `{{variáveis}}`, aparecem como `POSTMAN_AUTH_UNSUPPORTED`. | Nada, para os convertidos. Para o resto, `auth: Bearer {{TOKEN}}`, mais `capture` + `auth_dependency` quando um request de login gera o token. |
| Scripts de pre-request | Valores gerados viram variáveis: `uuid.v4()`, `crypto.randomUUID()` e `{{$guid}}` → `{{$uuid}}`, `Date.now()` → `{{$timestamp}}`, `new Date().toISOString()` → `{{$isoTimestamp}}`, literais como estão. Qualquer outra linha (assinaturas, `pm.sendRequest`, …) aparece em `losses`, com o nome dos requests. | `capture` + `auth_dependency` para tokens buscados por script; o resto à mão. |
| Testes (`pm.test`) | Traduzidos para `assert`: `to.have.status`, `responseTime` abaixo de, e nos caminhos do corpo `eql`, `include`, `lengthOf`, `exist`, `above`/`below`, `match`. `pm.environment.set("x", jsonData.a.b)` vira `capture`. Scripts da collection e das pastas valem para todos os requests abaixo. O que sobra aparece em `losses`, com o nome dos requests. | `assert` à mão para o resto — veja [verificações de valor](#verificações-de-valor). |
| Variáveis dinâmicas | `{{$guid}}` / `{{$randomUUID}}` viram `{{$uuid}}`; `{{$timestamp}}` (segundos no Postman) vira `{{$timestampSeconds}}`. | — |
| Nomes dos requests | Viram ids como `postman_0_List_orders`. | "Renomeia para `list_orders`." |
| Query string | Fica embutida no `path`; parâmetros desativados são descartados. | Funciona assim; mova para `params` se quiser variar. |
| Corpos | `raw` vira `body`, `x-www-form-urlencoded` vira `form`, GraphQL vira um `body` `{ query, variables }`. `form-data` e arquivos binários não são mapeados e aparecem como `POSTMAN_BODY_MODE`, com o nome dos requests. | Reescreva esses como `form` ou `body`. |
| Headers e params desativados | Ficam de fora, como o Postman faz no request. | — |
| Environments do Postman | Importados com `import_postman_environment` ("importa `staging.postman_environment.json` como STAGING"): cada valor ativo vai para o `.env.mcp.local` como `STAGING_<chave>`, usado quando `set_environment STAGING` está ativo. Chaves existentes são mantidas; os valores nunca voltam na resposta. | O Postman exporta só os valores iniciais: preencha os vazios que ele listar. |

O arquivo da collection só é lido. Guarde, apague ou deixe fora do git — o YAML passa a ser a fonte da verdade.

Quando você pede ao agente para procurar o que importar sem citar um arquivo, o `discover_legacy_api_sources` busca no projeto por `*postman*.json`, `collection*.json`, `openapi*.{yaml,yml,json}`, `swagger*.{yaml,yml}` `insomnia*.{json,yaml}` e `*.har`. Um arquivo com outro nome é convertido quando você passa o caminho.

### Um dia de trabalho, em prompts

| Momento | Você diz |
|---------|----------|
| Primeira vez no projeto | "oi Vander, configura este projeto" |
| Trazendo requests | "transforma este cURL em um request chamado `create_order`" · "converte o `shop.postman_collection.json`" |
| Arrumando uma importação | "define o `base_url` como …" · "renomeia `postman_0_List_orders` para `list_orders`" · "estes requests usam o token do `login`" |
| Executando | "roda o `list_orders`" · "roda em staging" · "mostra o que o `create_order` enviaria" |
| Encadeando | "cria um pedido e depois busca pelo id que voltou" · "salva isso como um fluxo chamado `smoke`" |
| Conferindo | "confere se retorna 200 e se `$.items` não está vazio" · "roda o fluxo smoke" |
| Revisando | "Vander, o `create_order` está sólido?" |

## O que dá para pedir

Cada linha é algo que você faria na mão em um cliente de API.

| Você diz | O que acontece | No Postman você faria |
|----------|----------------|------------------------|
| "Aqui está minha collection do Postman" + o JSON, ou o caminho do arquivo | Converte uma collection, uma spec OpenAPI, um export do Insomnia ou uma gravação HAR para YAML. | Import |
| "Transforma este cURL em um request" + o comando | Cria o request em um YAML; qualquer token que vier vai para o `.env.mcp.local`. | Import → Raw text |
| "Roda o `forecast`" | Envia aquele request e resume a resposta. | Clicar em Send |
| "Roda o fluxo smoke" | Executa os requests de um fluxo em ordem, parando na primeira falha. | Collection Runner |
| — (no CI) `npx conversational-api-test-mcp run` | Roda todos os fluxos e grava um relatório JUnit; falha o job quando um passo falha. | Newman / Postman CLI |
| "Importa `staging.postman_environment.json` como STAGING" | Copia os valores para o `.env.mcp.local` com o prefixo `STAGING_`. | Import → Environment |
| "Confere se a resposta bate com o schema `Order` do `openapi.yaml`" | Valida o corpo contra esse schema. | `tv4` / `ajv` na aba Tests |
| "Faz login e lista os pedidos" | Roda o login antes, guarda o token, usa, e refaz o login em um `401`. | Pre-request script |
| "Cria um post e depois busca pelo id que voltou" | Captura um valor de uma resposta e usa no request seguinte. | `pm.environment.set` na aba Tests |
| "Usa staging" | Troca o ambiente ativo para os próximos requests. | Seletor de environment |
| "Confere se retorna 200 e tem o campo `days`" | Faz asserção de status e de um JSONPath. | `pm.test` na aba Tests |
| "Inicia a exportação e espera ficar pronta" | Repete um request até um campo aparecer. | Laço com `setNextRequest` |
| "Mostra o que o `forecast` enviaria" | Monta o request sem enviar, com as credenciais ocultas. | Console |
| "Adiciona um request que cria um pedido com estes campos" | Escreve uma nova entrada no YAML, mostrando uma prévia antes. | New request |
| "Rode o eval smoke do assistente" | Envia cada pergunta várias vezes e aprova pela taxa de acerto; confere respostas, citações e latência por código. | — |
| "Vander, o `forecast` está sólido?" | Revisa o endpoint em seis eixos e relata as evidências. | — |
| "O Bob consegue ler o pedido da Alice?" | Chama o endpoint com o token de cada outro perfil, esperando 401/403/404 (BOLA). | — |
| "Os asserts do fluxo smoke prestam?" | Quebra cada resposta real de jeitos pequenos e mostra quais regressões nenhum assert perceberia. | — |
| "A API ainda bate com o `openapi.yaml`?" | Envia as requisições e valida status e body contra a spec. | — |
| "Me avisa se o formato da resposta mudar" | Grava um snapshot na primeira execução e aponta o drift nas seguintes. | Comparar no olho |
| "Cria os fluxos de CRUD de pedidos" | Escreve fluxos criar → ler → atualizar → apagar → ler de novo a partir dos endpoints que você já tem. | — |
| "Converte o `checkout.har`" | Transforma uma gravação do navegador em requisições e num fluxo `recorded`, sem copiar as credenciais. | Interceptor / Capture |
| — (terminal) `npx conversational-api-test-mcp mock` | Serve as definições como uma API mock. | Mock server |
| "Exporta os fluxos como Arazzo" · "rascunha um contrato Pact" | Escreve OpenAPI 3.1, Arazzo 1.0 ou Pact v3 em `.mcp/contracts/`. | Export |

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
| `discover_legacy_api_sources` / `convert_legacy_to_canonical` | Importa Postman, OpenAPI, Insomnia ou HAR — de um arquivo ou de texto colado. |
| `import_postman_environment` | Copia um environment exportado do Postman para o `.env.mcp.local`, opcionalmente com prefixo de ambiente. |
| `mutate_assertions` | Teste de mutação dos asserts: dá uma nota aos asserts de um fluxo e mostra os que estão faltando. |
| `check_contract_drift` | Compara as respostas reais com um arquivo OpenAPI / Swagger. |
| `infer_crud_flows` | Propõe (ou escreve) fluxos de CRUD que terminam conferindo que o delete apagou mesmo. |
| `export_contract` | Escreve uma definição como OpenAPI 3.1, Arazzo 1.0 ou um rascunho de Pact v3. |

Toda tool publica annotations do MCP: as que só leem dizem isso (o cliente pode rodá-las sem perguntar), e as que enviam HTTP ou substituem arquivos vêm marcadas como tal.

Ordem recomendada: `list_api_definitions` → `summarize_api_definition` → `set_environment` (se preciso) → `execute_api_request` ou `execute_api_flow`.

## Vander

O **Vander** é uma persona entregue como prompt MCP: um QA sênior de APIs com quem você conversa, em vez de disparar as tools na mão. Nos clientes que expõem prompts MCP ele aparece como comando (por exemplo `/vander`), opcionalmente com o caminho da definição e o id do endpoint. Ele revisa um endpoint pela heurística **VANDER**:

| Eixo | Pergunta | Verificado automaticamente |
|------|----------|----------------------------|
| **V**erbs | O que o caminho faz com métodos que não declara? | Métodos não declarados são rejeitados (405/404/501); `OPTIONS` não dá erro. |
| **A**uthorization | Quem pode chamar? | Sem credencial e com token inválido é rejeitado (401/403). Com `roles`, outro usuário pedindo este objeto é recusado ou recebe 404 (BOLA). |
| **N**egative | O que acontece com entrada ruim? | Cada campo do body removido, com tipo errado, `null` ou vazio é rejeitado (4xx); um campo extra desconhecido não causa 5xx. Com `body_schema`, valores além de `minLength`/`maxLength`/`minimum`/`maximum`, fora do `enum` ou com `format` inválido também são rejeitados. |
| **D**ata | A resposta diz o que deveria? | O request base funciona, o `Content-Type` bate com o corpo, os JSONPaths capturados existem. |
| **E**rrors | Falha bem? | JSON malformado é erro de cliente; nenhuma sonda causa 5xx nem vaza stack trace. |
| **R**esponsiveness | É rápido o bastante? | O request base responde dentro de `maxDurationMs` (padrão 1000). |

Cada eixo também traz ideias `manual` (token expirado, idempotência, rate limiting…) que o Vander explora com as tools normais.

Duas declarações transformam ideias manuais em verificações automáticas:

```yaml
roles:                       # outras identidades, pelo Authorization que cada uma envia
  bob: Bearer {{BOB_TOKEN}}
  support: Bearer {{SUPPORT_TOKEN}}
endpoints:
  - id: get_order
    method: GET
    path: /orders/{{order_id}}
    auth: Bearer {{ALICE_TOKEN}}   # a dona
    allow_roles: [support]          # o suporte pode ler: não é testado
  - id: create_user
    method: POST
    path: /users
    body: { name: Ana, age: 30 }
    body_schema: openapi.yaml#/components/schemas/NewUser   # ou inline
```

`A-role-bob` chama o `get_order` com o token do Bob e falha se o pedido vier: autorização quebrada no nível do objeto (BOLA), o primeiro item do OWASP API Security Top 10. Só são testados endpoints que apontam para um objeto (um `{{placeholder}}` ou um id numérico no caminho), porque se espera que uma lista responda a qualquer usuário. O `body_schema` alimenta as sondas de limite, enum e formato; um import de OpenAPI preenche isso para você.

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
- Macros: `{{$uuid}}`, `{{$timestamp}}` (ms), `{{$timestampSeconds}}`, `{{$isoTimestamp}}`, `{{$date}}`, `{{$date:YYYY-MM-DD HH:mm:ss}}`.
- `{{env.NOME}}` lê o `process.env` do servidor, mas só para nomes listados em `MCP_API_ENV_PASSTHROUGH`.

### Requests

- `base_url` pode ter prefixo de caminho (`https://host/api/v1`); o `path` é anexado a ele. Um `path` absoluto substitui o `base_url`.
- `params` vai como query string; `headers`, `body` (JSON) e `form` (URL-encoded) são interpolados.
- `capture` mapeia um nome de variável de sessão para um JSONPath da resposta; `assert` verifica status, latência e valores — veja [verificações de valor](#verificações-de-valor).

### Autenticação

- `auth: Bearer {{TOKEN}}` define o header `Authorization`.
- `auth_dependency: <id do endpoint>` roda aquele endpoint antes quando faltam as variáveis que ele captura, e de novo após um `401` (desligue com `auth_retry_on_401: false`).
- `digest_auth: { username, password }` faz HTTP Digest.
- `roles` (no topo do arquivo) e `allow_roles` (num endpoint) guiam as verificações de BOLA — veja [Vander](#vander).

### Tracing

`tracing: true` no topo de uma definição envia um header W3C `traceparent` em cada requisição e devolve o `traceId` (em cada passo de fluxo, e junto das falhas nos relatórios de CI), para achar uma chamada que falhou no New Relic, Datadog, Jaeger ou qualquer backend OpenTelemetry. `tracing: { url: "https://seu-apm/trace/{traceId}" }` também devolve um link. Um endpoint que define o próprio `traceparent` mantém o dele.

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

`schema` valida o corpo JSON inteiro contra um JSON Schema — escrito no próprio YAML, ou tirado de um arquivo do projeto com um JSON pointer, normalmente a sua spec OpenAPI:

```yaml
assert:
  status: 200
  schema: openapi.yaml#/components/schemas/Order   # ou inline: { type: object, required: [id] }
```

OpenAPI 3.0 e 3.1 funcionam (`nullable`, `$ref`s internos, `format`s). A falha diz o caminho e a regra, por exemplo `schema: /customer must have required property 'name'`. O arquivo é relido quando muda. Converter um arquivo OpenAPI (em vez de colar o texto) já escreve esse `schema` em todos os endpoints.

`snapshot` compara o body com o que foi gravado na primeira execução, guardado em `.mcp/snapshots/<nome>.json` (faça commit dele):

```yaml
assert:
  snapshot: order                      # shape: chaves e tipos dos valores
  # snapshot: { name: order, mode: values, ignore: [$.requestId] }
```

`shape` (o padrão) pega drift de contrato (um campo que sumiu, mudou de tipo ou apareceu) sem quebrar com dados que mudam todo dia. `values` compara também os valores, mascarando UUIDs, datas, JWTs e ids hexadecimais longos; `ignore` descarta JSONPaths. Uma falha aparece como `snapshot order: $.total: "<number>" → "<string>"`. Para aceitar uma mudança de propósito, rode com `--update-snapshots` (ou `MCP_UPDATE_SNAPSHOTS=1`).

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

## Testando os testes

Uma suíte verde diz que os asserts passaram, não que pegariam alguma coisa. O `mutate_assertions` roda um fluxo (ou uma requisição) uma vez e depois quebra cada resposta real de jeitos realistas, rodando os asserts de novo em cada cópia: um campo some, muda de tipo ou vira `null`, uma lista volta vazia, um valor muda, o status vira 500 ou 404, a resposta fica dez vezes mais lenta. Nada a mais é enviado à API.

Para uma requisição cujo único assert é `{ status: 200, jsonPathExists: $.id }`, contra um pedido mockado (trecho da saída real):

```text
score: 0.17
killed: 5
total: 30
steps[1]{requestId,score,killed,total,note}:
  get_order,0.17,5,30,""
survivors[10]{step,change,addToAssert}:
  get_order,took 1200ms instead of 20ms,"{\"maxDurationMs\":200}"
  get_order,$.status disappeared,"{\"jsonPathExists\":\"$.status\"}"
  get_order,$.items changed type (array → object),"{\"schema\":{\"type\":\"object\",\"required\":[\"items\"],\"properties\":{\"items\":{\"type\":\"array\"}}}}"
  …
moreSurvivors: 15
```

Cada mutação sobrevivente é uma regressão que a suíte deixaria passar, junto com um assert que a pegaria. Fique com os que olham campos estáveis; ids e timestamps mudam entre execuções. `useLastResponse: true` avalia a última resposta da sessão sem enviar nada. Durante as mutações os snapshots são só lidos, nunca regravados.

## Contratos: drift, mocks e exports

**Drift.** O `check_contract_drift` envia as requisições de uma definição (só as de leitura, a menos que `includeDestructive`) e confere cada resposta contra a operação que o arquivo OpenAPI / Swagger documenta: um status não documentado, ou um body que quebra o schema da resposta, é drift. Ele também lista as operações da spec que nenhuma requisição cobre. A correspondência é por método e caminho, com `{{placeholders}}` ou ids reais, com ou sem o base path do servidor.

**Imports que mantêm o vínculo.** Converter um arquivo OpenAPI transforma `{petId}` em `{{petId}}`, copia os exemplos de body e aponta `assert.schema` (resposta de sucesso) e `body_schema` (body da requisição) de volta para a spec. Assim cada execução confere o contrato e o Vander deriva sondas negativas dele.

**Fluxos de CRUD.** O `infer_crud_flows` procura `POST /things` junto de `GET|PUT|PATCH|DELETE /things/{{id}}` e propõe `crud_things`: criar, ler, atualizar, ler, apagar e uma última leitura que precisa responder 404 ou 410, de modo que um delete que não apaga faz o fluxo falhar. O id é capturado da resposta do create (`$.id`, a não ser que você já capture). `apply: true` escreve o fluxo e guarda um `.bak` do arquivo.

**Mock server.** `npx conversational-api-test-mcp mock [--port 4010] [--delay 200]` serve as definições para um frontend ou um job de CI rodar sem a API real. Cada endpoint responde, nesta ordem, com o bloco `mock`, o body de um snapshot `values`, uma amostra gerada do `assert.schema` ou `{}`:

```yaml
- id: get_pet
  method: GET
  path: /pets/{{pet_id}}
  mock: { status: 200, body: { id: "{{pet_id}}", name: Rex } }   # parâmetros do caminho preenchem o body
```

Caminhos literais ganham dos que têm placeholder (`/pets/mine` antes de `/pets/{{id}}`), preflights de CORS são respondidos e cada requisição aparece no log com o endpoint e a origem da resposta. O mock não guarda estado: um POST não cria nada e um DELETE não remove nada, então o último passo de um fluxo de CRUD falha contra ele, como esperado.

**Exports.** O `export_contract` escreve em `.mcp/contracts/`:

- `openapi`: OpenAPI 3.1 a partir das requisições. Placeholders viram parâmetros de caminho, `assert.schema` e `body_schema` viram `$ref`s e `auth` vira um security scheme.
- `arazzo`: os fluxos como workflows Arazzo 1.0, ao lado desse OpenAPI. Captures viram outputs dos passos, lidos pelos passos seguintes (`$steps.create_pet.outputs.pet_id`); placeholders que ninguém captura viram inputs do workflow.
- `pact`: um rascunho Pact v3 com uma interação por endpoint e type matching nos bodies de resposta (vindos do `mock`, de snapshots `values` ou de amostras do schema). Enxugue para o que o consumidor usa antes de publicar num broker.

## Rodando no CI

O mesmo pacote roda seus fluxos no terminal, então o YAML que o agente usa também barra um pipeline:

```bash
npx conversational-api-test-mcp run --env STAGING --reporter junit --out reports/api.xml
```

- Sem arquivo, lê toda definição em `.mcp/api/` e roda cada um dos seus `flows` (um arquivo sem fluxos é pulado e listado). `--flow smoke` escolhe fluxos, `--request get_user` roda requests avulsos, e `--all-endpoints` roda todos os requests um a um — POST e DELETE inclusive.
- `--env` funciona como o `set_environment`; os segredos vêm do `.env.mcp.local` ou, no CI, de um passo que o grava a partir do seu cofre de segredos.
- `--reporter` é `pretty` (padrão), `json` ou `junit` (um testsuite por fluxo, um testcase por passo, lido por GitHub Actions, GitLab, Jenkins e Azure DevOps). `--bail` para no primeiro fluxo que falhar.
- `--update-snapshots` regrava os snapshots que diferem em vez de falhar. Com `tracing` ligado, um passo que falhou mostra o trace id.
- Código de saída `0` quando tudo passou, `1` quando um passo falhou, `2` para erro de uso ou nada para rodar.

```yaml
# .github/workflows/api.yml (trecho)
- run: printf '%s\n' "$ENV_MCP_LOCAL" > .env.mcp.local
  env: { ENV_MCP_LOCAL: "${{ secrets.ENV_MCP_LOCAL }}" }
- run: npx conversational-api-test-mcp run --env STAGING --reporter junit --out reports/api.xml
```

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
| O eixo Negative | BINMEN, de Gwen Diagram e Ash Winter (Boundary, Invalid entries, NULL, Method, Empty, Negative), conforme o [*Test Heuristics Cheat Sheet*](https://www.ministryoftesting.com/articles/ab1cd85c) do Ministry of Testing | A ideia de tratar entrada negativa como preocupação própria. Campo faltando, tipo errado, `null`, vazio e (com `body_schema`) limites, enums e formatos são automatizados. |
| Separar preocupações de entrada e de saída | POISED, de Amber Race (Parameters, Output, Interop, Security, Errors, Data), mesmo cheat sheet | Orienta as ideias manuais de Data e Negative. |
| Quais sondas são "destrutivas" | [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) §9.2.1 (métodos seguros) | `GET`, `HEAD` e `OPTIONS` são enviados livremente; qualquer outro método exige `includeDestructive`. |
| Status esperados | RFC 9110 §15.5.6 (`405`), §15.6.2 (`501`), §15.5.2 (`401`), §15.5.4 (`403`) | Método não declarado deve receber `405` ou `501` (`404` também é aceito); credencial ausente ou inválida deve receber `401` ou `403`. |
| O que o eixo Authorization procura | [OWASP API Security Top 10 – 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), API2 Broken Authentication | Automatizado: sem credencial e token inválido. |
| Allowlist de hosts, limite de tamanho da resposta | OWASP API7 (Server Side Request Forgery) e API4 (Unrestricted Resource Consumption) | Aplicados ao próprio servidor, já que ele faz requests em nome de um agente. |
| O Vander como prompt MCP | [Especificação MCP, Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) | Prompts são "user-controlled": o usuário os escolhe explicitamente, tipicamente como um comando de barra. Por isso a persona é opcional, e não embutida em toda conversa. |
| Persona para o tom, código para os veredictos | Zheng et al., [*When "A Helpful Assistant" Is Not Really Helpful*](https://arxiv.org/abs/2311.10054) (Findings of EMNLP 2024) | Eles relatam que adicionar uma persona ao system prompt não melhorou a acurácia em relação a não usar persona. Por isso nada do que o Vander afirma depende da persona. |
| Sondas negativas a partir do schema, fluxos de CRUD inferidos | [Schemathesis](https://github.com/schemathesis/schemathesis) e o artigo do SBFT '26 [*Schemathesis 4: Multi-Phase Property-Based Testing*](https://dl.acm.org/doi/10.1145/3786155.3795697) | Sondas de limite e de tipo derivadas do schema, e vínculos entre operações inferidos em vez de declarados (o artigo achou 73 links OpenAPI explícitos em 4.094 specs). Aqui as sondas são uma lista fixa e explicável por campo, não geração aleatória, e a cadeia inferida é só criar → ler → atualizar → apagar → ler de novo. |
| Teste de mutação dos asserts | Teste de mutação (PIT, Stryker) e o [*SWE-Mutation*](https://arxiv.org/abs/2605.22175) (2026), que mostrou que suítes escritas por LLM muitas vezes não distinguem uma implementação quebrada de uma correta | O código testado não é mutado; a resposta gravada é. Isso mantém tudo offline e rápido, e combina com uma ferramenta cujos testes são asserts sobre respostas. |
| Verificações de BOLA com perfis | [OWASP API Security Top 10 – 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), API1 Broken Object Level Authorization | Automatizado quando a definição declara uma segunda identidade; autorização em nível de função (API5) continua manual. |
| Snapshots que ignoram dados voláteis | Snapshot / approval testing (snapshots do Jest, "scrubbers" do ApprovalTests) | Modo shape por padrão, para um snapshot de dados reais da API não quebrar todo dia. |
| Drift de contrato em execução | O [oasdiff](https://github.com/oasdiff/oasdiff) compara duas versões de uma spec; aqui a spec é comparada com a API no ar | Correspondência por método e caminho, validação com o mesmo Ajv do `assert.schema`. |
| Import de HAR | Ferramentas de record-and-replay como o [Keploy](https://keploy.io) | Só o formato da gravação: sem captura de tráfego, sem replay de mocks, e as credenciais nunca são copiadas. |
| Exports | [Arazzo 1.0](https://spec.openapis.org/arazzo/latest.html), [especificação Pact v3](https://github.com/pact-foundation/pact-specification/tree/version-3), [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) | O Pact sai como rascunho para revisar, seguindo a recomendação de que contratos de consumidor escritos por agentes precisam de revisão humana antes de barrar qualquer coisa. |
| Trace id nas requisições | [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Só o header `traceparent`; nenhum span é criado ou exportado. |
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
