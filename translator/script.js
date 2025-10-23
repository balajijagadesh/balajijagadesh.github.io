/* 
  script.js
  - Contains main logic to detect [[...]] mentions, query Wikipedia and Wikidata to find equivalent titles in the target language,
    and replace occurrences in input to produce the output HTML/ text.
  - Important: uses CORS-friendly API calls with origin=*
*/

/* ---------- Configuration: list of languages (lightweight: English + major Indian languages) ---------- */
/* Format: { code: "en", name: "English" }  — code here is the wiki code used in API (e.g., 'ta' -> 'tamil' wiki uses 'tawiki') */
const LANGS = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi - hi" },
  { code: "ta", name: "Tamil - ta" },
  { code: "te", name: "Telugu - te" },
  { code: "kn", name: "Kannada - kn" },
  { code: "ml", name: "Malayalam - ml" },
  { code: "bn", name: "Bengali - bn" },
  { code: "mr", name: "Marathi - mr" },
  { code: "gu", name: "Gujarati - gu" },
  { code: "pa", name: "Punjabi - pa" },
  { code: "or", name: "Odia - or" },
  { code: "as", name: "Assamese - as" },
  { code: "ur", name: "Urdu - ur" }
];

/* ---------- Helper utilities ---------- */
const $ = id => document.getElementById(id);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Remove parentheses and their contents, e.g. "பாலா (இயக்குநர்)" -> "பாலா" */
function stripParentheses(s) {
  return s.replace(/\s*\([^)]*\)/g, '').trim();
}

/* Check if a string contains parentheses */
function hasParentheses(s) {
  return /\(.+\)/.test(s);
}

/* Simple helper to update progress bar and text */
function setProgress(pct, text) {
  const bar = $("progressBar");
  const t = $("progressText");
  bar.style.width = `${pct}%`;
  t.textContent = text || "";
}

/* ---------- Populate language dropdowns and restore sticky selections ---------- */
function populateLanguageSelects() {
  const source = $("sourceLang");
  const target = $("targetLang");
  LANGS.forEach(lang => {
    const optS = document.createElement("option");
    optS.value = lang.code;
    optS.textContent = lang.name + (lang.code ? ` - ${lang.code}` : "");
    source.appendChild(optS);

    const optT = document.createElement("option");
    optT.value = lang.code;
    optT.textContent = lang.name + (lang.code ? ` - ${lang.code}` : "");
    target.appendChild(optT);
  });

  // Sticky choices (localStorage)
  const savedS = localStorage.getItem("wikitr_source") || "en";
  const savedT = localStorage.getItem("wikitr_target") || "ta";
  source.value = savedS;
  target.value = savedT;
}

/* Save after user changes */
function attachLangSaveHandlers() {
  $("sourceLang").addEventListener("change", (e) => {
    localStorage.setItem("wikitr_source", e.target.value);
  });
  $("targetLang").addEventListener("change", (e) => {
    localStorage.setItem("wikitr_target", e.target.value);
  });
}

/* ---------- Main conversion flow ---------- */

/*
 Steps for each bracketed reference:
 1. Extract inner text, strip anything after a pipe '|'
 2. Query the source wiki to get pageprops.wikibase_item (the Wikidata Q-id)
 3. Using Wikidata, get sitelink for target wiki (e.g., 'tawiki') and retrieve title
 4. Build replacement:
    - For bracketed: if title has parentheses, use [[title|]] else [[title]]
    - For plain text replacements outside brackets: use title with parentheses stripped
 5. Replace all bracketed occurrences first, then replace bare occurrences of the source title (word-boundary style)
*/

