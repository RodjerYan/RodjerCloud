export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_PAT;
  const REPO = process.env.GITHUB_REPO || 'RodjerYan/RodjerCloud';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_PAT environment variable is not set on Vercel.' });
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'RodjerCloud-Update-Server',
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch release from GitHub API' });
    }

    const data = await response.json();
    
    // We optionally modify the response to point download URLs to our proxy, 
    // but we can also just let the client do it. 
    // For simplicity, we just return the full GitHub JSON and the client will parse asset IDs.
    
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
