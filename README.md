# LETARGIA SIMPLES TRADER (`letargia-simples-trader`)

Mercadores para Foundry VTT 13, em português. Sem serviços externos, CDN ou compilação.

## Arquitetura
- **Dados**: flags do módulo no ator-base do mercador (`flags.letargia-simples-trader.shop` e `.catalog`). O tipo e a ficha originais do ator não mudam.
- **Adaptador** (`scripts/adapter.js`): isola moeda, quantidade, preço, empilhamento e criação/remoção de itens. Há um adaptador genérico configurável.
- **Cotação** (`scripts/quote.js`): um único cálculo usado na prévia do jogador e na validação final do mestre.
- **Transação** (`scripts/transaction.js`): o jogador envia pedido por socket; só o mestre responsável (menor ID entre os mestres ativos) processa, em fila única, com recálculo, etapas reversíveis e recibo em sussurro.
- **Interface**: ApplicationV2 + Handlebars (`scripts/apps`, `templates`), cores em `styles/theme.css`.

## Árvore de arquivos
```
letargia-simples-trader/
  module.json
  README.md
  assets/shop.svg
  scripts/ main.js constants.js util.js adapter.js shop.js quote.js transaction.js
  scripts/apps/ trade-app.js merchant-config.js adapter-config.js
  templates/ trade.hbs merchant-config.hbs adapter-config.hbs
  styles/ theme.css trader.css
```

## Instalação
1. Feche o Foundry (ou não) e copie a pasta `letargia-simples-trader` para `Data/modules/`.
2. Abra o mundo como mestre, vá em **Configurações > Gerenciar módulos**, ative o módulo e salve.
3. O manifesto não tem URLs de instalação; a instalação é manual por pasta.

## Primeira loja
1. **Configurações > Configurações do módulo > Adaptador genérico > Configurar adaptador.** Informe o caminho do saldo (ex.: `system.currency.gp`), da quantidade e, se existir, do preço. Clique em **Salvar e diagnosticar** com um personagem de teste e corrija os avisos.
2. No diretório de Atores, clique em **Criar mercador** (ou clique com o botão direito em um ator existente > **Ativar como mercador**; ou use o botão de loja no cabeçalho da ficha).
3. Na configuração, preencha identidade e economia e **arraste itens** para a área Produtos. Defina estoque, preços e ícone da loja.
4. Coloque o token do mercador na cena. Jogadores abrem a loja com **duplo clique**. Mestre: duplo clique abre a loja, **Shift + duplo clique** abre a ficha original; a configuração fica no botão "Configurar loja".
5. Mantenha um mestre conectado: sem ele a loja só consulta.

Observação: ao ativar, o módulo eleva a permissão padrão do ator para **Limitado** (se estiver menor). Isso é necessário para o cliente do jogador receber o ator e **não permite editar**.

## Adaptador genérico
- Moeda única, com precisão de 0 a 4 casas; os cálculos usam unidades inteiras mínimas. Não altere a precisão depois de montar catálogos.
- Quantidade: caminho numérico inteiro no Item (ex.: `system.quantity`). **Se o sistema não tem quantidade, deixe o campo vazio**: cada item da ficha vale 1 unidade, comprar N cria N cópias separadas e vender remove a cópia escolhida.
- **Importar itens da ficha**: na configuração do mercador, o botão importa todos os itens (armas, armaduras etc.) da ficha do ator para a loja, na quantidade em que estão, agrupando iguais. A ficha não é alterada e repetir a importação ignora o que já entrou. Para limitar os tipos importados/negociáveis, use o campo de tipos.
- Preço: caminho numérico opcional. Sem ele (ou se o campo for objeto, como valor + denominação) defina o preço manualmente no catálogo; itens do jogador sem preço legível não podem ser vendidos.
- Moeda do mercador limitada usa a moeda da ficha do próprio ator mercador.
- Sistemas com várias denominações, campos derivados ou estruturas próprias exigem adaptador próprio, registrado com `game.modules.get("letargia-simples-trader").api.registerAdapter(obj)` com o mesmo formato de `Generic` em `adapter.js`.

## Limitações reais
- **Nada foi testado dentro do Foundry.** Foram feitas checagem de sintaxe e testes lógicos com mocks (disputa pela última unidade, saldos, venda, requestId repetido, quantidade negativa, mudança de preço, rollback). A integração com as APIs da v13 deve ser verificada.
- Pontos que dependem de comportamento da v13 que não pude confirmar: o 2º argumento `senderId` do `game.socket.on` (se vier vazio, a loja falha de forma segura para jogadores), a sobrescrita de `Token#_onClickLeft2`, os nomes dos hooks de menu de contexto e o botão no cabeçalho da ficha.
- Mercadores não vinculados: o estoque sempre pertence ao ator-base do mundo.
- Não há transação atômica. Há compensação (reversão) das etapas; se a reversão falhar, os mestres recebem um sussurro de falha crítica.
- Resultados de pedidos ficam apenas em memória do mestre; se ele reconectar, o resultado de uma consulta fica "desconhecido" (o jogador é orientado a conferir o inventário; nada é reenviado automaticamente).
- Itens que referenciam IDs de outros itens (contêineres) não são tratados.
- Arrastar entre lados não foi implementado; a operação é por cliques (clique adiciona, clique direito remove uma unidade).
- Quem tem acesso ao console pode ler o catálogo do mercador (ele é público para jogadores que veem o ator).

## Roteiro de testes no Foundry (a executar)
1. Mestre cria e configura um mercador; recarregue e confira persistência.
2. Jogador comum dá duplo clique no token, abre a loja e não consegue editar o ator.
3. Compra, venda e carrinho misto: confira saldos, inventários e o recibo em sussurro.
4. Sem dinheiro, sem estoque, quantidade inválida: a operação é bloqueada.
5. Dois jogadores disputam a última unidade: apenas um compra.
6. Clique duplo rápido em "Confirmar troca": uma única transação.
7. Jogador tenta negociar por personagem alheio (via console): recusado.
8. Ícone da loja diferente não altera o item original.
9. Desconecte o mestre: consulta funciona, confirmação fica desabilitada.
10. Mate a conexão do mestre durante uma troca: nenhuma tentativa de sucesso falso; jogador vê "sem confirmação".
11. Desative o módulo: atores e itens permanecem íntegros (apenas flags ficam).
