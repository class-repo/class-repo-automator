# ClassRepo Automator

This repository is the trusted **Execution Engine** for ClassRepo. It operates within your own GitHub Organization and handles the automatic generation of student repositories based on a secure webhook signal from ClassRepo.org.

By design, ClassRepo is a zero-trust architecture. The central ClassRepo server does not hold any permissions to modify your organization. Instead, this repository holds a hidden GitHub App Private Key and uses GitHub Actions to provision repositories on your behalf.

## How it Works

1. **The Webhook**: When a student clicks your class join link, ClassRepo.org verifies their identity and sends a `repository_dispatch` webhook to this repository.
2. **The Action**: The `.github/workflows/provision.yml` workflow wakes up.
3. **The Execution**: It uses the secure `APP_PRIVATE_KEY` repository secret to authenticate as a GitHub App, clones your template repository, names it after the student, and invites the student as a collaborator with push access.

---

## Setup Instructions

To securely grant this repository the ability to create student repositories, we need to generate a GitHub App and inject its Private Key into this repository's **Actions Secrets**. 

You have two options for setup: the automated Direct Edge portal (Recommended) or the isolated Codespaces Wizard.

### Option 1: Direct Edge Portal (Recommended)

This is the fastest and easiest way to configure your repository. It takes less than a minute and requires no terminal commands.

1. Create a copy of this repository in your organization.
2. Go to the [ClassRepo Setup Portal](https://classrepo.org/setup) (or your hosted edge server).
3. Enter your repository name (e.g., `your-org/class-repo-automator`).
4. You will be asked to briefly log in with GitHub to authorize the portal.
5. Click **Create GitHub App**.
6. The portal will securely inject the required secrets into your repository's **Actions Secrets**, and then **instantly self-destruct** its own access token.

### Option 2: The Codespaces Wizard

If you prefer not to authorize an OAuth app at all, we have built a secure, ephemeral Codespace wizard that generates the App locally.

1. Click the green **Code** button on your repository.
2. Select the **Codespaces** tab and click **Create codespace on main**.
3. Wait for the Codespace to load.
4. When a notification appears saying *"Your application running on port 3000 is available"*, click **Open in Browser**.
5. Click **Create GitHub App**.
6. Run the generated `./setup_classrepo.sh` command in your Codespace terminal to finalize the secret injection and auto-delete the Codespace.

### Option 3: Manual Terminal Setup

1. Clone your repository to your local machine:
   ```bash
   git clone https://github.com/YOUR_ORG/YOUR_REPO.git
   cd YOUR_REPO
   ```
2. Authenticate the GitHub CLI with your account (ensure you include the `repo` scope):
   ```bash
   gh auth login -s repo
   ```
3. Install the required dependencies:
   ```bash
   npm install
   ```
4. Start the setup wizard server:
   ```bash
   npm start
   ```
5. Open your browser and navigate to `http://localhost:3000`. Click the button to create the GitHub App.
6. Upon successful creation, the wizard will display the exact `gh secret set` commands you need. Copy and paste those commands into your terminal to securely upload the `APP_ID` and `APP_PRIVATE_KEY` to your repository secrets.

---

## Security Note

**Never commit your `.pem` private key file to this repository.** The GitHub Action is specifically designed to read the key dynamically from the hidden Actions Secrets environment.
