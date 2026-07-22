const fs = require('fs');
const file = 'chrome-extension/options/options.js';
let content = fs.readFileSync(file, 'utf8');

const targetStr1 = `    'customClientId'
  ];`;
const replaceStr1 = `    'customClientId',
    'apiMode'
  ];`;

if (content.includes(targetStr1)) {
  content = content.replace(targetStr1, replaceStr1);
}

fs.writeFileSync(file, content);
console.log("options.js patched successfully");
