const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');

test('allEmail API keeps send endpoint for admin email workflow', () => {
	const api = readFileSync(join(root, 'src/api/all-email-api.js'), 'utf8');
	assert.match(api, /app\.post\('\/allEmail\/send'/);
	assert.match(api, /emailService\.send/);
	assert.match(api, /userContext\.getUserId\(c\)/);
});
