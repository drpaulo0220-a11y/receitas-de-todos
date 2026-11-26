# Receitas de Todos

Uma comunidade de culinária para publicar receitas, comentar, avaliar, salvar favoritas e moderar conteúdos.

## Tecnologias

- Node.js
- Express
- EJS
- PostgreSQL em produção (Supabase)
- SQLite no desenvolvimento local e nos testes
- Better-SQLite3
- Supabase Storage para imagens em produção
- bcryptjs
- express-session
- multer

## Requisitos

- Node.js 20+
- npm

## Instalação

```bash
npm install
npm start
```

Acesse: http://127.0.0.1:3000

## Testes

Execute `npm test` para verificar a sintaxe do app e rodar os testes integrados de cadastro, receitas, upload, comentários, moderação, armazenamento de imagens e persistência de sessão.

Para testar também o PostgreSQL, defina `TEST_DATABASE_URL` para um banco descartável cujo nome termine em `_test` e rode `npm test`. O teste apaga e recria o schema `public` desse banco; nunca use a URL de produção.

## Conta administradora local

Na primeira inicialização local, o servidor cria a conta `receitaadmin@sdetodos.com` com uma senha aleatória e mostra essa senha no terminal. Guarde-a. Para definir uma senha própria, configure `ADMIN_PASSWORD`. Em produção, configure `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, conforme a seção de publicação.

## Funcionalidades implementadas

- Home com receitas recentes, populares e em destaque
- Cadastro e login com autenticação real em servidor
- Sessões persistidas no PostgreSQL em produção e SQLite localmente
- Publicação, edição e exclusão de receitas
- Curtidas, favoritos e avaliações por estrelas
- Comentários com respostas e denúncias de receitas/comentários
- Perfis com edição de nome, biografia e foto
- Busca por nome, ingrediente, categoria, dificuldade e tempo máximo
- Painel administrativo para receitas, denúncias e suspensão de contas
- Prévia da imagem antes de publicar ou atualizar uma receita
- Painel administrativo com listagem e exclusão de todas as receitas
- Páginas de Sobre, Contato, Privacidade e Termos
- PWA instalável e interface adaptada para celular
- Compartilhamento nativo/link copiável das receitas e metadados SEO por receita
- Espaços reservados para futuro Google AdSense

## Banco de dados e arquivos

Sem `DATABASE_URL`, o app usa SQLite em `data/recipes.db`, adequado para desenvolvimento e testes. Com `DATABASE_URL`, usa PostgreSQL para usuários, receitas, comentários, curtidas, avaliações, favoritos, denúncias e sessões.

Uploads locais ficam em `public/uploads`. Quando `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` estão configuradas, os uploads são enviados para o bucket público do Supabase Storage. Em produção, o app exige PostgreSQL e Supabase Storage para que os dados e imagens sobrevivam a reinicializações da hospedagem.
As tabelas PostgreSQL têm Row Level Security ativado; o acesso ao banco é feito apenas pelo servidor, usando a conexão privada configurada no ambiente.

## Preparar para publicação

O arquivo `render.yaml` prepara um serviço web gratuito no Render. O banco e as imagens ficam no Supabase, evitando depender do disco temporário do serviço web. Para configurar:

1. Crie um projeto Supabase e use o plano gratuito. No painel, copie a URL de conexão PostgreSQL do **Session Pooler** e o Project URL e `service_role` key da API.
2. No Supabase Storage, crie um bucket público chamado `recipe-images`. A chave `service_role` é secreta e deve ficar somente nas variáveis do servidor.
3. No Render, crie um Blueprint conectado a este repositório e selecione o `render.yaml`. Preencha as variáveis marcadas como `sync: false`:

```text
DATABASE_URL=<URL PostgreSQL do Session Pooler do Supabase>
SUPABASE_URL=<Project URL do Supabase>
SUPABASE_SERVICE_ROLE_KEY=<chave service_role do Supabase>
ADMIN_EMAIL=<seu e-mail administrativo>
ADMIN_PASSWORD=<senha forte>
```

O Blueprint define `NODE_ENV=production`, gera `SESSION_SECRET` e configura o bucket `recipe-images`. `ADMIN_PASSWORD` deve ter entre 12 e 72 bytes; `SESSION_SECRET` deve ter pelo menos 32 caracteres. Use uma senha administrativa nova e exclusiva. Nunca salve essas chaves no repositório nem as envie em mensagens.

Na primeira inicialização, o servidor cria o esquema PostgreSQL e carrega o catálogo inicial. O SQLite local não é copiado automaticamente para o Supabase; se já houver dados importantes em `data/recipes.db`, faça a migração/exportação antes de publicar. A rota `/health` verifica a conexão com o banco e é usada pelo Render.

Os planos gratuitos têm limites de uso e disponibilidade; o Supabase pode pausar projetos inativos. Confira os limites atuais dos provedores antes de anunciar o site como serviço sempre disponível.

Para instalar no celular, publique o site com HTTPS e use “Adicionar à tela inicial” no navegador. O service worker mantém os recursos estáticos disponíveis em cache; as páginas e dados do usuário precisam de conexão.

As credenciais administrativas por variável de ambiente são aplicadas quando o servidor inicia. Se o e-mail configurado já existir, a senha fornecida passa a ser a senha administrativa desse usuário.

## O que ainda pode ser aprimorado

- Migração assistida de dados existentes do SQLite local para PostgreSQL
- Cache e SEO mais robustos
- Dashboard analítico para moderadores
- Integração com Google AdSense e analytics

## Como administrar a comunidade

- Use o login administrativo para acessar o painel `/admin`
- Revise denúncias abertas e resolva-as
- Na seção “Controle de receitas”, exclua qualquer receita inadequada
- Exclusões administrativas também removem as interações associadas à receita
- As ações de moderação exigem uma sessão autenticada de administrador
