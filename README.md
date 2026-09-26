# ClassRepo Automator

**✅ Next Step: [Return to your ClassRepo Dashboard](https://class-repo-server.pwlewis.workers.dev/dashboard#step3) to finish the setup!**

---

### Manual Setup Option
If you prefer not to use the automated GitHub App setup, you can set up the required access manually:
1. **Create an Executor App**: Go to your GitHub Settings > Developer settings > GitHub Apps and create a new App. Give it Repository permissions for `Administration: Read and write`, `Contents: Read and write`, and `Secrets: Read and write`. Install it on this repository.
2. **Create a Trigger Token**: Create a Fine-grained Personal Access Token (PAT) with `Actions: Read and write` permissions for this repository.
3. **Finish Setup**: Go back to your [ClassRepo Dashboard](https://class-repo-server.pwlewis.workers.dev/dashboard#manual-setup), look for the "Alternative: Manual Setup" section, and enter your Fine-grained PAT to complete setup.

---

This is the automated controller repository for your ClassRepo assignments. It runs GitHub Actions in the background to provision repositories for your students.

### Privacy Note
Student data (like names and emails) will **only** be logged into this repository if you set this repository to **Private**. If this repository is Public, the GitHub Action will skip writing logs to protect student privacy.
