# MCP Conversational API

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
axes[5]:
  - axis: V
    name: Verbs
    checks[5]:
      - id: V-options
        title: OPTIONS does not cause a server error
        result: pass
        expected: status not5xx
        actual: status 200 in 656ms
      - id: V-post
        title: POST (not declared for this path) is rejected
        result: skipped
        note: "sends POST (state-changing); rerun with includeDestructive: true"
      - id: V-put
        title: PUT (not declared for this path) is rejected
        result: skipped
        note: "sends PUT (state-changing); rerun with includeDestructive: true"
      - id: V-patch
        title: PATCH (not declared for this path) is rejected
        result: skipped
        note: "sends PATCH (state-changing); rerun with includeDestructive: true"
      - id: V-delete
        title: DELETE (not declared for this path) is rejected
        result: skipped
        note: "sends DELETE (state-changing); rerun with includeDestructive: true"
  - axis: A
    name: Authorization
    checks[2]:
      - id: A-none
        title: Request without credentials is rejected
        result: pass
        expected: "status in [401, 403]"
        actual: status 401 in 435ms
      - id: A-invalid
        title: Request with an invalid token is rejected
        result: fail
        expected: "status in [401, 403]"
        actual: status 200 in 142ms
        note: "{\"authenticated\":true,\"token\":\"[REDACTED]\"}"
  - axis: D
    name: Data
    checks[3]:
      - id: D-baseline
        title: Request as declared succeeds
        result: pass
        expected: status 2xx
        actual: status 200 in 196ms
      - id: D-content-type
        title: Content-Type matches the body actually returned
        result: pass
        expected: Content-Type consistent with the body
        actual: "content-type \"application/json\", body is JSON"
      - id: D-captures
        title: Every captured JSONPath exists in the response
        result: pass
  - axis: E
    name: Errors
    checks[2]{id,title,result}:
      E-no-5xx,No probe made the server answer 5xx,pass
      E-no-leak,Error bodies do not leak stack traces or database errors,pass
  - axis: R
    name: Responsiveness
    checks[1]{id,title,result,expected,actual}:
      R-duration,Baseline answers within the duration budget,pass,<= 1000ms,196ms
