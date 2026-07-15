export default async function handler(req, res) {
  const { id } = req.query;
  const GITHUB_TOKEN = process.env.GITHUB_PAT;
  const REPO = process.env.GITHUB_REPO || 'RodjerYan/RodjerCloud';

  if (!id) {
    return res.status(400).json({ error: 'Missing asset id. Usage: /api/download?id=123' });
  }

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_PAT environment variable is not set on Vercel.' });
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'RodjerCloud-Update-Server',
        'Accept': 'application/octet-stream',
        'Authorization': `Bearer ${GITHUB_TOKEN}`
      },
      // Manual redirect allows us to catch the 302 from GitHub API and pass it to the user
      redirect: 'manual' 
    });

    if (response.status === 302 || response.status === 301) {
      // Get the temporary S3 AWS download link
      const location = response.headers.get('location');
      if (location) {
        // Redirect the user directly to the S3 bucket! 
        // This costs zero bandwidth on our Vercel server.
        return res.redirect(302, location);
      }
    }

    // If it's a 200, we could pipe it, but GitHub releases always redirect octet-stream requests.
    const text = await response.text();
    return res.status(response.status).json({ 
      error: `Unexpected response from GitHub: ${response.status}`,
      details: text 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
