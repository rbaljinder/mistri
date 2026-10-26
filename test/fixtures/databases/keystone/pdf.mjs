/**
 * A one-page PDF of plain lines: what a borrower's document downloads as in
 * /customer. Hand-written rather than a dependency because the seed needs
 * nothing more than Helvetica on a letter-size page, and the bytes must be
 * the same on every run — no creation date, no random id.
 *
 *   onePagePdf('Monthly statement', ['Loan KL-200001', 'Amount due $412.18']) → Buffer
 */
const escape = (text) =>
  String(text)
    .replace(/[\\()]/g, (ch) => `\\${ch}`)
    .replace(/[^\x20-\x7e]/g, '?');

export function onePagePdf(title, lines) {
  const body = [
    'BT',
    '/F1 10 Tf',
    '72 740 Td',
    '(KEYSTONE AUTO FINANCE) Tj',
    '/F1 18 Tf',
    '0 -30 Td',
    `(${escape(title)}) Tj`,
    '/F1 11 Tf',
    '14 TL',
    '0 -12 Td',
    ...lines.flatMap((line) => ['T*', `(${escape(line)}) Tj`]),
    '/F1 8 Tf',
    'T*',
    'T*',
    '(A synthetic document from the Keystone sample. No credit was extended.) Tj',
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
