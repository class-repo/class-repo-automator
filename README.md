# ClassRepo Automator

This repository serves strictly as a **GitHub Actions Runner** for ClassRepo. It contains no application logic or web server, only a `.github/workflows/provision.yml` workflow and an optional local script (`scripts/provision.sh`).

## Why this exists

Creating a GitHub repository, copying files from a template, adding collaborators, and sending invitations requires many sequential GitHub API calls. Doing this inside a Cloudflare Worker directly would risk hitting Cloudflare's strict CPU time limits and GitHub's secondary rate limits. 

By offloading the heavy lifting to GitHub Actions, we get:
1.  **Generous execution limits**: Actions can run for up to 6 hours.
2.  **Built-in parallelization**: Matrix jobs allow provisioning hundreds of student repos concurrently.
3.  **Local GitHub API locality**: Actions run inside GitHub's infrastructure, significantly reducing latency and rate limit issues compared to external API calls.

## How it works

1.  When a student joins an assignment (or an educator uploads a roster), the `class-repo-server` encrypts the student's details to this repository's **roster key**, stores the job, and dispatches `provision.yml` with only a random `batch_id` and the server URL.
2.  The workflow asks GitHub for an **OIDC token** (`permissions: id-token: write`) and uses it to fetch the job from the server. The server only answers runs of this repository's own `provision.yml`.
3.  `scripts/provision.js` opens each student's record with the private key (the `CLASSREPO_ROSTER_PRIVATE_KEY` secret), creates a private repository from the template (`{assignment}-{student-handle}`) with the Executor App token, and invites the student.
4.  It reports `ready` or `failed` (with a short generic reason) for each student, again with an OIDC token. The job fails if any student failed.
5.  The roster (handle, name, email, repo, time) is written to your **private** tracking repository, and skipped if that repository is public.

## This repository can be public

Running Actions in a public repository does not use up your minutes, but its run page, inputs and logs are public. ClassRepo is built for that:

*   The dispatch input is only a random batch id. Student details, the template, the assignment and the join code never appear in it.
*   Student records are encrypted; only the roster private key (an Actions secret) can open them.
*   The script never logs handles, names, emails or repository names. It reports "student 3 of 40", and registers every sensitive value as a masked secret. `test/provision.test.js` fails if anything identifying is logged.

Keep write access to this repository small: anyone who can edit the workflow can read your Actions secrets, including the roster key.

## Required Secrets & Variables

*   **Secrets**:
    *   `CLASSREPO_APP_ID`, `CLASSREPO_APP_PRIVATE_KEY`: the Executor App (written by the ClassRepo dashboard).
    *   `CLASSREPO_ROSTER_PRIVATE_KEY`: created by "Enable encrypted roster" in the dashboard. Never copy it anywhere.
*   **Variables**:
    *   `CLASSREPO_TRACKER_NAME`: the private repository that stores the roster (defaults to `class-repo-tracking`; created on first use if you own an organization).
    *   `CLASSREPO_ALLOWED_TEMPLATE_OWNERS` (optional): comma-separated owners whose repositories may be used as templates. If set, any job using another owner's template is refused.

## Updating

`provision.yml` calls `scripts/provision.js` and `scripts/roster-crypto.js` from this repository, so an update means copying **`.github/workflows/provision.yml` and the `scripts/` folder** from the template repository (`class-repo/class-repo-automator`). Nothing changes until you do.

## Tests

```bash
npm test
```

Runs the provisioning script against a mocked GitHub and server, including the privacy test and an interop test that opens a record sealed by the ClassRepo server's code (`test/vector.json`).
