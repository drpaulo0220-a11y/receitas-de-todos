# Receitas de Todos

Uma comunidade de culinária para publicar receitas, comentar, avaliar, salvar favoritas e moderar conteúdos.

## Tecnologias

- Node.js
- Express
- EJS
- SQLite
- Better-SQLite3
- bcryptjs
- express-session
- multer

## Requisitos

- Node.js 18+
- npm

## Instalação

```bash
npm install
npm start
```

Acesse: http://127.0.0.1:3000

## Testes

Execute `npm test` para verificar a sintaxe do app e rodar os testes integrados de cadastro, receitas, upload, comentários, moderação e persistência de sessão.

## Conta administradora local

Na primeira inicialização, o servidor cria a conta `admin@receitasdetodos.com` com uma senha aleatória e mostra essa senha no terminal. Guarde-a. Para definir uma senha própria, configure `ADMIN_PASSWORD`; esse valor atualiza a senha do administrador a cada inicialização. Em produção, configure também `ADMIN_EMAIL`, `SESSION_SECRET`, `DATA_DIR` e `UPLOAD_DIR`.

## Funcionalidades implementadas

- Home com receitas recentes, populares e em destaque
- Cadastro e login com autenticação real em servidor
- Sessões persistidas no SQLite
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

O projeto usa SQLite para armazenar usuários, receitas, comentários, curtidas, avaliações, favoritos, denúncias e sessões.
Por padrão, o banco fica em `data/recipes.db`. Os uploads ficam em `public/uploads`.
Use `DATA_DIR` e `UPLOAD_DIR` para apontar para um volume persistente no ambiente de hospedagem.

## Preparar para publicação

O app pode ser hospedado em um serviço que rode Node.js. Antes de publicar, configure estas variáveis no provedor:

```text
NODE_ENV=production
SESSION_SECRET=<segredo longo e aleatório>
ADMIN_EMAIL=<seu e-mail administrativo>
ADMIN_PASSWORD=<senha forte>
DATA_DIR=<caminho do volume persistente para o SQLite>
UPLOAD_DIR=<caminho do volume persistente para as imagens>
```

`SESSION_SECRET` deve ter ao menos 32 caracteres e `ADMIN_PASSWORD` entre 12 e 72 bytes. O comando de inicialização é `npm start`. Em desenvolvimento, o servidor escuta apenas em `127.0.0.1`; para expor na rede, configure `HOST`, `SESSION_SECRET` forte e `ADMIN_PASSWORD` forte. Em produção, `DATA_DIR` e `UPLOAD_DIR` são obrigatórios: aponte ambos para armazenamento persistente do provedor. Um exemplo de montagem é `DATA_DIR=/var/data` e `UPLOAD_DIR=/var/data/uploads`. Serviços com disco temporário podem apagar banco e imagens após reinicializações; não publique com armazenamento efêmero.

O banco SQLite, as sessoes e as imagens podem ficar em armazenamento persistente. Para varias instancias, migre para PostgreSQL e armazenamento de objetos.

Para instalar no celular, publique o site com HTTPS e use “Adicionar à tela inicial” no navegador. O service worker mantém os recursos estáticos disponíveis em cache; as páginas e dados do usuário precisam de conexão.

As credenciais administrativas por variável de ambiente são aplicadas quando o servidor inicia. Se o e-mail configurado já existir, a senha fornecida passa a ser a senha administrativa desse usuário.

## O que ainda pode ser aprimorado

- Upload de imagens para storage externo (Cloudinary ou Supabase Storage)
- Migração do SQLite local para banco gerenciado em produção
- Cache e SEO mais robustos
- Dashboard analítico para moderadores
- Integração com Google AdSense e analytics

## Como administrar a comunidade

- Use o login administrativo para acessar o painel `/admin`
- Revise denúncias abertas e resolva-as
- Na seção “Controle de receitas”, exclua qualquer receita inadequada
- Exclusões administrativas também removem as interações associadas à receita
- As ações de moderação exigem uma sessão autenticada de administrador
