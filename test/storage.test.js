const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ImageStorage } = require('../storage');

const imageTypes = {
  'image/png': { extension: '.png' }
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAFfc0b9AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkGAAAAAAgIY0NdbAAAAABJRU5ErkJggg==', 'base64');

test('stores and removes local uploads', async (t) => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-uploads-'));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const storage = new ImageStorage({ uploadDir, imageTypes });

  const photoUrl = await storage.store({ mimetype: 'image/png', buffer: png });
  const imagePath = path.join(uploadDir, path.basename(photoUrl));
  assert.equal(fs.readFileSync(imagePath).compare(png), 0);

  await storage.remove(photoUrl);
  assert.equal(fs.existsSync(imagePath), false);
});

test('stores cloud uploads and only deletes objects in its configured bucket', async (t) => {
  const objects = new Map();
  const serviceKey = 'test-service-role-key';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' &&
        (req.headers.apikey !== serviceKey || req.headers.authorization !== `Bearer ${serviceKey}`)) {
      res.writeHead(401).end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const match = url.pathname.match(/^\/storage\/v1\/object\/(public\/)?recipe-images\/([\w.-]+)$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const key = match[2];

    if (req.method === 'POST' && !match[1]) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    if (req.method === 'GET' && match[1]) {
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(body);
      return;
    }
    if (req.method === 'DELETE' && !match[1]) {
      objects.delete(key);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(405).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storage = new ImageStorage({
    uploadDir: os.tmpdir(),
    supabaseUrl: baseUrl,
    serviceRoleKey: serviceKey,
    imageTypes,
    bucket: 'recipe-images'
  });

  const photoUrl = await storage.store({ mimetype: 'image/png', buffer: png });
  assert.match(photoUrl, /^http:\/\/127\.0\.0\.1:\d+\/storage\/v1\/object\/public\/recipe-images\//);
  assert.doesNotMatch(photoUrl, new RegExp(serviceKey));
  assert.equal((await fetch(photoUrl)).status, 200);
  await storage.remove('https://unrelated.example/image.png');
  assert.equal(objects.size, 1);

  await storage.remove(photoUrl);
  assert.equal(objects.size, 0);
  assert.equal((await fetch(photoUrl)).status, 404);
});
