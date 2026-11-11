# Legenda — LinkedIn (vídeo Postman → MCP)

Peguei uma collection do Postman e rodei ela inteira sem abrir o Postman.

Só com uma frase no chat. 👇

A collection: 8 requests (GET, POST, PUT, PATCH e DELETE), em 3 pastas, com a URL da API numa variável.

O que eu escrevi pro agente:
"importa a collection e roda tudo"

O que aconteceu:
→ o MCP converteu a collection pra YAML, sem perder nada
→ rodou as 8 requests numa única chamada
→ cada passo com asserção: status, campos, tamanho da lista
→ 8 de 8 passando, em 1,5 segundo

Agora a parte honesta: na primeira tentativa, não passou nenhuma. 😅

Gravando esse vídeo, achei dois bugs no meu próprio conversor. Ele ignorava a variável baseUrl da collection e engolia a query string (o ?postId=1 sumia). Corrigi, escrevi os testes e rodei de novo.

Melhor jeito de testar uma ferramenta de teste: usar ela de verdade.

É open source (MIT) e funciona com Cursor, VS Code + GitHub Copilot, Claude Code e qualquer cliente MCP. Também importa Insomnia, OpenAPI e curl.

E você: ainda roda suas collections na mão, ou já automatizou? Me conta aqui embaixo. 👇

🔗 Link do repositório no primeiro comentário.

#Postman #QA #TesteDeAPI #MCP #InteligenciaArtificial

---

## Primeiro comentário (publique logo depois do post)

Repositório: https://github.com/Mr-Lucasz/conversational-api-test-mcp

A collection usada no vídeo está em video/demo/ — dá pra reproduzir em 2 minutos.

---

## Checklist de publicação

- Suba o MP4 direto no LinkedIn (vídeo nativo), não um link do YouTube.
- Em "Configurações do vídeo", envie `legenda-postman.srt`: o feed toca sem som e a narração vira texto na tela.
- Escolha como miniatura o frame do 8/8 (por volta de 0:51).
- Publique de terça a quinta, entre 8h e 10h ou perto de 12h.
- Responda os comentários na primeira hora; é quando o alcance se decide.
- Marque quem fizer sentido (time, comunidade de QA) no comentário, não no post.