const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class ImageStorage {
  constructor({ uploadDir, supabaseUrl = '', serviceRoleKey = '', bucket = 'recipe-images', imageTypes }) {
    this.uploadDir = uploadDir;
    this.supabaseUrl = supabaseUrl.replace(/\/$/, '');
    this.serviceRoleKey = serviceRoleKey;
    this.bucket = bucket;
    this.imageTypes = imageTypes;
    this.enabled = Boolean(this.supabaseUrl && this.serviceRoleKey);

    if (Boolean(this.supabaseUrl) !== Boolean(this.serviceRoleKey)) {
      throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY juntos.');
    }
  }

  async store(file) {
    const imageType = this.imageTypes[file.mimetype];
    if (!imageType) throw new Error('Formato de imagem não suportado.');
    const filename = `${crypto.randomUUID()}${imageType.extension}`;

    if (!this.enabled) {
      fs.writeFileSync(path.join(this.uploadDir, filename), file.buffer, { flag: 'wx' });
      return `/uploads/${filename}`;
    }

    const response = await fetch(`${this.supabaseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': file.mimetype,
        'x-upsert': 'false'
      },
      body: file.buffer
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`O armazenamento de imagens recusou o upload (${response.status}): ${details}`);
    }
    return `${this.supabaseUrl}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${encodeURIComponent(filename)}`;
  }

  async remove(photoUrl) {
    if (typeof photoUrl !== 'string') return;

    if (photoUrl.startsWith('/uploads/')) {
      const filename = photoUrl.slice('/uploads/'.length);
      if (!filename || filename !== path.basename(filename)) return;
      const imagePath = path.resolve(this.uploadDir, filename);
      if (path.dirname(imagePath) === this.uploadDir && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      return;
    }

    if (!this.enabled) return;
    let url;
    try {
      url = new URL(photoUrl);
    } catch (_error) {
      return;
    }
    const objectPrefix = `/storage/v1/object/public/${encodeURIComponent(this.bucket)}/`;
    if (url.origin !== this.supabaseUrl || !url.pathname.startsWith(objectPrefix)) return;

    let filename;
    try {
      filename = decodeURIComponent(url.pathname.slice(objectPrefix.length));
    } catch (_error) {
      return;
    }
    if (!filename || filename !== path.basename(filename) || !/^[\w.-]+$/.test(filename)) return;

    const response = await fetch(`${this.supabaseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`
      }
    });
    if (!response.ok && response.status !== 404) {
      const details = await response.text();
      throw new Error(`O armazenamento de imagens recusou a exclusão (${response.status}): ${details}`);
    }
  }
}

module.exports = { ImageStorage };
