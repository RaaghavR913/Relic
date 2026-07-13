// ============================================================
// Build-time stub for jsPDF's optional integrations
// ------------------------------------------------------------
// jsPDF lazily `import()`s three optional packages it only needs for features
// Relic never calls: html2canvas + dompurify (doc.html()) and canvg
// (doc.addSvgAsImage()). Our export path (src/export/pdf.ts) is pure text and
// vector drawing, so without this stub Vite still emits ~376 KB of dead,
// never-loaded chunks (html2canvas.js, purify.es.js, canvg's index.es.js)
// into the CWS zip.
//
// vite.config.ts aliases all three package names here instead. jsPDF wraps
// each import() in a .catch() that surfaces "Could not load <pkg>", so if one
// of those APIs were ever called it would reject cleanly with the message
// below rather than misbehave.
//
// If Relic ever adopts doc.html() or addSvgAsImage(), delete the matching
// alias in vite.config.ts (and expect the corresponding chunk to return).
// ============================================================

throw new Error(
  'Not bundled: jsPDF optional integration (html2canvas/dompurify/canvg) — ' +
    'Relic only uses jsPDF text/vector drawing. See src/vendor/jspdf-optional-stub.ts.',
);

export {};
