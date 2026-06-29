const bytenode = require('bytenode');
const fs = require('fs');
const path = require('path');

const jsFile = path.join(process.cwd(), 'dist-electron/main/index.js');
const jscFile = path.join(process.cwd(), 'dist-electron/main/index.jsc');

console.log('=== TIẾN TRÌNH BIÊN DỊCH BYTENODE ===');
console.log(`Đang biên dịch: ${jsFile}`);

try {
  // Biên dịch file index.js thành index.jsc
  bytenode.compileFile({
    filename: jsFile,
    output: jscFile
  });
  
  console.log(`Biên dịch thành công bytecode: ${jscFile}`);
  
  // Ghi đè file index.js bằng mã loader
  const loaderContent = `"use strict";\nrequire("bytenode");\nrequire("./index.jsc");\n`;
  fs.writeFileSync(jsFile, loaderContent, 'utf-8');
  console.log('Đã cập nhật file loader index.js');
  console.log('=== HOÀN TẤT BIÊN DỊCH BYTENODE ===');
} catch (error) {
  console.error('Lỗi biên dịch bytecode bằng Bytenode:', error);
  process.exit(1);
}
