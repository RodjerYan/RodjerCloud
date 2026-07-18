const fs = require('fs');
let code = fs.readFileSync('electron/main/index.ts', 'utf8');
code = code.replace("if (isVideo && !nextFile.isEncrypted) {", "if (isVideo) {");
fs.writeFileSync('electron/main/index.ts', code);