```

</details>

Como foi gravado: um script operou o servidor compilado via MCP stdio e salvou a saída da tool mostrada acima, sem edição. A resposta do Vander foi então escrita pelo Claude a partir dessa saída, seguindo o prompt `vander`. Todo número da resposta vem da saída; os tempos serão outros na sua máquina.

## Três apostas

**1. O agente escolhe; o servidor executa.** O agente escolhe um `requestId`, e o servidor monta e envia o request a partir do YAML. Não há `curl` escrito à mão no chat para sair sutilmente errado, e a mesma chamada gera o mesmo request amanhã.

**2. Tokens são orçamento.** `responseDetail`, `jsonPathSelect` e `maxBodyChars` decidem quanto da resposta volta; `execute_api_flow` roda um cenário inteiro em uma chamada; os resultados são codificados em [TOON](https://github.com/toon-format/spec) em vez de JSON.

**3. Uma heurística vale mais que uma personalidade.** O Vander é uma persona, mas o que ele faz é fixo: um checklist montado por código e veredictos calculados a partir de status e tempos. Pesquisa sobre personas em prompts mostrou que elas, sozinhas, não tornam o modelo mais preciso ([fontes](#de-onde-vêm-as-ideias)); por isso a personalidade serve à conversa e o rigor mora em `run_vander_checks`.

## Início rápido

Requer **Node.js ≥ 20**.

```bash
npm ci
npm run build
```

Registre o servidor no seu cliente MCP, apontando para `dist/index.js`:

```json
{
  "servers": {
    "mcp-conversational-api": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/absoluto/para/mcp-conversational-api/dist/index.js"]
    }
  }
}
```

No projeto que você quer testar, crie `.mcp/api/` e adicione uma definição (veja [`examples/default.example.yaml`](examples/default.example.yaml)):

```yaml
version: "1"
service: weather
base_url: "{{BASE_URL}}"
flows:
  smoke:
    steps:
      - get_token
      - requestId: forecast
        assert:
          jsonPathExists: $.days
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
```

Coloque os segredos em **`.env.mcp.local`** na raiz do workspace e **nunca faça commit dele**:

```dotenv
BASE_URL=https://api.example.com/v1
CLIENT_ID=...
CLIENT_SECRET=...
STAGING_BASE_URL=https://staging.example.com/v1
```

Depois peça ao agente de forma explícita, por exemplo: *"rode o fluxo `smoke` de `.mcp/api/weather.yaml` pelo MCP"*.

## Tools

| Tool | Para quê |
|------|----------|
| `list_api_definitions` | Lista os YAMLs em `.mcp/api/` (glob, paginação, ordenação, projeção de campos). |
| `summarize_api_definition` | Triagem barata: ids de endpoints, chaves de variáveis, nomes de fluxos. |
| `read_api_definition` | Definição completa e validada. |
| `execute_api_request` | Executa um endpoint. |
| `execute_api_flow` | Executa vários endpoints em uma chamada — `steps` inline ou um `flowName` declarado no YAML. |
| `dry_run_request` | Mostra o request que seria enviado, sem enviar. |
| `assert_response` | Asserção sobre a última resposta (`status`, `jsonPathExists`). |
| `set_environment` | Seleciona o ambiente ativo (`CURRENT_ENV`). |
| `set_environment_variable` / `get_environment_variable` | Variáveis de sessão. |
| `explain_request_context` | Quais chaves de variável estão disponíveis e de onde vêm. |
| `upsert_canonical_api_definition` | Cria / acrescenta definições (dry-run por padrão). |
| `reorganize_mcp_api_definitions` | Funde vários YAMLs em menos arquivos (planeja, depois aplica). |
| `plan_vander_checks` / `run_vander_checks` | Revisão VANDER de um endpoint: checklist e, depois, execução automática agrupada por eixo. |
| `discover_legacy_api_sources` / `convert_legacy_to_canonical` | Importa arquivos Postman, OpenAPI ou Insomnia. |

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

As duas tools funcionam sem o prompt também:

- `plan_vander_checks` devolve o checklist de um `requestId` e não envia nada.
- `run_vander_checks` executa as verificações automáticas e devolve pass / fail / skipped por eixo. As sondas nunca capturam variáveis. Tudo que envia `POST`, `PUT`, `PATCH` ou `DELETE` é **pulado, a menos que `includeDestructive: true`**, então revisar um endpoint de escrita é uma decisão explícita.

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
- `capture` mapeia um nome de variável de sessão para um JSONPath da resposta; `assert` verifica `status` e/ou `jsonPathExists`.

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

## Mantendo a saída pequena

- `responseDetail: "minimal"` devolve só status, duração e capturas; `"summary"` (padrão) acrescenta um preview do corpo limitado a 8.000 caracteres; `"full"` sobe o limite para 50.000.
- `jsonPathSelect` projeta o corpo antes de serializar.
- `execute_api_flow` troca N chamadas de tool por uma.
- Definições parseadas e o `.env.mcp.local` ficam em cache na memória, invalidado pelo `mtime` do arquivo.

## Modelo de segurança

O servidor roda localmente com os seus privilégios e é dirigido por um LLM; trate respostas de API e definições como entrada não confiável.

- **Redação.** Headers de autenticação, valores sob chaves JSON com cara de credencial (`password`, `token`, `secret`, `api_key`, …), strings com formato de JWT, parâmetros de query com credenciais e credenciais capturadas voltam como `[REDACTED]`. Os valores reais continuam na sessão e seguem sendo usados nos requests seguintes. A redação se baseia em nome e formato: é uma rede de segurança, não uma garantia.
- **Sem acesso implícito ao ambiente.** O `process.env` não faz parte do contexto de interpolação; só os nomes listados em `MCP_API_ENV_PASSTHROUGH` são alcançáveis, via `{{env.NOME}}`.
- **Respostas são dados.** Valores capturados de uma resposta são inseridos literalmente e nunca reexpandidos como template.
- **Escritas ficam confinadas** a `.mcp/api/` e são dry-run por padrão.
- **Allowlist de hosts opcional.** `MCP_API_ALLOWED_HOSTS` restringe os requests — inclusive cada salto de redirect — aos hostnames listados. Vem desligada e não é uma defesa completa contra SSRF (não verifica faixas privadas nem DNS rebinding).

| Variável de ambiente | Efeito |
|----------------------|--------|
| `MCP_WORKSPACE_ROOT` | `workspaceRoot` padrão quando a chamada da tool omite. |
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
