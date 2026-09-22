const express = require('express');
const { execSync } = require('child_process');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  const codespaceName = process.env.CODESPACE_NAME;
  if (!codespaceName) {
    return res.send('Not running in a codespace environment.');
  }

  // The Codespace forwarded URL
  const callbackUrl = `https://${codespaceName}-${port}.app.github.dev/callback`;
  
  const manifest = JSON.stringify({
    name: "ClassRepo App",
    url: "https://classrepo.org",
    hook_attributes: {
      url: "https://classrepo.org/webhook"
    },
    redirect_url: callbackUrl,
    public: true,
    default_permissions: {
      contents: "write",
      administration: "write",
      metadata: "read"
    },
    default_events: [
      "repository_dispatch"
    ]
  });

  const html = `
    <h1>ClassRepo Setup</h1>
    <p>Click the button below to create the GitHub App for this organization.</p>
    <form action="https://github.com/settings/apps/new" method="post">
      <input type="hidden" name="manifest" id="manifest" value='${manifest}'>
      <button type="submit">Create GitHub App</button>
    </form>
  `;
  res.send(html);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided in callback.');
  }

  try {
    // Convert code to app credentials using GitHub API
    // Note: The conversion API endpoint returns the client_id, client_secret, webhook_secret, and pem
    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to convert code: ${response.statusText}`);
    }

    const appData = await response.json();
    const pemKey = appData.pem;
    const appId = appData.id;

    try {
      // Use GitHub CLI to set the secret
      execSync(`gh secret set APP_PRIVATE_KEY --body "${pemKey}"`);
      execSync(`gh secret set APP_ID --body "${appId}"`);

      res.send(`
        <h1>Success!</h1>
        <p>The GitHub App was created and the private key was securely saved as a GitHub Action Secret!</p>
        <p><strong>App ID:</strong> ${appId}</p>
        <p>Please enter this App ID into ClassRepo.org to finalize the setup.</p>
        <p>You can now safely close this Codespace. It will be deleted automatically.</p>
      `);
      
      // Clean up codespace
      const codespaceName = process.env.CODESPACE_NAME;
      if (codespaceName) {
          setTimeout(() => {
              try {
                  execSync(`gh codespace delete -c ${codespaceName}`);
              } catch (e) {
                  console.error("Failed to delete codespace automatically:", e);
              }
          }, 5000);
      }
      
      // Stop the server
      setTimeout(() => process.exit(0), 10000);
      
    } catch (ghError) {
      console.error(ghError);
      
      const fs = require('fs');
      const scriptContent = `#!/bin/bash
# Unset the default codespace token so gh uses our new interactive token
unset GITHUB_TOKEN

echo "Authenticating GitHub CLI..."
gh auth login --hostname github.com --git-protocol https --web -s repo -s codespace
echo "Saving secrets..."
gh secret set APP_ID --body "${appId}"
gh secret set APP_PRIVATE_KEY --body "${pemKey.replace(/\\n/g, '\\n')}"
echo "Secrets saved successfully!"
echo "Cleaning up..."
rm setup_classrepo.sh
echo "Setup complete! Self-destructing this Codespace in 5 seconds..."
sleep 5
gh codespace delete -c $CODESPACE_NAME
`;
      fs.writeFileSync('setup_classrepo.sh', scriptContent);
      execSync('chmod +x setup_classrepo.sh');

      res.send(`
        <h1>Almost there!</h1>
        <p>The GitHub App was successfully created (App ID: <strong>${appId}</strong>), but your Codespace does not have the permissions required to save the secrets automatically.</p>
        <p>To finish the setup quickly, please open the terminal in this Codespace and run the following command:</p>
        <pre style="background: #f4f4f4; padding: 10px; border-radius: 5px; font-size: 16px;">
./setup_classrepo.sh
        </pre>
        <p>This script will ask you to authenticate, automatically save your secrets, and clean itself up when finished.</p>
      `);
    }

  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred during setup: ' + error.message);
  }
});

app.listen(port, () => {
  console.log(`ClassRepo Setup Wizard listening on port ${port}`);
});
