// Builds an EPUB 3 book (with an EPUB 2 table of contents for older readers)
// from the Rewrite tab's paragraphs. The book is a ZIP file; its files are
// stored without compression, which every reader accepts, so no library is
// needed. Used by sidepanel.js.

// book: { title, author, url, videoId, lang, published, track, model,
// paragraphs: [{ text }] }. Returns a Blob.
function makeEpub(book) {
  const now = new Date();
  const modified = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const id = `${book.url}#rewrite-${book.lang}`;
  const lang = book.lang || 'und';
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', epubContainer()],
    ['OEBPS/content.opf', epubOpf(book, id, lang, modified)],
    ['OEBPS/nav.xhtml', epubNav(book, lang)],
    ['OEBPS/toc.ncx', epubNcx(book, id)],
    ['OEBPS/style.css', EPUB_CSS],
    ['OEBPS/text.xhtml', epubText(book, lang, now)],
  ];
  return zipStored(files.map(([name, text]) => [name, new TextEncoder().encode(text)]), now);
}

// A file name from the title, without the characters Windows and macOS refuse.
function epubFileName(title) {
  const name = (title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${name || 'video'}.epub`;
}

const EPUB_CSS = `body { margin: 0 5%; line-height: 1.6; }
h1 { font-size: 1.5em; line-height: 1.3; margin: 1em 0 0.6em; }
.info { margin: 0 0 2em; padding: 0.6em 0.8em; border: 1px solid #ccc; border-radius: 4px; font-size: 0.85em; }
.info p { margin: 0.2em 0; text-indent: 0; }
.info .note { margin-top: 0.6em; color: #666; }
p { margin: 0 0 1em; }
`;

function epubContainer() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function epubOpf(book, id, lang, modified) {
  const optional = [
    book.author && `    <dc:creator>${xml(book.author)}</dc:creator>`,
    book.published && `    <dc:date>${xml(book.published)}</dc:date>`,
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${xml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${xml(id)}</dc:identifier>
    <dc:title>${xml(book.title)}</dc:title>
    <dc:language>${xml(lang)}</dc:language>
${optional.join('\n')}${optional.length ? '\n' : ''}    <dc:source>${xml(book.url)}</dc:source>
    <dc:publisher>YouTube</dc:publisher>
    <dc:description>${xml(aboutLines(book).join(' '))}</dc:description>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="text"/>
  </spine>
</package>
`;
}

function epubNav(book, lang) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(lang)}" lang="${xml(lang)}">
<head><meta charset="utf-8"/><title>${xml(book.title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="text.xhtml">${xml(book.title)}</a></li>
    </ol>
  </nav>
</body>
</html>
`;
}

function epubNcx(book, id) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xml(id)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xml(book.title)}</text></docTitle>
  <navMap>
    <navPoint id="text" playOrder="1">
      <navLabel><text>${xml(book.title)}</text></navLabel>
      <content src="text.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`;
}

// The title, the video's details, then the paragraphs.
function epubText(book, lang, now) {
  const info = [
    book.author && `<p>Channel: ${xml(book.author)}</p>`,
    `<p>Video: <a href="${xml(book.url)}">${xml(book.url)}</a></p>`,
    book.published && `<p>Published: ${xml(book.published)}</p>`,
    book.track && `<p>From the captions: ${xml(book.track)}</p>`,
    `<p>Made: ${now.toISOString().slice(0, 10)}</p>`,
    `<p class="note">${xml(aboutLines(book).join(' '))}</p>`,
  ].filter(Boolean);
  const paras = book.paragraphs.map((p) => `  <p>${xml(p.text)}</p>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xml(lang)}" lang="${xml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${xml(book.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${xml(book.title)}</h1>
  <div class="info">
    ${info.join('\n    ')}
  </div>
${paras.join('\n')}
</body>
</html>
`;
}

function aboutLines(book) {
  const by = book.model ? ` (${book.model})` : '';
  return [
    `The video's captions, rewritten by AI${by} as readable paragraphs, without filler words, repetition and false starts.`,
    'It may contain mistakes.',
  ];
}

// Escapes text for XML, dropping control characters XML does not allow.
function xml(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- ZIP ----------

// files: [[name, Uint8Array]], stored as they are. The first file is the
// EPUB's "mimetype", which must come first and uncompressed.
function zipStored(files, date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    locals.push(local, nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end], { type: 'application/epub+zip' });
}

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
