// PCS startlist parser – shared source for index.html and Code.gs (kept here for tests).
// Handles the "one long line" PCS copy:  "1 Team Jayco AlUla 1. DOUBLE Paul 2. DE BONDT Dries ... DS: DE MARCHI Alessandro 2 Alpecin - Premier Tech 11. BAYER Tobias ..."
// and the multi-line variants ("1. DOUBLE Paul" or "1 DOUBLE Paul" per line, team names on their own lines).
function parsePcsStartlist(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  var out = [];
  // rider token: "<bib>. NAME Firstname" up to next "<bib>." / "DS:" / end
  var re = /(\d{1,3})\.\s*([^\d]+?)(?=\s*(?:\d{1,3}\.\s*[^\d]|DS:|$))/g;
  var m, prevEnd = 0, team = '', n = 0;
  while ((m = re.exec(t)) !== null) {
    var gap = t.slice(prevEnd, m.index).trim();
    if (gap) {
      // gap looks like "DS: X Y 2 Alpecin - Premier Tech" or (first) "1 Team Jayco AlUla"
      var g = gap.replace(/^[\s\S]*?DS:\s*/, '');
      var tm = g.match(/^(?:.*?\s)?(\d{1,2})\s+(.+)$/);
      if (tm) team = tm[2].trim();
      else if (!/DS:/.test(gap)) team = g.trim();
    }
    var name = m[2].replace(/\s+(DNS|DNF|OTL|DSQ)$/i, '').trim();
    if (/[A-ZÀ-Ž]{2,}/.test(name) && name.length > 3) { out.push({ name: name, team: team }); n++; }
    prevEnd = m.index + m[0].length;
  }
  return out;
}
if (typeof module !== 'undefined') module.exports = { parsePcsStartlist: parsePcsStartlist };
