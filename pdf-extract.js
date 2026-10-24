// PDF text extraction using pdf.js
var pdfjsLib = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('./pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';
  return pdfjsLib;
}

async function extractPdfText(file) {
  var lib = await loadPdfJs();
  var arrayBuffer = await file.arrayBuffer();
  var pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  var pages = [];
  for (var i = 1; i <= pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    var content = await page.getTextContent();
    // Keep the PDF's lines: a new line starts wherever the text moves to another baseline
    var text = '', lastY = null;
    content.items.forEach(function(item) {
      if (!item.str) return;
      var y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text) text += ' ';
      text += item.str;
      lastY = y;
    });
    pages.push(text);
  }
  return pages.join('\n\n--- Page Break ---\n\n');
}

async function extractFileText(file) {
  var name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    return await extractPdfText(file);
  }
  // Plain text files
  return await file.text();
}

window.extractFileText = extractFileText;
