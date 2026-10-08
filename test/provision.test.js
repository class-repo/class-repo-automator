'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const run = require('../scripts/provision');
const { generateRosterKeyPair } = require('../scripts/roster-crypto');
const vector = require('./vector.json');

// Seals a record the way the server does: AES-256-GCM key wrapped with RSA-OAEP (see roster-crypto.js).
function seal(publicKeyB64, record) {
  const rsa = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  const aes = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  cipher.setAAD(Buffer.from('classrepo-roster-v1'));
  const body = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
  const wrapped = crypto.publicEncrypt({ key: rsa, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes);
  return ['v1', 'kid', wrapped.toString('base64url'), iv.toString('base64url'), body.toString('base64url')].join('.');
}

const SENSITIVE = ['alice-gh', 'Alice Smith', 'alice@univ.edu', 'bob-gh', 'Bob Jones', 'bob@univ.edu', 'cs101/starter', 'lab1', 'cs101-org'];
const BATCH = 'AbCdEfGhIjKlMnOpQrStUv';

function setup({ job, privateKeyPem, githubOverrides = {}, serverStatus = 200, execFile } = {}) {
  const logs = [];
  const record = (level) => (msg) => logs.push(`${level}: ${msg}`);
  const secrets = [];
  const core = {
    info: record('info'), warning: record('warning'), error: record('error'), debug: record('debug'), notice: record('notice'),
    setFailed: record('FAILED'), setSecret: s => secrets.push(s), getIDToken: async aud => `oidc-for-${aud}`,
  };
  const calls = [];
  const repos = new Set();
  const github = {
    rest: {
      repos: {
        get: async ({ repo }) => { if (repo === 'class-repo-tracking') return { data: { private: true } }; if (repos.has(repo)) return {}; const e = new Error('nf'); e.status = 404; throw e; },
        createUsingTemplate: async a => { calls.push(['create', a.name]); if (githubOverrides.create) await githubOverrides.create(a); repos.add(a.name); },
        addCollaborator: async a => { calls.push(['invite', a.username]); if (githubOverrides.invite) await githubOverrides.invite(a); },
        getContent: async () => { const e = new Error('nf'); e.status = 404; throw e; },
        createOrUpdateFileContents: async a => { calls.push(['badge', a.repo]); },
      },
      users: { getByUsername: async () => ({ data: { type: 'Organization' } }) },
      actions: { setGithubActionsPermissionsRepository: async a => { calls.push(['actions', a.repo, a.enabled]); if (githubOverrides.actions) await githubOverrides.actions(a); } },
    },
  };
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, auth: init.headers.Authorization, body });
    if (url.endsWith('/claim')) return { ok: serverStatus === 200, status: serverStatus, json: async () => job };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const exec = [];
  const deps = { fetch, tmpDir, execFile: execFile || ((cmd, args, opts) => { exec.push({ cmd, args, opts }); if (args[0] === 'clone') fs.mkdirSync(args[args.length - 1], { recursive: true }); }) };
  const env = {
    BATCH_ID: BATCH, SERVER_URL: 'https://api.classrepo.org/', EXECUTOR_TOKEN: 'ghs_executor', ROSTER_PRIVATE_KEY: privateKeyPem,
    TRACKING_REPO: 'class-repo-tracking', RUNNER_TEMP: tmpDir,
  };
  const context = { repo: { owner: 'cs101-org', repo: 'class-repo-automator' } };
  return { logs, secrets, core, github, deps, env, context, calls, requests, exec, tmpDir };
}

const baseJob = (pair, extra = {}) => ({
  mode: 'student_join', template: 'cs101/starter', assignment_name: 'lab1', target_owner: 'cs101-org', add_codespaces: false, shortcode: 'abc123xyz',
  students: [
    { sealed: seal(pair.publicKeyB64, { github: 'alice-gh', name: 'Alice Smith', email: 'alice@univ.edu' }), sync_key: 'k1' },
    { sealed: seal(pair.publicKeyB64, { github: 'bob-gh', name: 'Bob Jones', email: 'bob@univ.edu' }), sync_key: null },
  ],
  ...extra,
});

const exercise = (t) => run({ github: t.github, context: t.context, core: t.core, env: t.env, deps: t.deps });
const results = t => t.requests.filter(r => r.url.endsWith('/results')).map(r => r.body.results[0]);

test('creates a repo per decrypted student, invites them, and reports results by position', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  await exercise(t);
  assert.deepEqual(t.calls, [['create', 'lab1-alice-gh'], ['invite', 'alice-gh'], ['create', 'lab1-bob-gh'], ['invite', 'bob-gh']]);
  assert.deepEqual(results(t), [{ index: 0, status: 'ready' }]); // bob is a bulk row: nobody is waiting
  assert.ok(!t.logs.some(l => l.startsWith('FAILED')));
});

