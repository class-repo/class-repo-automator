# ClassRepo Automator

This repository serves strictly as a **GitHub Actions Runner** for ClassRepo. It contains no application logic or web server, only a `.github/workflows/provision.yml` workflow and an optional local script (`scripts/provision.sh`).

## Why this exists

Creating a GitHub repository, copying files from a template, adding collaborators, and sending invitations requires many sequential GitHub API calls. Doing this inside a Cloudflare Worker directly would risk hitting Cloudflare's strict CPU time limits and GitHub's secondary rate limits. 

By offloading the heavy lifting to GitHub Actions, we get:
1.  **Generous execution limits**: Actions can run for up to 6 hours.
2.  **Built-in parallelization**: Matrix jobs allow provisioning hundreds of student repos concurrently.
3.  **Local GitHub API locality**: Actions run inside GitHub's infrastructure, significantly reducing latency and rate limit issues compared to external API calls.

## How it works

1.  When a student joins an assignment (or a teacher uploads a CSV), the `class-repo-server` uses the teacher's Trigger App credentials (or PAT) to make a `POST /actions/workflows/provision.yml/dispatches` call to this repository.
2.  The workflow reads the `inputs` payload (which contains the student's GitHub handle, the template repository, etc).
3.  The workflow uses the `CLASSREPO_APP_ID` and `CLASSREPO_APP_PRIVATE_KEY` secrets to generate a short-lived token for the **Executor App** (which the educator installed during onboarding).
4.  Using this token, the workflow clones the template, pushes it to a new repository (`{assignment-name}-{student-handle}`), and sends the student an invitation.
5.  Finally, for each student the workflow reports `ready` or `failed` (with a reason) to `POST /api/ready/:shortcode/:sync_key` on the `class-repo-server`, sending the signed `X-Ready-Token` it was given. The job is marked failed if any student failed. Students added in bulk (CSV) have no sync key, so nothing is reported for them.

## Required Secrets & Variables

*   **Secrets**:
    *   `CLASSREPO_APP_ID`: The App ID of the Executor App.
    *   `CLASSREPO_APP_PRIVATE_KEY`: The PEM private key of the Executor App.
*   **Variables**:
    *   `CLASSREPO_TRACKER_NAME`: The name of the repository used to store the CSV tracking spreadsheet (defaults to `class-repo-tracking`). The workflow creates this private repository on first use if it does not exist.

## Updating

Your copy of `provision.yml` is self-contained, so nothing changes in it unless you update it. To pick up a new version, copy `.github/workflows/provision.yml` from the template repository (`class-repo/class-repo-automator`) into your repository. Workflow changes that rely on newer server behaviour (for example the signed ready token) are noted in the template's commit history.
