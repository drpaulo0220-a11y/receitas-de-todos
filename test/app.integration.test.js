const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAFfc0b9AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkGAAAAAAgIY0NdbAAAAABJRU5ErkJggg==', 'base64');
const appState = {
  process: null,
  output: '',
  root: null,
  baseUrl: null,
  userCookie: '',
  adminCookie: '',
  userId: 0,
  recipeId: 0,
  uploadedPath: ''
};

async function findFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startApp() {
  const port = await findFreePort();
  appState.baseUrl = `http://127.0.0.1:${port}`;
  appState.process = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: 'admin123',
      SESSION_SECRET: 'integration-test-secret-with-enough-length',
      DATA_DIR: path.join(appState.root, 'data'),
      UPLOAD_DIR: path.join(appState.root, 'uploads')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  appState.process.stdout.on('data', (data) => { appState.output += data.toString(); });
  appState.process.stderr.on('data', (data) => { appState.output += data.toString(); });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (appState.process.exitCode !== null) {
      throw new Error(`App exited before starting:\n${appState.output}`);
    }
    try {
      const response = await fetch(appState.baseUrl);
      if (response.ok) return;
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`App did not start in time:\n${appState.output}`);
}

async function stopApp() {
  if (!appState.process || appState.process.exitCode !== null) return;
  const child = appState.process;
  child.kill('SIGTERM');
  await once(child, 'exit');
  appState.process = null;
}

async function request(pathname, { method = 'GET', body, cookieKey } = {}) {
  const headers = {};
  if (cookieKey && appState[cookieKey]) headers.Cookie = appState[cookieKey];
  const response = await fetch(`${appState.baseUrl}${pathname}`, {
    method,
    headers,
    body,
    redirect: 'manual'
  });
  const setCookie = response.headers.get('set-cookie');
  if (cookieKey && setCookie) appState[cookieKey] = setCookie.split(';', 1)[0];
  return response;
}

