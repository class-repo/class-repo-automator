'use strict';
// Logic for .github/workflows/provision.yml, kept in a file so it can be tested.
//
// This repository may be PUBLIC, which makes the workflow's inputs, logs and annotations public too. So:
//   - the dispatch carries only a batch id; the job is fetched from the ClassRepo server with the run's
//     GitHub OIDC token, and student records arrive sealed to this repo's roster key (roster-crypto.js);
//   - nothing identifying (handles, names, emails, template, assignment, owner) is ever logged: progress is
//     reported by position ("student 3 of 40") and every sensitive value is registered as a masked secret.
//   - the roster itself is only written to the educator's PRIVATE tracking repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { generateRosterKeyPair, openSealed } = require('./roster-crypto');

const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const TEMPLATE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ROSTER_SECRET = 'CLASSREPO_ROSTER_PRIVATE_KEY';

const oneLine = (value, max = 200) => String(value == null ? '' : value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);
const mdCell = value => oneLine(value).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

async function run({ github, context, core, env = process.env, deps = {} }) {
  const fetchFn = deps.fetch || fetch;
  const execFile = deps.execFile || childProcess.execFileSync;
  const tmp = deps.tmpDir || env.RUNNER_TEMP || os.tmpdir();

  const serverUrl = String(env.SERVER_URL || '').replace(/\/+$/, '');
  const batchId = String(env.BATCH_ID || '');
  if (!/^https:\/\//.test(serverUrl) && !deps.allowHttp) return core.setFailed('server_url must be an https address.');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(batchId)) return core.setFailed('batch_id is not valid.');
  const audience = new URL(serverUrl).origin;

  // A fresh token per call: each one is short-lived and a run can last several minutes.
  async function call(action, body) {
    const token = await core.getIDToken(audience);
    return fetchFn(`${serverUrl}/api/batch/${batchId}/${action}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }
  const mask = value => { if (value && String(value).length >= 3) core.setSecret(String(value)); };

  const claim = await call('claim');
  if (!claim.ok) return core.setFailed(`Could not fetch the job from the ClassRepo server (HTTP ${claim.status}).`);
  const job = await claim.json();
  [job.template, job.assignment_name, job.target_owner, job.shortcode].forEach(mask);

  if (job.mode === 'setup_keys') return setupKeys();
  if (job.mode === 'student_join') return provision();
  return core.setFailed('Unknown job type.');

  // ---------------------------------------------------------------------------------------------
  // setup_keys: create the roster key pair here. The private key goes straight into this repo's
  // Actions secrets; only the public key is sent to the server.
  // ---------------------------------------------------------------------------------------------
  async function setupKeys() {
    const { publicKeyB64, privateKeyPem } = generateRosterKeyPair();
    core.setSecret(privateKeyPem);
    privateKeyPem.split('\n').forEach(mask);
    try {
      execFile('gh', ['secret', 'set', ROSTER_SECRET, '--repo', `${context.repo.owner}/${context.repo.repo}`], {
        input: privateKeyPem,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...env, GH_TOKEN: env.EXECUTOR_TOKEN },
      });
    } catch {
      return core.setFailed('Could not store the roster key as an Actions secret. Check the Executor App has the Secrets permission on this repository.');
    }
    const res = await call('roster-key', { public_key: publicKeyB64 });
    if (!res.ok) return core.setFailed(`The server did not accept the roster key (HTTP ${res.status}). Run the setup again.`);
    core.info('Encrypted roster enabled.');
  }

  // ---------------------------------------------------------------------------------------------
  // student_join: create one private repository per student and invite them.
  // ---------------------------------------------------------------------------------------------
  async function provision() {
    const assignment = job.assignment_name;
    const template = job.template;
    const owner = job.target_owner || context.repo.owner;
    const students = Array.isArray(job.students) ? job.students : [];
    const trackingRepo = env.TRACKING_REPO || 'class-repo-tracking';

    if (!NAME_RE.test(assignment || '') || !TEMPLATE_RE.test(template || '') || !HANDLE_RE.test(owner) || !NAME_RE.test(trackingRepo)) {
      return core.setFailed('The job contains invalid names.');
    }
    const allowedOwners = String(env.ALLOWED_TEMPLATE_OWNERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowedOwners.length && !allowedOwners.includes(template.split('/')[0].toLowerCase())) {
      return core.setFailed('The template owner is not in this repository\'s allowed list (CLASSREPO_ALLOWED_TEMPLATE_OWNERS).');
    }
    if (!env.ROSTER_PRIVATE_KEY) return core.setFailed('No roster key is configured. Use "Enable encrypted roster" in the ClassRepo dashboard.');

    const [templateOwner, templateRepo] = template.split('/');
    const logDir = path.join(tmp, 'logs_generated');
    fs.mkdirSync(logDir, { recursive: true });

    async function currentHandle(record) {
      if (record.github_id == null) return record.github; // records sealed before ids were added
      let login;
      try {
        login = (await github.rest.users.getById({ account_id: Number(record.github_id) })).data.login;
      } catch (e) {
        throw new Error(e.status === 404 ? 'That GitHub account no longer exists.' : `Could not look up the GitHub account (HTTP ${e.status || 'error'}).`);
      }
      if (!HANDLE_RE.test(String(login))) throw new Error('Could not look up the GitHub account.');
      return login;
    }

    // Throws an Error with a short message that is safe to show to the student and to log.
    async function provisionStudent(record) {
      const repoName = `${assignment}-${record.github}`;
      let exists = false;
      try {
        await github.rest.repos.get({ owner, repo: repoName });
        exists = true;
      } catch (e) {
        if (e.status !== 404) throw new Error(`Could not check for an existing repository (HTTP ${e.status || 'error'}).`);
      }
      if (!exists) {
        try {
          await github.rest.repos.createUsingTemplate({ template_owner: templateOwner, template_repo: templateRepo, owner, name: repoName, private: true, include_all_branches: false });
        } catch (e) {
          throw new Error(`Could not create the repository from the template (HTTP ${e.status || 'error'}).`);
        }
      }
      try {
        await github.rest.repos.addCollaborator({ owner, repo: repoName, username: record.github, permission: 'push' });
      } catch (e) {
        throw new Error(`The repository exists, but sending the invitation failed (HTTP ${e.status || 'error'}).`);
      }
      if (job.add_codespaces) await addCodespacesBadge(repoName); // best effort
      if (job.disable_actions) await disableActions(repoName); // best effort

      const lines = [`github_id: ${record.github_id == null ? '' : record.github_id}`, `github_handle: ${record.github}`, `name: ${oneLine(record.name)}`, `email: ${oneLine(record.email) || 'no-email'}`,
        `created_at: ${new Date().toISOString()}`, `repo: ${owner}/${repoName}`];
      fs.writeFileSync(path.join(logDir, `${record.github}.txt`), lines.join('\n'));
    }

    // Students have write access, so they could add workflows that spend the organization's Actions minutes or
    // read organization-wide secrets. Educators who don't need autograding can turn Actions off per assignment.
    async function disableActions(repoName) {
      try {
        await github.rest.actions.setGithubActionsPermissionsRepository({ owner, repo: repoName, enabled: false });
      } catch {
        core.warning('Could not turn off GitHub Actions in one student repository.');
      }
    }

    async function addCodespacesBadge(repoName) {
      const badge = `[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/${owner}/${repoName}?quickstart=1)`;
      try {
        const readme = await github.rest.repos.getContent({ owner, repo: repoName, path: 'README.md' }).catch(() => null);
        if (readme && readme.data) {
          const current = Buffer.from(readme.data.content, 'base64').toString('utf8');
          if (current.includes('codespaces.new')) return;
          await github.rest.repos.createOrUpdateFileContents({ owner, repo: repoName, path: 'README.md', message: 'Add Codespaces badge', content: Buffer.from(`${badge}\n\n${current}`).toString('base64'), sha: readme.data.sha });
        } else {
          await github.rest.repos.createOrUpdateFileContents({ owner, repo: repoName, path: 'README.md', message: 'Add Codespaces badge', content: Buffer.from(`${badge}\n`).toString('base64') });
        }
      } catch {
        core.warning('Could not add the Codespaces badge to one repository.');
      }
    }

    async function report(index, status, error) {
      if (!students[index].sync_key) return; // bulk roster rows: nobody is waiting
      try {
        const res = await call('results', { results: [{ index, status, error }] });
        if (!res.ok) core.warning(`The server rejected a status report (HTTP ${res.status}).`);
      } catch {
        core.warning('Could not send a status report to the server.');
      }
    }

    let failed = 0;
    for (const [index, student] of students.entries()) {
      const label = `student ${index + 1} of ${students.length}`;
      let record;
      try {
        record = openSealed(student.sealed, env.ROSTER_PRIVATE_KEY);
        if (!record || !HANDLE_RE.test(record.github)) throw new Error('bad record');
      } catch {
        failed++;
        core.error(`${label}: could not open the student's record (was the roster key replaced?).`);
        await report(index, 'failed', 'Your details could not be processed. Please ask your instructor to check the encrypted roster setup.');
        continue;
      }
      [record.github, record.name, record.email].forEach(mask);

      try {
        // The account id never changes but the handle can. Use the handle the account has NOW, so a student who renamed
        // between joining and provisioning is still invited (and a recycled handle never reaches the wrong person).
        record.github = await currentHandle(record);
        mask(record.github);
        await provisionStudent(record);
        core.info(`${label}: done`);
        await report(index, 'ready');
      } catch (e) {
        failed++;
        core.error(`${label}: ${e.message}`);
        await report(index, 'failed', e.message);
      }
    }

    await pushTracking({ owner, trackingRepo, assignment, logDir });
    if (failed > 0) core.setFailed(`${failed} of ${students.length} student(s) failed.`);
  }

  // Records the roster in the educator's PRIVATE tracking repository (creating it if needed).
  async function pushTracking({ owner, trackingRepo, assignment, logDir }) {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) return;

    let repo = null;
    try {
      repo = (await github.rest.repos.get({ owner, repo: trackingRepo })).data;
    } catch (e) {
      if (e.status !== 404) return core.warning('Could not check the tracking repository; roster not recorded.');
      try {
        const type = (await github.rest.users.getByUsername({ username: owner })).data.type;
        if (type !== 'Organization') return core.warning('The tracking repository does not exist. Create a private repository with that name; roster not recorded.');
        repo = (await github.rest.repos.createInOrg({ org: owner, name: trackingRepo, private: true, description: 'ClassRepo student tracking logs' })).data;
      } catch {
        return core.warning('Could not create the tracking repository; roster not recorded.');
      }
    }
    if (!repo.private) return core.warning('The tracking repository is public, so the roster was NOT recorded. Make it private.');

    const dir = path.join(tmp, 'tracking');
    fs.rmSync(dir, { recursive: true, force: true });
    const git = (args, cwd) => execFile('git', args, { cwd, stdio: 'pipe', env });
    try {
      git(['clone', '--depth', '1', `https://x-access-token:${env.EXECUTOR_TOKEN}@github.com/${owner}/${trackingRepo}.git`, dir]);
      git(['config', 'user.name', 'ClassRepo Bot'], dir);
      git(['config', 'user.email', 'bot@classrepo.internal'], dir);
      git(['checkout', '-B', 'main'], dir);

      const logsDir = path.join(dir, 'logs', assignment);
      fs.mkdirSync(logsDir, { recursive: true });
      for (const f of files) fs.copyFileSync(path.join(logDir, f), path.join(logsDir, f));
      fs.writeFileSync(path.join(logsDir, 'README.md'), buildDashboard(logsDir));

      git(['add', 'logs'], dir);
      try { git(['commit', '-m', 'Record repository creation'], dir); } catch { return; } // nothing new
      for (let attempt = 0; attempt < 5; attempt++) {
        try { git(['pull', '--rebase', 'origin', 'main'], dir); } catch { /* empty remote or no changes */ }
        try { git(['push', 'origin', 'HEAD:main'], dir); return; } catch { /* retry */ }
      }
      core.warning('Could not push to the tracking repository after several attempts.');
    } catch {
      core.warning('Could not update the tracking repository.');
    }
  }

  function buildDashboard(logsDir) {
    const rows = fs.readdirSync(logsDir).filter(f => f.endsWith('.txt')).map(f => {
      const data = {};
      for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
        const i = line.indexOf(': ');
        if (i > 0) data[line.slice(0, i)] = line.slice(i + 2);
      }
      return data;
    }).filter(d => HANDLE_RE.test(d.github_handle || ''));
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return ['# Student Repository Dashboard', '', '| GitHub Handle | Name | Email | Repository | Created At |', '|---------------|------|-------|------------|------------|',
      ...rows.map(d => `| [@${d.github_handle}](https://github.com/${d.github_handle}) | ${mdCell(d.name)} | ${mdCell(d.email)} | ${mdCell(d.repo)} | ${mdCell(d.created_at)} |`), ''].join('\n');
  }
}

module.exports = run;
