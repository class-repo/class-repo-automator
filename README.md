# ClassRepo Bot

This repository is where ClassRepo's work happens on **your** side. It holds a small GitHub Actions workflow (`.github/workflows/provision.yml`) and the script it runs (`scripts/`). The ClassRepo server decides *when* a job runs and *which* students it is for; this bot does the creating, using keys that never leave your GitHub account.

## What the bot will and will not do

The bot enforces these rules itself, whatever the server asks:

* Repositories are only ever created **private**, from the template named in the job (and only from owners in your allow-list, if you set one).
* Students get **at most push access** (or read-only). The bot never grants admin, maintain or triage.
* It **never deletes** anything and **never changes a repository's visibility**.
* It **only touches repositories ClassRepo created**: ones with the `classrepo` topic, or generated from the job's template. If a repository merely has a matching name, it is left alone and the student is told it could not be done.
* If a job asks for something this version of the bot does not understand, the **whole job is refused** with an "update your bot" message, rather than being half done.

## Why this exists

Creating a GitHub repository, copying files from a template, adding collaborators, and sending invitations requires many sequential GitHub API calls. Doing this inside a Cloudflare Worker directly would risk hitting Cloudflare's strict CPU time limits and GitHub's secondary rate limits. Running it in GitHub Actions in your own account gives generous execution limits and keeps the powerful key (the Executor App's) with you.

## How it works

1.  When a student joins an assignment (or an educator uploads a roster), the ClassRepo server (`server/` in [`class-repo-site`](https://github.com/class-repo/class-repo-site)) encrypts the student's details to this repository's **roster key**, stores the job, and dispatches `provision.yml` with only a random `batch_id` and the server URL.
2.  The workflow asks GitHub for an **OIDC token** (`permissions: id-token: write`) and uses it to fetch the job from the server. The server only answers runs of this repository's own `provision.yml`.
3.  `scripts/provision.js` introduces itself to the server (its version and what it supports), then does one kind of job: **make these repositories look like this**. For each repository it opens the students' records with the private key (the `CLASSREPO_ROSTER_PRIVATE_KEY` secret), looks up each account's **current** GitHub handle from its numeric id (so a renamed student is still invited, and a re-registered handle never reaches the wrong person), creates the repository if it is missing (`{assignment}-{student-handle}`, private, labelled `classrepo`), and corrects whatever differs: collaborators and their access, whether Actions is on, the Codespaces badge, and archiving. Running a job twice is harmless.
4.  It reports `ready` or `failed` (with a short generic reason) for each repository, again with an OIDC token. The job fails if any student failed.
5.  The roster (handle, name, email, repo, time) is written to your **private** tracking repository, and skipped if that repository is public.

## This repository can be public

Running Actions in a public repository does not use up your minutes, but its run page, inputs and logs are public. ClassRepo is built for that:

*   The dispatch input is only a random batch id. Student details, the template, the assignment and the join code never appear in it.
*   Student records are encrypted; only the roster private key (an Actions secret) can open them.
*   The script never logs handles, names, emails or repository names. It reports "student 3 of 40", and registers every sensitive value as a masked secret. `test/provision.test.js` fails if anything identifying is logged.

The workflow can also turn off GitHub Actions in each student repository (an option on each assignment, on by default for new ones). Students have write access, so without this they could run workflows that spend your organization's Actions minutes or read organization-wide secrets. Leave it off only if your template uses Actions for autograding.

Keep write access to this repository small: anyone who can edit the workflow can read your Actions secrets, including the roster key.

## Required Secrets & Variables

*   **Secrets**:
    *   `CLASSREPO_APP_ID`, `CLASSREPO_APP_PRIVATE_KEY`: the Executor App (written by the ClassRepo dashboard).
    *   `CLASSREPO_ROSTER_PRIVATE_KEY`: created by "Enable encrypted roster" in the dashboard. Never copy it anywhere.
*   **Variables**:
    *   `CLASSREPO_TRACKER_NAME`: the private repository that stores the roster (defaults to `class-repo-tracking`; created on first use if you own an organization).
    *   `CLASSREPO_ALLOWED_TEMPLATE_OWNERS` (optional): comma-separated owners whose repositories may be used as templates. If set, any job using another owner's template is refused.

## Updating

`.github/dependabot.yml` proposes pull requests when the actions used by `provision.yml` have new versions. Review and merge them; do not delete the file unless you replace it with your own update process.

`provision.yml` calls `scripts/provision.js` and `scripts/roster-crypto.js` from this repository, so an update means copying **`.github/workflows/provision.yml` and the `scripts/` folder** from the template repository (`class-repo/class-repo-bot`). Nothing changes until you do.

## Tests

```bash
npm test
```

Runs the provisioning script against a mocked GitHub and server, including the privacy test and an interop test that opens a record sealed by the ClassRepo server's code (`test/vector.json`).