test('authenticates every server call with an OIDC token for the server origin', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  await exercise(t);
  assert.ok(t.requests.length >= 2);
  for (const r of t.requests) {
    assert.equal(r.auth, 'Bearer oidc-for-https://api.classrepo.org');
    assert.match(r.url, new RegExp(`^https://api.classrepo.org/api/batch/${BATCH}/`));
  }
});

test('NEVER logs anything identifying (the repo may be public)', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem,
    githubOverrides: { invite: async ({ username }) => { if (username === 'bob-gh') { const e = new Error(`boom for bob-gh at cs101-org/lab1-bob-gh`); e.status = 422; throw e; } } } });
  const printed = [];
  const origLog = console.log; console.log = (...a) => printed.push(a.join(' '));
  try { await exercise(t); } finally { console.log = origLog; }
  const everything = [...t.logs, ...printed].join('\n');
  for (const s of SENSITIVE) assert.ok(!everything.includes(s), `log leaked ${JSON.stringify(s)}:\n${everything}`);
  assert.match(everything, /student 1 of 2: done/);
  assert.match(everything, /student 2 of 2: The repository exists, but sending the invitation failed/);
});

test('masks sensitive values as secrets', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  await exercise(t);
  for (const s of ['cs101/starter', 'lab1', 'cs101-org', 'abc123xyz', 'alice-gh', 'Alice Smith', 'alice@univ.edu']) assert.ok(t.secrets.includes(s), `${s} not masked`);
});

test('failures are reported generically and fail the job without identities', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem, githubOverrides: { create: async () => { const e = new Error('nope'); e.status = 404; throw e; } } });
  await exercise(t);
  assert.deepEqual(results(t), [{ index: 0, status: 'failed', error: 'Could not create the repository from the template (HTTP 404).' }]);
  const failed = t.logs.filter(l => l.startsWith('FAILED'));
  assert.deepEqual(failed, ['FAILED: 2 of 2 student(s) failed.']);
});

test('a record sealed to a different key fails that student only', async () => {
  const pair = generateRosterKeyPair();
  const other = generateRosterKeyPair();
  const job = baseJob(pair);
  job.students[0].sealed = seal(other.publicKeyB64, { github: 'alice-gh', name: 'A', email: 'a@x' });
  const t = setup({ job, privateKeyPem: pair.privateKeyPem });
  await exercise(t);
  assert.equal(results(t)[0].status, 'failed');
  assert.deepEqual(t.calls, [['create', 'lab1-bob-gh'], ['invite', 'bob-gh']]);
});

test('rejects invalid job fields before touching GitHub', async () => {
  const pair = generateRosterKeyPair();
  for (const bad of [{ assignment_name: '../x' }, { template: 'not a template' }, { target_owner: 'a/b' }]) {
    const t = setup({ job: baseJob(pair, bad), privateKeyPem: pair.privateKeyPem });
    await exercise(t);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.logs.filter(l => l.startsWith('FAILED')), ['FAILED: The job contains invalid names.']);
  }
});

test('honours the optional template-owner allow-list', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  t.env.ALLOWED_TEMPLATE_OWNERS = 'someone-else, another';
  await exercise(t);
  assert.deepEqual(t.calls, []);
  assert.ok(t.logs.some(l => l.startsWith('FAILED')));
  const ok = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  ok.env.ALLOWED_TEMPLATE_OWNERS = 'CS101';
  await exercise(ok);
  assert.equal(ok.calls.length, 4);
});

test('stops cleanly if the server refuses the claim or the batch id is bad', async () => {
  const pair = generateRosterKeyPair();
  const refused = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem, serverStatus: 403 });
  await exercise(refused);
  assert.deepEqual(refused.logs.filter(l => l.startsWith('FAILED')), ['FAILED: Could not fetch the job from the ClassRepo server (HTTP 403).']);
  assert.deepEqual(refused.calls, []);

  const bad = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  bad.env.BATCH_ID = '../../etc';
  await exercise(bad);
  assert.equal(bad.requests.length, 0);
});

test('refuses an http server url', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  t.env.SERVER_URL = 'http://api.classrepo.org';
  t.deps.allowHttp = false;
  await exercise(t);
  assert.equal(t.requests.length, 0);
});

test('fails with guidance when no roster key secret exists yet', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: '' });
  await exercise(t);
  assert.match(t.logs.find(l => l.startsWith('FAILED')), /Enable encrypted roster/);
  assert.deepEqual(t.calls, []);
});

