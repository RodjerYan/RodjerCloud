const heicConvert = require('heic-convert');
const fs = require('fs');

async function run() {
    try {
        // Create a dummy JPG file
        fs.writeFileSync('dummy.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]));
        const inputBuffer = fs.readFileSync('dummy.jpg');
        const outputBuffer = await heicConvert({
            buffer: inputBuffer,
            format: 'JPEG',
            quality: 0.8
        });
        console.log('Success!');
    } catch (e) {
        console.error('Failed:', e.message);
    }
}
run();