async function convertText() {
  const inputText = $("inputBox").value;
  if (!inputText.trim()) {
    $("outputBox").textContent = "";
    return;
  }

  const sourceCode = $("sourceLang").value;   // e.g., "en"
  const targetCode = $("targetLang").value;   // e.g., "ta"
  const sourceWiki = `${sourceCode}.wikipedia.org`;
  const targetWikiKey = `${targetCode}wiki`;  // sitelink key in Wikidata, e.g., 'tawiki'

  // Find all bracketed occurrences [[...]]
  const bracketRegex = /\[\[([\s\S]*?)\]\]/g;
  const matches = [...inputText.matchAll(bracketRegex)];

  // If none, still we may want to replace bare occurrences? According to your spec, replacements are anchored to bracketed references
  if (!matches.length) {
    // Nothing to query — just copy input to output
    $("outputBox").textContent = inputText;
    return;
  }

  // Map from originalSource -> { sourceTitle, targetTitleRaw, bracketReplacement, plainReplacement }
  const mapping = new Map();

  // Progress tracking
  setProgress(10, "Preparing queries...");

  // Iterate matches and build unique list of source titles to resolve
  for (const m of matches) {
    let raw = m[1].trim();        // inside [[ ... ]]
    // If there's a pipe, strip anything after first '|'
    if (raw.includes("|")) {
      raw = raw.split("|")[0].trim();
    }
    // Use the original raw text as key (case-sensitive)
    if (!mapping.has(raw)) {
      mapping.set(raw, { sourceTitle: raw }); // we'll fill other fields later
    }
  }

  // Resolve each source title -> wikidata Qid -> target title
  const keys = Array.from(mapping.keys());
  const total = keys.length;
  let done = 0;
  setProgress(20, `Resolving ${total} item(s)...`);

  for (const key of keys) {
    const entry = mapping.get(key);
    try {
      // 1) Query source wiki for the page and its pageprops (wikibase_item)
      // Using CORS-friendly 'origin=*'
      const pageTitleEnc = encodeURIComponent(entry.sourceTitle);
      const srcUrl = `https://${sourceWiki}/w/api.php?action=query&format=json&titles=${pageTitleEnc}&prop=pageprops&redirects=1&origin=*`;

      setProgress(20 + Math.round((done/total)*50), `Querying ${sourceWiki} for "${entry.sourceTitle}"...`);
      const srcResp = await fetch(srcUrl);
      const srcJson = await srcResp.json();

      // Find the page object
      const pages = srcJson.query && srcJson.query.pages ? srcJson.query.pages : {};
      const pageId = Object.keys(pages)[0];
      const page = pages[pageId];

      let wikibaseItem = null;
      if (page && page.pageprops && page.pageprops.wikibase_item) {
        wikibaseItem = page.pageprops.wikibase_item;
      } else {
        // No Wikidata item found; we won't translate this one
        mapping.set(key, {
          ...entry,
          targetTitleRaw: null,
          bracketReplacement: `[[${entry.sourceTitle}]]`, // fallback: keep original bracket
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      // 2) Query Wikidata for sitelinks to get the target wiki title
      const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${encodeURIComponent(wikibaseItem)}&props=sitelinks&origin=*`;
      setProgress(40 + Math.round((done/total)*50), `Fetching Wikidata ${wikibaseItem}...`);
      const wdResp = await fetch(wdUrl);
      const wdJson = await wdResp.json();

      const entities = wdJson.entities || {};
      const ent = entities[wikibaseItem];
      let targetTitle = null;
      if (ent && ent.sitelinks && ent.sitelinks[targetWikiKey] && ent.sitelinks[targetWikiKey].title) {
        targetTitle = ent.sitelinks[targetWikiKey].title;
      } else {
        // no sitelink found for target
        mapping.set(key, {
          ...entry,
          targetTitleRaw: null,
          bracketReplacement: `[[${entry.sourceTitle}]]`, // fallback
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      // Build bracket replacement and plain replacement
      // If title has parentheses, for bracketed form add a pipe before closing brackets: [[title (..) | ]]
      let bracketed;
      if (hasParentheses(targetTitle)) {
        bracketed = `[[${targetTitle}|]]`;
      } else {
        bracketed = `[[${targetTitle}]]`;
      }

      const plain = stripParentheses(targetTitle);

      mapping.set(key, {
        ...entry,
        targetTitleRaw: targetTitle,
        bracketReplacement: bracketed,
        plainReplacement: plain
      });

    } catch (err) {
      // On error, fallback to original
      mapping.set(key, {
        ...entry,
        targetTitleRaw: null,
        bracketReplacement: `[[${entry.sourceTitle}]]`,
        plainReplacement: entry.sourceTitle
      });
      console.error("Error resolving", key, err);
    } finally {
      done++;
      setProgress(70 + Math.round((done/total)*20), `Resolved ${done}/${total}`);
    }
  }

  setProgress(90, "Composing output...");

  // Create output: start from input and replace bracketed occurrences with bracketReplacement
  // Use a replacer function to ensure we don't double-replace inside processed areas
  let output = inputText;

  // First, replace each bracketed instance (global)
  output = output.replace(bracketRegex, (fullMatch, inner) => {
    let innerTrim = inner.trim();
    if (innerTrim.includes("|")) innerTrim = innerTrim.split("|")[0].trim();
    const map = mapping.get(innerTrim);
    if (map && map.bracketReplacement) return map.bracketReplacement;
    // fallback: return original match
    return fullMatch;
  });

  // Next, replace bare occurrences of the source title in the text (outside [[]])
  // For each mapping entry, replace occurrences of the sourceTitle with the plainReplacement
  // We try to match word boundaries — but titles can have Unicode and punctuation, so we do a safe regexp:
  for (const [src, info] of mapping.entries()) {
    if (!info.plainReplacement) continue;
    // Escape for regex
    const esc = escapeRegExp(src);
    // Only replace occurrences not already inside [[...]] — simplest approach: temporarily replace bracketed forms with placeholders
    // To keep it simpler: do global replacement but avoid touching bracketed forms by skipping matches that are within [[...]]
    // We'll use a regex that matches src only when not immediately preceded by '[['
    // Negative lookbehind for '[[': (?<!\[\[)
    // However JS supports variable-length lookbehind in modern engines; we assume modern browsers.
    // As fallback (if lookbehind unsupported), we'll do a safer approach: process tokens.
    try {
      const lookbehindSupported = (() => {
        try { new RegExp('(?<!a)b'); return true; } catch(e) { return false; }
      })();

      if (lookbehindSupported) {
        const wordRegex = new RegExp(`(?<!\\[\\[)\\b${esc}\\b(?!\\|)`, 'g');
        output = output.replace(wordRegex, info.plainReplacement);
      } else {
        /* Fallback: tokenise by bracketed segments to avoid replacing inside them.
           We split the string on bracketed segments, replace in the non-bracket parts, then recombine. */
        const parts = [];
        let lastIndex = 0;
        let m;
        const brRe = /\[\[[\s\S]*?\]\]/g;
        while ((m = brRe.exec(output)) !== null) {
          // text before bracket
          const before = output.substring(lastIndex, m.index);
          parts.push({ text: before, bracket: false });
          parts.push({ text: m[0], bracket: true });
          lastIndex = m.index + m[0].length;
        }
        // trailing
        parts.push({ text: output.substring(lastIndex), bracket: false });
        for (let i=0;i<parts.length;i++){
          if (!parts[i].bracket) {
            const reg = new RegExp(`\\b${esc}\\b`, 'g');
            parts[i].text = parts[i].text.replace(reg, info.plainReplacement);
          }
        }
        output = parts.map(p => p.text).join('');
      }

    } catch (err) {
      console.warn("Replace issue for", src, err);
    }
  }

  // Clean up progress
  setProgress(100, "Done");
  setTimeout(() => setProgress(0, "Idle"), 600);

  // Place final output into outputBox (editable)
  const outBox = $("outputBox");
  // We set as textContent so that literal brackets are preserved (not interpreted as HTML)
  outBox.textContent = output;
}

/* ---------- Setup event listeners ---------- */
function setupUI() {
  populateLanguageSelects();
  attachLangSaveHandlers();

  $("convertBtn").addEventListener("click", async () => {
    setProgress(5, "Starting...");
    await convertText();
  });

  // Allow pressing Ctrl+Enter to convert
  $("inputBox").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("convertBtn").click();
    }
  });

  $("clearBtn").addEventListener("click", () => {
    $("inputBox").value = "";
    $("outputBox").textContent = "";
  });

  $("copyBtn").addEventListener("click", async () => {
    const text = $("outputBox").textContent;
    try {
      await navigator.clipboard.writeText(text);
      // brief UI cue
      const old = $("copyBtn").textContent;
      $("copyBtn").textContent = "Copied!";
      setTimeout(()=> $("copyBtn").textContent = old, 1200);
    } catch (err) {
      alert("Unable to copy. Please select the text and copy manually.");
    }
  });
}

/* ---------- Initialization ---------- */
document.addEventListener("DOMContentLoaded", () => {
  setupUI();
  // small default demo
  const sample = `[[India]] is a big country. I like India.
[[Bala (actor)|Bala]] did many films.
Also test: [[India|Indian subcontinent]]`;
  $("inputBox").value = sample;
});