test('community workflows, moderation, upload, and persistent sessions', async (t) => {
  appState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-integration-'));
  fs.mkdirSync(path.join(appState.root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(appState.root, 'uploads'), { recursive: true });
  t.after(async () => {
    await stopApp();
    fs.rmSync(appState.root, { recursive: true, force: true });
  });

  await startApp();

  const listing = await request('/recipes?max_time=30');
  assert.equal(listing.status, 200);
  assert.match(await listing.text(), /Salada de quinoa tropical/);

  const register = await request('/register', {
    method: 'POST',
    body: new URLSearchParams({
      name: 'Pessoa de Teste',
      email: 'person@example.test',
      password: 'strong-test-password'
    }),
    cookieKey: 'userCookie'
  });
  assert.equal(register.status, 302);
  const accountDb = new Database(path.join(appState.root, 'data', 'recipes.db'));
  appState.userId = accountDb.prepare('SELECT id FROM users WHERE email = ?').get('person@example.test').id;
  accountDb.close();

  const profileUpdate = await request('/profile/edit', {
    method: 'POST',
    body: new URLSearchParams({
      name: 'Pessoa Editada',
      bio: 'Perfil de teste',
      avatar_url: 'https://example.test/avatar.png'
    }),
    cookieKey: 'userCookie'
  });
  assert.equal(profileUpdate.headers.get('location'), '/profile');
  assert.match(await (await request('/profile', { cookieKey: 'userCookie' })).text(), /Pessoa Editada/);

  const invalidImageForm = new FormData();
  invalidImageForm.set('title', 'Upload inválido');
  invalidImageForm.set('description', 'Este envio deve ser recusado pelo servidor.');
  invalidImageForm.set('category', 'bolos');
  invalidImageForm.set('prep_time', '15');
  invalidImageForm.set('servings', '2 pessoas');
  invalidImageForm.set('difficulty', 'fácil');
  invalidImageForm.set('ingredients', '1 ingrediente');
  invalidImageForm.set('steps', 'Testar o arquivo');
  invalidImageForm.set('photo', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  const invalidImageResponse = await request('/new-recipe', {
    method: 'POST',
    body: invalidImageForm,
    cookieKey: 'userCookie'
  });
  assert.equal(invalidImageResponse.headers.get('location'), '/new-recipe');
  assert.match(await (await request('/new-recipe', { cookieKey: 'userCookie' })).text(), /não parece ser uma imagem válida/);

  const recipeForm = new FormData();
  recipeForm.set('title', 'Receita de Integração');
  recipeForm.set('description', 'Receita usada para validar funcionalidades do site.');
  recipeForm.set('category', 'bolos');
  recipeForm.set('prep_time', '25');
  recipeForm.set('servings', '3 pessoas');
  recipeForm.set('difficulty', 'fácil');
  recipeForm.set('ingredients', '1 xícara de farinha');
  recipeForm.set('steps', 'Misturar e assar');
  recipeForm.set('photo', new Blob([png], { type: 'image/png' }), 'recipe.png');
  const recipeResponse = await request('/new-recipe', {
    method: 'POST',
    body: recipeForm,
    cookieKey: 'userCookie'
  });
  assert.equal(recipeResponse.status, 302);
  const recipeLocation = recipeResponse.headers.get('location');
  appState.recipeId = Number(recipeLocation.split('/').pop());
  const recipePage = await request(recipeLocation, { cookieKey: 'userCookie' });
  const recipeHtml = await recipePage.text();
  assert.match(recipeHtml, /Receita de Integração/);
  assert.match(recipeHtml, /data-share-recipe/);
  assert.match(recipeHtml, /Receita de Integração \| Receitas de Todos/);
  const imageMatch = recipeHtml.match(/\/uploads\/[^'") ]+/);
  assert.ok(imageMatch);
  appState.uploadedPath = imageMatch[0];
  assert.equal((await request(appState.uploadedPath)).status, 200);

  const recipeSearch = await request('/recipes?max_time=30');
  assert.match(await recipeSearch.text(), /Receita de Integração/);
  const shortSearch = await request('/recipes?max_time=15');
  assert.doesNotMatch(await shortSearch.text(), /Receita de Integração/);

  await request(`/recipe/${appState.recipeId}/comment`, {
    method: 'POST',
    body: new URLSearchParams({ body: 'Comentário principal' }),
    cookieKey: 'userCookie'
  });
  const commentDb = new Database(path.join(appState.root, 'data', 'recipes.db'));
  const rootCommentId = commentDb.prepare('SELECT id FROM comments WHERE recipe_id = ? AND parent_id IS NULL').get(appState.recipeId).id;
  commentDb.close();
  await request(`/recipe/${appState.recipeId}/comment`, {
    method: 'POST',
    body: new URLSearchParams({ parent_id: String(rootCommentId), body: 'Resposta ao comentário' }),
    cookieKey: 'userCookie'
  });
  const commentPage = await request(recipeLocation, { cookieKey: 'userCookie' });
  assert.match(await commentPage.text(), /Resposta ao comentário/);

  const replyDb = new Database(path.join(appState.root, 'data', 'recipes.db'));
  const replyId = replyDb.prepare('SELECT id FROM comments WHERE recipe_id = ? AND parent_id IS NOT NULL').get(appState.recipeId).id;
  replyDb.close();
  await request(`/comment/${replyId}/report`, {
    method: 'POST',
    body: new URLSearchParams({ reason: 'Denúncia de teste' }),
    cookieKey: 'userCookie'
  });

  const adminLogin = await request('/login', {
    method: 'POST',
    body: new URLSearchParams({ email: 'admin@receitasdetodos.com', password: 'admin123' }),
    cookieKey: 'adminCookie'
  });
  assert.equal(adminLogin.status, 302);
  assert.equal((await request('/admin')).status, 302);
  assert.equal((await request('/admin', { cookieKey: 'adminCookie' })).status, 200);

  await stopApp();
  await startApp();
  const persistedAdmin = await request('/admin', { cookieKey: 'adminCookie' });
  assert.equal(persistedAdmin.status, 200);
  const adminHtml = await persistedAdmin.text();
  assert.match(adminHtml, /Pessoa Editada/);
  assert.match(adminHtml, /Denúncia de teste/);

  const suspension = await request(`/admin/user/${appState.userId}/toggle-suspension`, {
    method: 'POST',
    cookieKey: 'adminCookie'
  });
  assert.equal(suspension.headers.get('location'), '/admin');
  assert.equal((await request('/profile', { cookieKey: 'userCookie' })).status, 302);

  const deletion = await request(`/admin/recipe/${appState.recipeId}/delete`, {
    method: 'POST',
    cookieKey: 'adminCookie'
  });
  assert.equal(deletion.headers.get('location'), '/admin');
  assert.equal(fs.existsSync(path.join(appState.root, 'uploads', path.basename(appState.uploadedPath))), false);
  assert.equal((await request(`/recipe/${appState.recipeId}`)).status, 302);
});
