# FAF — Controle de Placar e Transmissão

Aplicação web local para organizar jogos e controlar saídas gráficas independentes para transmissões. O painel é responsivo e pode ser acessado no computador ou em um celular conectado à mesma rede local.

> **Status:** núcleo administrativo e saídas por partida implementados; confira as validações e limitações ao final deste documento. As seis referências de interface estão em [`design/`](./design/). A marca conceitual e as artes de demonstração não são ativos oficiais da FAF.

## Tecnologias

- Python 3.9+ e bibliotecas padrão para o servidor HTTP e a API.
- SQLite local para partidas, times, cinegrafistas, campeonatos, artes e aparência.
- HTML, CSS e JavaScript sem etapa de build ou framework frontend.
- Server-Sent Events (SSE) para atualizações ao vivo, isoladas pelo identificador da partida.
- [`keyring`](https://pypi.org/project/keyring/) para armazenar chaves de transmissão no Keychain do macOS, em vez de gravá-las no SQLite.

O ambiente disponível para esta implementação não tem Node.js. Por isso, a direção React/Vite planejada inicialmente foi substituída por uma aplicação sem build, usando o Python e o SQLite já disponíveis. Isso reduz a instalação e mantém o funcionamento offline.

## Instalação e execução

No Terminal, na pasta do projeto:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

O servidor exibe os endereços local e da rede. Abra o endereço local no navegador; o painel inicia diretamente, sem login ou PIN.

É possível alterar a porta definindo `FAF_PORT`; a porta padrão é `8765`. O diretório `data/`, criado na primeira inicialização, contém o banco local e está excluído do controle de versão. `FAF_DATA_DIR` permite escolher outro diretório de dados.

### Acesso pelo celular

Com computador e celular na mesma rede Wi-Fi, abra no celular o endereço de rede local que o servidor imprimir. O painel e as saídas de transmissão não exigem login.

O servidor usa HTTP simples e escuta na rede local para permitir o uso em outros dispositivos. O painel não tem autenticação: qualquer pessoa com acesso ao endereço pode ver e alterar partidas, gerenciar cadastros e solicitar a exibição de chaves de transmissão guardadas. Use apenas uma rede confiável e não encaminhe essa porta à internet.

## Funcionalidades

- **Jogos:** cada partida reúne em um único card identificação, campeonato/arte, cinegrafista, placar, período, acréscimos, cronômetro e controles; cadastro, edição e exclusão continuam disponíveis.
- **Partidas simultâneas:** o placar, relógio, estado, cinegrafista, campeonato e URL são mantidos por identificador de partida.
- **Escudos / Times:** cadastro, siglas únicas, pesquisa, ordenação e upload de escudo.
- **Cinegrafistas:** cards com nome, telefone e observações; cadastro e edição também permitem guardar uma chave opcional no Keychain do macOS. A chave não é exibida nos cards nem enviada à saída gráfica.
- **Artes dos Campeonatos:** cada card permite vincular uma ou mais partidas à arte de intervalo; durante o intervalo, a saída exibe somente a imagem associada, sem placar ou textos sobrepostos. Se não houver imagem, a saída fica com o fundo preto neutro.
- **Estúdio do Placar:** configuração da paleta da composição e prévias.
- **Console de transmissão:** link independente por jogo e instruções para OBS.
- **Acessibilidade e telas estreitas:** navegação móvel, formulários empilhados e controles utilizáveis por toque/teclado.
- **Formulários sob demanda:** cadastros e edições só aparecem quando solicitados; ao editar uma partida, o formulário ocupa temporariamente o lugar do card daquela partida.
- **Partidas encerradas:** placar e acréscimos ficam bloqueados; remover um gol exige confirmação.

Uma partida de demonstração em andamento e outra em intervalo são criadas na primeira inicialização, com dados claramente identificados como demonstração. Esses dados podem ser editados ou removidos. As imagens enviadas são validadas como PNG/JPG/WebP (até 3 MB) e armazenadas no banco SQLite local.

O painel não recebe nem reproduz um sinal de vídeo ao vivo: a área de prévia é uma representação visual local. Também não inicia, interrompe ou configura uma transmissão no YouTube; a saída implementada é a composição gráfica do placar para sobreposição.

## Saída de transmissão no OBS Studio

1. Inicie o servidor no computador que executa o OBS.
2. No painel, abra **Console de transmissão** e copie o link da partida desejada (`/overlay/<id>`).
3. No OBS, adicione uma fonte **Navegador** e cole o link.
4. Defina largura e altura conforme a composição, recomendadas em **1920 × 1080**.
5. O placar normal tem fundo transparente; no estado **Intervalo**, a tela de descanso ocupa a área. O estado é atualizado pelo servidor sem recarregar a fonte.

O link público exibe apenas a partida correspondente. As atualizações são enviadas por SSE e as ações de controle são validadas no servidor.

## Dados, limites e segurança

- Os registros e os arquivos de imagem são persistidos em `data/faf.sqlite3`.
- O cronômetro usa o horário do servidor e o tempo acumulado, não um contador local, para se recuperar de recargas.
- A chave de transmissão é salva no Keychain do macOS via `keyring`; o painel não tem login, então qualquer pessoa com acesso ao serviço pode solicitar que uma chave guardada seja revelada.
- A integração com o YouTube não está implementada; cadastrar uma chave não inicia uma transmissão.
- O painel não possui autenticação ou controle de acesso. Execute-o apenas em uma máquina e rede local confiáveis; todos os dispositivos que alcançam o servidor podem administrar os dados.
- É um servidor local de processo único, apropriado para operação de pequeno porte em uma rede confiável. Não oferece balanceamento, TLS, autenticação multiusuário ou replicação de banco. O limite prático depende de CPU, memória, largura de banda e quantidade de fontes OBS conectadas; não há promessa de capacidade ilimitada.
- As saídas são públicas na rede local por URL. Trate os links como informação operacional e não exponha o serviço a redes não confiáveis.

## Regras do cronômetro

- Iniciar começa o período selecionado; pausar congela o tempo daquela partida.
- Entrar em intervalo interrompe o relógio e troca apenas a saída daquela partida para a tela de descanso, que exibe apenas a arte associada.
- Voltar do intervalo inicia o segundo tempo em `00:00`, preservando placar e acréscimos.
- Encerrar define o período final. Zerar exige confirmação, retorna ao estado não iniciado e preserva os gols.
- A seleção manual do intervalo, encerramento ou segundo tempo aciona a transição de estado correspondente.
- A duração regulamentar é apenas informativa: períodos e acréscimos não encerram automaticamente o relógio.

## Referências visuais

- [`design/design.png`](./design/design.png): arte de intervalo e prévia.
- [`design/design-02.png`](./design/design-02.png): Artes dos Campeonatos.
- [`design/design-03.png`](./design/design-03.png): Estúdio do Placar.
- [`design/design-04.png`](./design/design-04.png): Cinegrafistas.
- [`design/design-05.png`](./design/design-05.png): Biblioteca de Escudos.
- [`design/design-06.png`](./design/design-06.png): Lista de Jogos.

Os escudos e materiais oficiais ainda precisam ser fornecidos ou autorizados. O fundo de prévia de jogo e os escudos vazios são representações neutras, não imagens oficiais.

## Validação e pendências

Com autorização, foi feita uma validação manual em ambiente temporário: API iniciou e serviu as páginas; cadastro/edição/exclusão de time funcionou; duas partidas mantiveram placares e estados independentes; a troca para intervalo atualizou a saída por SSE sem recarregar; os dados sobreviveram ao reinício do servidor; e as telas não apresentaram overflow horizontal nos viewports de 375, 768 e 1280 px. A página de saída normal foi conferida com fundo CSS transparente.

Na revisão da interface, os jogos foram conferidos como cards completos sem busca/filtro, os cinegrafistas como cards de informações e as artes com controle de vínculo para partidas. O vínculo enviou uma atualização `PUT` para a partida e foi conferido com a chamada interceptada para não alterar os dados locais. As três telas foram conferidas a 375 px sem overflow horizontal.

A partida encerrada não permite editar placar ou acréscimos; uma tentativa pela API retornou HTTP 409 sem alterar o placar. Cancelar a confirmação para remover um gol também preservou o placar.

Não foram executados testes automatizados. Ainda precisam de validação no ambiente real: gravação e leitura de uma chave de teste no Keychain, abertura como Browser Source no OBS, acesso em um celular físico e substituição das artes/escudos pelos ativos oficiais autorizados. A prévia de vídeo é apenas ilustrativa e não há integração de transmissão ao vivo.
