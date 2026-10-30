'use strict';

// Opt in to the REAL Python plugin using its local development fixture:
//   PET_INTEGRATION_URL=http://127.0.0.1:19898 node --test tests/integration.test.js
// The fixture replaces only AstrBot/LLM. Transport, persistence and protocol are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { PetConnection, endpoint } = require('../src/core');

const url = process.env.PET_INTEGRATION_URL;
const token = process.env.PET_INTEGRATION_TOKEN || '';

async function waitFor(predicate) {
  const until = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Real plugin did not synchronize in time');
    await delay(10);
  }
}

test('Electron core interoperates with the real Python plugin HTTP/WS protocol', { skip: !url }, async t => {
  const first = new PetConnection({ server: url, token });
  const second = new PetConnection({ server: url, token });
  t.after(() => { first.stop(); second.stop(); });
  const speech = [[], []];
  first.on('update', event => { if (event.type === 'speak') speech[0].push(event); });
  second.on('update', event => { if (event.type === 'speak') speech[1].push(event); });
  first.start(); second.start();
  await waitFor(() => first.status.phase === 'online' && second.status.phase === 'online');
  const health = await first.request('GET', 'api/health');
  assert.equal(health.protocol_version, 1);
  assert.ok(health.capabilities.includes('request_id'));

  const chatId = randomUUID();
  const chat = await first.chat('跨语言协议联调', chatId);
  const repeatedChat = await first.chat('跨语言协议联调', chatId);
  assert.deepEqual(repeatedChat, chat);
  assert.equal(typeof chat.reply, 'string');
  await waitFor(() => speech.every(events => events.some(event => event.request_id === chatId)));
  assert.equal(speech[0].filter(event => event.request_id === chatId).length, 1);
  assert.equal(speech[1].filter(event => event.request_id === chatId).length, 1);

  const actionId = randomUUID();
  const action = await first.action('feed', actionId);
  const repeatedAction = await first.action('feed', actionId);
  assert.deepEqual(repeatedAction, action);
  await waitFor(() => second.state.exp === action.state.exp && second.state.level === action.state.level);
  assert.deepEqual(first.state, second.state);

  const original = await first.request('GET', 'api/config');
  try {
    await first.saveConfig({ walk_speed: 2.4 });
    await waitFor(() => second.config.walk_speed === 2.4);
  } finally {
    await first.saveConfig({ walk_speed: original.walk_speed });
  }
  const personas = await first.personas();
  assert.ok(Array.isArray(personas.personas));
  assert.ok(personas.personas.some(persona => persona.id === 'test'));
  const lines = await first.generateLines('chatter', 2);
  assert.equal(lines.kind, 'chatter');
  assert.ok(lines.lines.length >= 1 && lines.lines.every(line => typeof line === 'string'));

  const response = await fetch(endpoint(url, 'api/action'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Pet-Token': token } : {}) }, body: '[]'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_request');
});