test('records the roster only in a private tracking repo, with markdown-safe cells', async () => {
  const pair = generateRosterKeyPair();
  const job = baseJob(pair);
  job.students[0].sealed = seal(pair.publicKeyB64, { github: 'alice-gh', name: 'Al | <b>x</b> [link](http://evil)\nnewline', email: 'alice@univ.edu' });
  const t = setup({ job, privateKeyPem: pair.privateKeyPem });
  let readme = '';
  t.deps.execFile = (cmd, args, opts) => {
    t.exec.push({ cmd, args, opts });
    if (args[0] === 'clone') fs.mkdirSync(args[args.length - 1], { recursive: true });
    if (args[0] === 'add') readme = fs.readFileSync(path.join(opts.cwd, 'logs', 'lab1', 'README.md'), 'utf8');
  };
  await exercise(t);
  assert.ok(t.exec.some(e => e.args[0] === 'push'));
  assert.ok(!t.exec.some(e => JSON.stringify(e.args).includes('ghs_executor') && e.args[0] !== 'clone'));
  assert.match(readme, /\[@alice-gh\]\(https:\/\/github.com\/alice-gh\)/);
  assert.ok(!readme.includes('<b>'), 'html must be escaped');
  assert.ok(readme.includes('\\[link\\](http://evil)'), 'brackets must be escaped so it renders as text, not a link');
  assert.equal(readme.split('\n').filter(l => l.startsWith('| [@')).length, 2);
});

test('does not record the roster when the tracking repo is public', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  const originalGet = t.github.rest.repos.get;
  t.github.rest.repos.get = async a => a.repo === 'class-repo-tracking' ? { data: { private: false } } : originalGet(a);
  await exercise(t);
  assert.equal(t.exec.length, 0);
  assert.ok(t.logs.some(l => l.includes('tracking repository is public')));
});

test('setup_keys stores the private key as a secret and sends only the public key', async () => {
  const t = setup({ job: { mode: 'setup_keys' }, privateKeyPem: '' });
  await exercise(t);
  const gh = t.exec.find(e => e.cmd === 'gh');
  assert.deepEqual(gh.args, ['secret', 'set', 'CLASSREPO_ROSTER_PRIVATE_KEY', '--repo', 'cs101-org/class-repo-automator']);
  assert.match(gh.opts.input, /BEGIN PRIVATE KEY/);
  assert.equal(gh.opts.env.GH_TOKEN, 'ghs_executor');
  const reg = t.requests.find(r => r.url.endsWith('/roster-key'));
  assert.deepEqual(Object.keys(reg.body), ['public_key']);
  assert.ok(!JSON.stringify(t.requests).includes('PRIVATE KEY'));
  assert.ok(!t.logs.join('\n').includes('PRIVATE KEY'));
  assert.ok(t.secrets.some(s => s.includes('BEGIN PRIVATE KEY')), 'private key must be masked');
});

test('setup_keys fails clearly if the secret cannot be stored, and does not register a key', async () => {
  const t = setup({ job: { mode: 'setup_keys' }, privateKeyPem: '', execFile: () => { throw new Error('gh failed'); } });
  await exercise(t);
  assert.match(t.logs.find(l => l.startsWith('FAILED')), /Secrets permission/);
  assert.ok(!t.requests.some(r => r.url.endsWith('/roster-key')));
});

test('unknown job types fail', async () => {
  const t = setup({ job: { mode: 'something-else' }, privateKeyPem: '' });
  await exercise(t);
  assert.deepEqual(t.logs.filter(l => l.startsWith('FAILED')), ['FAILED: Unknown job type.']);
});

test('the checked-in interop vector is also accepted by the workflow path', async () => {
  const t = setup({ job: { ...baseJob({ publicKeyB64: vector.publicKeyB64 }), students: [{ sealed: vector.sealed, sync_key: null }] }, privateKeyPem: vector.privateKeyPem });
  await exercise(t);
  assert.deepEqual(t.calls, [['create', 'lab1-alice-example'], ['invite', 'alice-example']]);
});

test('turns off GitHub Actions in student repos only when the assignment asks for it', async () => {
  const pair = generateRosterKeyPair();
  const on = setup({ job: baseJob(pair, { disable_actions: true }), privateKeyPem: pair.privateKeyPem });
  await exercise(on);
  assert.deepEqual(on.calls.filter(c => c[0] === 'actions'), [['actions', 'lab1-alice-gh', false], ['actions', 'lab1-bob-gh', false]]);

  const off = setup({ job: baseJob(pair), privateKeyPem: pair.privateKeyPem });
  await exercise(off);
  assert.deepEqual(off.calls.filter(c => c[0] === 'actions'), []);
});

test('a failure to turn off Actions is a generic warning, not a failed student, and leaks nothing', async () => {
  const pair = generateRosterKeyPair();
  const t = setup({ job: baseJob(pair, { disable_actions: true }), privateKeyPem: pair.privateKeyPem,
    githubOverrides: { actions: async () => { throw new Error('forbidden for alice-gh'); } } });
  await exercise(t);
  assert.deepEqual(results(t), [{ index: 0, status: 'ready' }]);
  assert.ok(t.logs.some(l => l.startsWith('warning: Could not turn off GitHub Actions')));
  assert.ok(!t.logs.join('\n').includes('alice-gh'));
  assert.ok(!t.logs.some(l => l.startsWith('FAILED')));
});
