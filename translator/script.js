const $ = id => document.getElementById(id);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LANGS = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "bn", name: "Bengali" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "pa", name: "Punjabi" },
  { code: "or", name: "Odia" },
  { code: "as", name: "Assamese" },
  { code: "ur", name: "Urdu" }
];

/* =======================
   NEW STATE (non-breaking)
   ======================= */
let lastInputLinks = [];
let untranslatedHidden = false;

/* =======================
   EXISTING FUNCTIONS
   ======================= */

function populateLanguageSelects() {
  const source = $("sourceLang");
  const target = $("targetLang");
  LANGS.forEach(lang => {
    const optS = document.createElement("option");
    optS.value = lang.code;
    optS.textContent = lang.name;
    source.appendChild(optS);

    const optT = document.createElement("option");
    optT.value = lang.code;
    optT.textContent = lang.name;
    target.appendChild(optT);
  });

  const savedS = localStorage.getItem("wikitr_source") || "en";
  const savedT = localStorage.getItem("wikitr_target") || "ta";
  source.value = savedS;
  target.value = savedT;
}

function attachLangSaveHandlers() {
  $("sourceLang").addEventListener("change", e =>
    localStorage.setItem("wikitr_source", e.target.value)
  );
  $("targetLang").addEventListener("change", e =>
    localStorage.setItem("wikitr_target", e.target.value)
  );
}

function setProgress(pct, text) {
  $("progressBar").style.width = `${pct}%`;
  $("progressText").textContent = text || "";
}

function stripParentheses(s) {
  return s.replace(/\s*\([^)]*\)/g, '').trim();
}

function hasParentheses(s) {
  return /\(.+\)/.test(s);
}

/* =======================
   NEW HELPER (SAFE)
   ======================= */
function extractWikiLinks(text) {
  const links = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let raw = m[1].trim();
    if (raw.includes("|")) raw = raw.split("|")[0].trim();
    links.push(stripParentheses(raw));
  }
  return links;
}

/* =======================
   MAIN CONVERT FUNCTION
   ======================= */
async function convertText() {
  const inputText = $("inputBox").value;
  if (!inputText.trim()) {
    $("outputBox").textContent = "";
    return;
  }

  /* capture input state for toggle logic */
  lastInputLinks = extractWikiLinks(inputText);
  untranslatedHidden = false;
  $("toggleUntranslatedBtn").textContent = "Hide untranslated links";

  const sourceCode = $("sourceLang").value;
  const targetCode = $("targetLang").value;
  const sourceWiki = `${sourceCode}.wikipedia.org`;
  const targetWikiKey = `${targetCode}wiki`;

  const bracketRegex = /\[\[([\s\S]*?)\]\]/g;
  const matches = [...inputText.matchAll(bracketRegex)];
  if (!matches.length) {
    $("outputBox").textContent = inputText;
    return;
  }

  const mapping = new Map();
  setProgress(10, "Preparing queries...");

  for (const m of matches) {
    let raw = m[1].trim();
    if (raw.includes("|")) raw = raw.split("|")[0].trim();
    if (!mapping.has(raw)) mapping.set(raw, { sourceTitle: raw });
  }

  const keys = Array.from(mapping.keys());
  const total = keys.length;
  let done = 0;

  setProgress(20, `Resolving ${total} item(s)...`);

  for (const key of keys) {
    const entry = mapping.get(key);
    try {
      const pageTitleEnc = encodeURIComponent(entry.sourceTitle);
      const srcResp = await fetch(
        `https://${sourceWiki}/w/api.php?action=query&format=json&titles=${pageTitleEnc}&prop=pageprops&redirects=1&origin=*`
      );
      const srcJson = await srcResp.json();
      const pages = srcJson.query?.pages || {};
      const page = pages[Object.keys(pages)[0]];
      const wikibaseItem = page?.pageprops?.wikibase_item || null;

      if (!wikibaseItem) {
        mapping.set(key, {
          ...entry,
          bracketReplacement: `[[${entry.sourceTitle}]]`,
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      const wdResp = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${wikibaseItem}&props=sitelinks&origin=*`
      );
      const wdJson = await wdResp.json();
      const targetTitle =
        wdJson.entities[wikibaseItem]?.sitelinks?.[targetWikiKey]?.title || null;

      if (!targetTitle) {
        mapping.set(key, {
          ...entry,
          bracketReplacement: `[[${entry.sourceTitle}]]`,
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      const bracketed = hasParentheses(targetTitle)
        ? `[[${targetTitle}|]]`
        : `[[${targetTitle}]]`;

      mapping.set(key, {
        ...entry,
        bracketReplacement: bracketed,
        plainReplacement: stripParentheses(targetTitle)
      });

    } catch (e) {
      console.error(e);
    } finally {
      done++;
      setProgress(70 + Math.round((done / total) * 20),
        `Resolved ${done}/${total}`);
    }
  }

  setProgress(90, "Composing output...");

  let output = inputText.replace(bracketRegex, (full, inner) => {
    let innerTrim = inner.trim();
    if (innerTrim.includes("|")) innerTrim = innerTrim.split("|")[0].trim();
    return mapping.get(innerTrim)?.bracketReplacement || full;
  });

  for (const [src, info] of mapping.entries()) {
    const esc = escapeRegExp(stripParentheses(src));
    output = output.replace(
      new RegExp(`\\b${esc}\\b`, 'gi'),
      info.plainReplacement
    );
  }

  setProgress(100, "Done");
  setTimeout(() => setProgress(0, "Idle"), 600);
  $("outputBox").textContent = output;
}

/* =======================
   NEW TOGGLE FUNCTION
   ======================= */
function toggleUntranslatedLinks() {
  const outBox = $("outputBox");
  let text = outBox.textContent;
  const outputLinks = extractWikiLinks(text);

  if (!untranslatedHidden) {
    text = text.replace(/\[\[([\s\S]*?)\]\]/g, (full, inner) => {
      let clean = inner.split("|")[0].trim();
      clean = stripParentheses(clean);
      return lastInputLinks.includes(clean) ? "" : full;
    });
    untranslatedHidden = true;
    $("toggleUntranslatedBtn").textContent = "Show untranslated links";
  } else {
    convertText();
    return;
  }

  outBox.textContent = text;
}

/* =======================
   UI SETUP
   ======================= */
function setupUI() {
  populateLanguageSelects();
  attachLangSaveHandlers();

  $("convertBtn").addEventListener("click", convertText);
  $("toggleUntranslatedBtn").addEventListener(
    "click",
    toggleUntranslatedLinks
  );

  $("copyBtn").addEventListener(async () => {
    await navigator.clipboard.writeText($("outputBox").textContent);
  });
}

document.addEventListener("DOMContentLoaded", setupUI);
