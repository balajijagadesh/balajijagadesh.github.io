/* ---------- Helper utilities ---------- */
const $ = id => document.getElementById(id);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- Configuration: languages ---------- */
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

/* ---------- Populate language dropdowns ---------- */
function populateLanguageSelects() {
  const source = $("sourceLang");
  const target = $("targetLang");
  LANGS.forEach(lang => {
    const optS = document.createElement("option");
    optS.value = lang.code;
    optS.textContent = `${lang.name}`; // Only display name once
    source.appendChild(optS);

    const optT = document.createElement("option");
    optT.value = lang.code;
    optT.textContent = `${lang.name}`; // Only display name once
    target.appendChild(optT);
  });

  // Sticky choices
  const savedS = localStorage.getItem("wikitr_source") || "en";
  const savedT = localStorage.getItem("wikitr_target") || "ta";
  source.value = savedS;
  target.value = savedT;
}

function attachLangSaveHandlers() {
  $("sourceLang").addEventListener("change", e => {
    localStorage.setItem("wikitr_source", e.target.value);
  });
  $("targetLang").addEventListener("change", e => {
    localStorage.setItem("wikitr_target", e.target.value);
  });
}

/* ---------- Utility functions ---------- */
function stripParentheses(s) {
  return s.replace(/\s*\([^)]*\)/g, '').trim();
}
function hasParentheses(s) {
  return /\(.+\)/.test(s);
}
function setProgress(pct, text) {
  $("progressBar").style.width = `${pct}%`;
  $("progressText").textContent = text || "";
}

/* ---------- Main conversion logic ---------- */
async function convertText() {
  const inputText = $("inputBox").value;
  if (!inputText.trim()) {
    $("outputBox").textContent = "";
    return;
  }

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
      const srcUrl = `https://${sourceWiki}/w/api.php?action=query&format=json&titles=${pageTitleEnc}&prop=pageprops&redirects=1&origin=*`;
      setProgress(20 + Math.round((done/total)*50), `Querying ${sourceWiki} for "${entry.sourceTitle}"...`);
      const srcResp = await fetch(srcUrl);
      const srcJson = await srcResp.json();
      const pages = srcJson.query?.pages || {};
      const pageId = Object.keys(pages)[0];
      const page = pages[pageId];
      const wikibaseItem = page?.pageprops?.wikibase_item;

      if (!wikibaseItem) {
        mapping.set(key, {
          ...entry,
          targetTitleRaw: null,
          bracketReplacement: `[[${entry.sourceTitle}]]`,
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${encodeURIComponent(wikibaseItem)}&props=sitelinks&origin=*`;
      setProgress(40 + Math.round((done/total)*50), `Fetching Wikidata ${wikibaseItem}...`);
      const wdResp = await fetch(wdUrl);
      const wdJson = await wdResp.json();
      const ent = wdJson.entities[wikibaseItem];
      const targetTitle = ent?.sitelinks?.[targetWikiKey]?.title || null;

      if (!targetTitle) {
        mapping.set(key, {
          ...entry,
          targetTitleRaw: null,
          bracketReplacement: `[[${entry.sourceTitle}]]`,
          plainReplacement: entry.sourceTitle
        });
        done++;
        continue;
      }

      const bracketed = hasParentheses(targetTitle) ? `[[${targetTitle}|]]` : `[[${targetTitle}]]`;
      const plain = stripParentheses(targetTitle);

      mapping.set(key, {
        ...entry,
        targetTitleRaw: targetTitle,
        bracketReplacement: bracketed,
        plainReplacement: plain
      });

    } catch (err) {
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

  let output = inputText.replace(bracketRegex, (fullMatch, inner) => {
    let innerTrim = inner.trim();
    if (innerTrim.includes("|")) innerTrim = innerTrim.split("|")[0].trim();
    return mapping.get(innerTrim)?.bracketReplacement || fullMatch;
  });

  for (const [src, info] of mapping.entries()) {
    if (!info.plainReplacement) continue;
    const esc = escapeRegExp(src);
    try {
      const lookbehindSupported = (() => { try { new RegExp('(?<!a)b'); return true; } catch(e) { return false; } })();
      if (lookbehindSupported) {
        const wordRegex = new RegExp(`(?<!\\[\\[)\\b${esc}\\b(?!\\|)`, 'g');
        output = output.replace(wordRegex, info.plainReplacement);
      } else {
        const parts = [];
        let lastIndex = 0, m;
        const brRe = /\[\[[\s\S]*?\]\]/g;
        while ((m = brRe.exec(output)) !== null) {
          parts.push({ text: output.substring(lastIndex, m.index), bracket: false });
          parts.push({ text: m[0], bracket: true });
          lastIndex = m.index + m[0].length;
        }
        parts.push({ text: output.substring(lastIndex), bracket: false });
        for (let i=0;i<parts.length;i++){
          if (!parts[i].bracket) {
            const reg = new RegExp(`\\b${esc}\\b`, 'g');
            parts[i].text = parts[i].text.replace(reg, info.plainReplacement);
          }
        }
        output = parts.map(p=>p.text).join('');
      }
    } catch (err) { console.warn("Replace issue for", src, err); }
  }

  setProgress(100, "Done");
  setTimeout(()=> setProgress(0, "Idle"), 600);
  $("outputBox").textContent = output;
}

/* ---------- Setup UI ---------- */
function setupUI() {
  populateLanguageSelects();
  attachLangSaveHandlers();

  $("convertBtn").addEventListener("click", async () => {
    setProgress(5, "Starting...");
    await convertText();
  });

  // Ctrl+Enter triggers conversion
  $("inputBox").addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("convertBtn").click();
    }
  });

  // Clear input
  $("clearInputBtn").addEventListener("click", () => {
    $("inputBox").value = "";
    $("inputBox").focus();
  });

  // Clear all
  $("clearBtn").addEventListener("click", () => {
    $("inputBox").value = "";
    $("outputBox").textContent = "";
  });

  // Copy output
  $("copyBtn").addEventListener("click", async () => {
    const text = $("outputBox").textContent;
    try {
      await navigator.clipboard.writeText(text);
      const old = $("copyBtn").textContent;
      $("copyBtn").textContent = "Copied!";
      setTimeout(()=> $("copyBtn").textContent = old, 1200
