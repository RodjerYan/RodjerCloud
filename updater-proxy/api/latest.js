export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_PAT;
  const REPO = process.env.GITHUB_REPO || 'RodjerYan/RodjerCloud';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_PAT environment variable is not set on Vercel.' });
  }

  try {
    // Prefer the releases list and pick max semver — /releases/latest is by published_at, not semver.
    const listRes = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: {
        'User-Agent': 'RodjerCloud-Update-Server',
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`
      }
    });

    if (listRes.ok) {
      const list = await listRes.json();
      const parse = (v) => (v || '').replace(/^v/, '').split('.').map((s) => parseInt(s, 10) || 0);
      const cmp = (a, b) => {
        const av = parse(a), bv = parse(b);
        const n = Math.max(av.length, bv.length);
        for (let i = 0; i < n; i++) {
          const x = av[i] || 0, y = bv[i] || 0;
          if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
      };
      const candidates = (Array.isArray(list) ? list : []).filter(
        (r) => r && r.tag_name && !r.draft && !r.prerelease
      );
      if (candidates.length > 0) {
        candidates.sort((a, b) => cmp(b.tag_name, a.tag_name));
        // Return the same shape as /releases/latest (single release object).
        return res.status(200).json(candidates[0]);
      }
    }

    // Fallback: GitHub "latest" (by published date).
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
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
