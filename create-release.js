const fs = require('fs');
const https = require('https');
const path = require('path');

const token = "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";
const repo = "RodjerYan/RodjerCloud";
const version = "v1.0.55";

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(data || '{}'));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function createRelease() {
    console.log("Creating release...");
    const releaseData = {
        tag_name: version,
        name: version,
        body: "v1.0.55 - Fix API ID",
        draft: false,
        prerelease: false
    };

    const options = {
        hostname: 'api.github.com',
        port: 443,
        path: `/repos/${repo}/releases`,
        method: 'POST',
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Node.js',
            'Accept': 'application/vnd.github.v3+json'
        }
    };

    try {
        const release = await request(options, releaseData);
        console.log("Release created with ID:", release.id);
        return release.id;
    } catch (e) {
        if (e.message.includes('already_exists')) {
            console.log("Release already exists. Fetching existing release...");
            const getOptions = {
                hostname: 'api.github.com',
                port: 443,
                path: `/repos/${repo}/releases/tags/${version}`,
                method: 'GET',
                headers: {
                    'Authorization': `token ${token}`,
                    'User-Agent': 'Node.js',
                    'Accept': 'application/vnd.github.v3+json'
                }
            };
            const existingRelease = await request(getOptions);
            return existingRelease.id;
        }
        throw e;
    }
}

function uploadAsset(releaseId, filename) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(__dirname, 'dist', filename);
        if (!fs.existsSync(filePath)) {
            console.error(`File ${filePath} not found!`);
            return resolve();
        }
        const stats = fs.statSync(filePath);
        console.log(`Uploading ${filename}... (${stats.size} bytes)`);

        const options = {
            hostname: 'uploads.github.com',
            port: 443,
            path: `/repos/${repo}/releases/${releaseId}/assets?name=${filename}`,
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': stats.size,
                'User-Agent': 'Node.js',
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`Successfully uploaded ${filename}`);
                    resolve();
                } else {
                    if (body.includes("already_exists")) {
                        console.log(`File ${filename} already exists on GitHub.`);
                        resolve();
                    } else {
                        console.error(`Error uploading ${filename}: HTTP ${res.statusCode}`, body);
                        reject(new Error(`Upload failed for ${filename}`));
                    }
                }
            });
        });

        req.on('error', reject);

        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(req);
    });
}

async function run() {
    try {
        const releaseId = await createRelease();
        await uploadAsset(releaseId, 'RodjerCloud-1.0.55.exe');
        await uploadAsset(releaseId, 'RodjerCloud-1.0.55.exe.blockmap');
        await uploadAsset(releaseId, 'latest.yml');
        console.log("All assets uploaded.");
    } catch (e) {
        console.error("Script failed:", e);
    }
}

run();
