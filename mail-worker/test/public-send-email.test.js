const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');

test('public API exposes admin sendEmail endpoint', () => {
	const api = readFileSync(join(root, 'src/api/public-api.js'), 'utf8');
	assert.match(api, /app\.post\('\/public\/sendEmail'/);
	assert.match(api, /publicService\.sendEmail/);
});

test('public service implements sendEmail handler', () => {
	const service = readFileSync(join(root, 'src/service/public-service.js'), 'utf8');
	assert.match(service, /async sendEmail\(c, params\)/);
	assert.match(service, /adminEmail/);
	assert.match(service, /adminPassword/);
});
