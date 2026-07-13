const fs = require('fs');
const https = require('https');
const path = require('path');

const token = "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";
const releaseId = 353354994;

function uploadFile(filename) {
    const filePath = path.join(__dirname, 'dist', filename);
    const stats = fs.statSync(filePath);
    
    console.log(`Uploading ${filename}... (${stats.size} bytes)`);

    const options = {
        hostname: 'uploads.github.com',
        port: 443,
        path: `/repos/RodjerYan/RodjerCloud/releases/${releaseId}/assets?name=${filename}`,
        method: 'POST',
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': stats.size,
            'User-Agent': 'Node.js'
        }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            console.log(`Response for ${filename}:`, res.statusCode);
            if (res.statusCode > 201) console.log(body);
        });
    });

    req.on('error', (e) => {
        console.error(`Error uploading ${filename}:`, e);
    });

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(req);
}

uploadFile('RodjerCloud-1.0.34-arm64.dmg');
uploadFile('RodjerCloud-1.0.34-arm64-mac.zip');
